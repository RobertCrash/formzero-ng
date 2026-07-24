import { requireAuth } from "~/lib/require-auth.server"
import type { Route } from "./+types/settings.notifications"
import { data } from "react-router"
import {
  deleteSecret,
  putSecret,
} from "~/lib/secrets/secret-store.server"

export async function loader({ context, request }: Route.LoaderArgs) {
  const database = context.cloudflare.env.DB

  await requireAuth(request, database)

  const settings = await database
    .prepare(`
      SELECT
        id,
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
  })
}

export async function action({ request, context }: Route.ActionArgs) {
  const database = context.cloudflare.env.DB
  const encryptionKey = (
    context.cloudflare.env as Env & { FORMZERO_ENCRYPTION_KEY?: string }
  ).FORMZERO_ENCRYPTION_KEY

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
    // Parse form data
    const formData = await request.formData()
    const notification_email = formData.get("notification_email") as string
    const notification_email_password = formData.get("notification_email_password") as string
    const smtp_host = formData.get("smtp_host") as string
    const smtp_port = formData.get("smtp_port") as string
    const smtp_secure = formData.get("smtp_secure") === "1" ? 1 : 0
    const parsedPort = Number.parseInt(smtp_port, 10)

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

    // Check if global settings already exist
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
      .first<{ id: string; smtp_secret_id: string | null; has_password: number }>()

    const updatedAt = Date.now()
    let smtpSecretId = existingSettings?.smtp_secret_id ?? null
    if (notification_email_password) {
      if (!encryptionKey) {
        return data(
          {
            success: false,
            error: "FORMZERO_ENCRYPTION_KEY is required to save SMTP credentials",
          },
          { status: 503 }
        )
      }
      smtpSecretId = await putSecret({
        db: database,
        encryptionKey,
        formId: null,
        purpose: "smtp_password",
        value: notification_email_password,
        secretId: smtpSecretId ?? undefined,
      })
    }

    if (existingSettings) {
      if (!notification_email_password && !existingSettings.has_password) {
        return data(
          { success: false, error: "SMTP password is required" },
          { status: 400 }
        )
      }

      await database.prepare(`
        UPDATE settings
        SET notification_email = ?,
            smtp_host = ?,
            smtp_port = ?,
            smtp_secure = ?,
            smtp_secret_id = ?,
            notification_email_password = NULL,
            updated_at = ?
        WHERE id = 'global'
      `)
        .bind(
          notification_email,
          smtp_host,
          parsedPort,
          smtp_secure,
          smtpSecretId,
          updatedAt
        )
        .run()
    } else {
      if (!notification_email_password) {
        return data(
          { success: false, error: "SMTP password is required" },
          { status: 400 }
        )
      }

      // Create new global settings
      await database
        .prepare(`
          INSERT INTO settings (
            id,
            notification_email,
            smtp_host,
            smtp_port,
            smtp_secure,
            smtp_secret_id,
            updated_at
          ) VALUES ('global', ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          notification_email,
          smtp_host,
          parsedPort,
          smtp_secure,
          smtpSecretId,
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
