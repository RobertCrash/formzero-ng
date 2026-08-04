import { requireAuth } from "~/lib/require-auth.server"
import type { Route } from "./+types/settings.notifications"
import { data } from "react-router"
import {
  deleteSecret,
  putSecret,
} from "~/lib/secrets/secret-store.server"
import { normalizeTransport } from "~/lib/email/transport.server"
import type { EmailTransportKind } from "~/lib/email/message"

const ENCRYPTION_KEY_HELP =
  "Custom SMTP stores the password encrypted, which needs FORMZERO_ENCRYPTION_KEY. " +
  "Set it with `openssl rand -hex 32 | npx wrangler secret put FORMZERO_ENCRYPTION_KEY` " +
  "(or add it to .dev.vars locally), or use the Cloudflare Email Service transport, " +
  "which stores no credentials."

function isEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const database = context.cloudflare.env.DB

  await requireAuth(request, database)

  const settings = await database
    .prepare(`
      SELECT
        id,
        email_transport,
        email_from_address,
        email_from_name,
        notification_email,
        smtp_host,
        smtp_port,
        smtp_secure,
        updated_at,
        (
          smtp_secret_id IS NOT NULL OR
          notification_email_password IS NOT NULL
        ) AS has_password
      FROM settings
      WHERE id = 'global'
    `)
    .first()

  return data({
    settings: settings || null,
    credentialEncryption: Boolean(
      context.cloudflare.env.FORMZERO_ENCRYPTION_KEY
    ),
  })
}

export async function action({ request, context }: Route.ActionArgs) {
  const database = context.cloudflare.env.DB
  const encryptionKey = context.cloudflare.env.FORMZERO_ENCRYPTION_KEY

  await requireAuth(request, database)

  // Handle DELETE request - clear settings
  if (request.method === "DELETE") {
    try {
      const existing = await database
        .prepare("SELECT smtp_secret_id FROM settings WHERE id = 'global'")
        .first<{ smtp_secret_id: string | null }>()
      await database
        .prepare("DELETE FROM settings WHERE id = 'global'")
        .run()
      if (existing?.smtp_secret_id) {
        await deleteSecret(database, existing.smtp_secret_id)
      }

      return data({ success: true }, { status: 200 })
    } catch (error) {
      console.error("Error clearing settings:", error)
      return data(
        { success: false, error: "Failed to clear settings" },
        { status: 500 }
      )
    }
  }

  // Handle POST request - save settings
  if (request.method !== "POST") {
    return data(
      { success: false, error: "Method not allowed" },
      { status: 405 }
    )
  }

  try {
    const formData = await request.formData()
    const transport: EmailTransportKind = normalizeTransport(
      formData.get("email_transport") as string | null
    )
    const fromName = String(formData.get("email_from_name") ?? "").trim()
    let fromAddress = String(formData.get("email_from_address") ?? "").trim()

    const existingSettings = await database
      .prepare(`
        SELECT
          id,
          smtp_secret_id,
          (
            smtp_secret_id IS NOT NULL OR
            notification_email_password IS NOT NULL
          ) AS has_password
        FROM settings
        WHERE id = 'global'
      `)
      .first<{
        id: string
        smtp_secret_id: string | null
        has_password: number
      }>()

    const updatedAt = Date.now()

    // Only the SMTP transport needs a host, a port, and credentials. Requiring
    // them for every save is what made the Cloudflare transport unreachable.
    if (transport === "cloudflare") {
      if (!fromAddress || !isEmailAddress(fromAddress)) {
        return data(
          {
            success: false,
            error:
              "Enter the sender address. Cloudflare Email Service requires a " +
              "sender on a domain you onboarded with `npx wrangler email sending enable <domain>`.",
          },
          { status: 400 }
        )
      }

      if (existingSettings) {
        await database
          .prepare(`
            UPDATE settings
            SET email_transport = 'cloudflare',
                email_from_address = ?,
                email_from_name = ?,
                updated_at = ?
            WHERE id = 'global'
          `)
          .bind(fromAddress, fromName || null, updatedAt)
          .run()
      } else {
        await database
          .prepare(`
            INSERT INTO settings (
              id, email_transport, email_from_address, email_from_name, updated_at
            ) VALUES ('global', 'cloudflare', ?, ?, ?)
          `)
          .bind(fromAddress, fromName || null, updatedAt)
          .run()
      }

      return data({ success: true }, { status: 200 })
    }

    const notification_email = String(
      formData.get("notification_email") ?? ""
    ).trim()
    const notification_email_password = formData.get(
      "notification_email_password"
    ) as string
    const smtp_host = String(formData.get("smtp_host") ?? "").trim()
    const smtp_secure = formData.get("smtp_secure") === "1" ? 1 : 0
    const parsedPort = Number.parseInt(
      String(formData.get("smtp_port") ?? ""),
      10
    )

    if (
      !notification_email ||
      !smtp_host ||
      !Number.isInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535
    ) {
      return data(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      )
    }
    if (!fromAddress) fromAddress = notification_email

    if (!notification_email_password && !existingSettings?.has_password) {
      return data(
        { success: false, error: "SMTP password is required" },
        { status: 400 }
      )
    }

    let newSecretId: string | null = null
    if (notification_email_password) {
      if (!encryptionKey) {
        return data(
          {
            success: false,
            error: `FORMZERO_ENCRYPTION_KEY is required to save SMTP credentials. ${ENCRYPTION_KEY_HELP}`,
          },
          { status: 503 }
        )
      }
      newSecretId = await putSecret({
        db: database,
        encryptionKey,
        formId: null,
        purpose: "smtp_password",
        value: notification_email_password,
        secretId: existingSettings?.smtp_secret_id ?? undefined,
      })
    }

    if (existingSettings) {
      // Never clear both credential columns unless a new secret was written in
      // this request. A legacy row keeps its password in
      // notification_email_password with smtp_secret_id still NULL, so blindly
      // writing `smtp_secret_id = NULL, notification_email_password = NULL`
      // destroyed the credential and still reported success.
      const credentialColumns = newSecretId
        ? "smtp_secret_id = ?, notification_email_password = NULL,"
        : ""
      const statement = database.prepare(`
        UPDATE settings
        SET email_transport = 'smtp',
            email_from_address = ?,
            email_from_name = ?,
            notification_email = ?,
            smtp_host = ?,
            smtp_port = ?,
            smtp_secure = ?,
            ${credentialColumns}
            updated_at = ?
        WHERE id = 'global'
      `)
      const values: unknown[] = [
        fromAddress,
        fromName || null,
        notification_email,
        smtp_host,
        parsedPort,
        smtp_secure,
      ]
      if (newSecretId) values.push(newSecretId)
      values.push(updatedAt)
      await statement.bind(...values).run()
    } else {
      await database
        .prepare(`
          INSERT INTO settings (
            id,
            email_transport,
            email_from_address,
            email_from_name,
            notification_email,
            smtp_host,
            smtp_port,
            smtp_secure,
            smtp_secret_id,
            updated_at
          ) VALUES ('global', 'smtp', ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          fromAddress,
          fromName || null,
          notification_email,
          smtp_host,
          parsedPort,
          smtp_secure,
          newSecretId,
          updatedAt
        )
        .run()
    }

    return data({ success: true }, { status: 200 })
  } catch (error) {
    console.error("Error saving settings:", error)
    return data(
      { success: false, error: "Failed to save settings" },
      { status: 500 }
    )
  }
}
