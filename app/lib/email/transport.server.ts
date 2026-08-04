import { loadSmtpConfig } from "../delivery/smtp-config.server"
import type { EmailSender, EmailTransport, EmailTransportKind } from "./message"
import { createCloudflareTransport } from "./send-cloudflare.server"
import { createSmtpTransport } from "./send-smtp.server"

export type EmailSettings = {
  transport: EmailTransportKind
  fromAddress: string | null
  fromName: string | null
  /** SMTP username. Also the recipient of the settings test email. */
  notificationEmail: string | null
  hasSmtpHost: boolean
}

type EmailSettingsRow = {
  email_transport: string | null
  email_from_address: string | null
  email_from_name: string | null
  notification_email: string | null
  smtp_host: string | null
}

export function normalizeTransport(value: string | null): EmailTransportKind {
  return value === "smtp" ? "smtp" : "cloudflare"
}

export async function loadEmailSettings(
  db: D1Database
): Promise<EmailSettings | null> {
  const row = await db
    .prepare(`
      SELECT
        email_transport,
        email_from_address,
        email_from_name,
        notification_email,
        smtp_host
      FROM settings
      WHERE id = 'global'
    `)
    .first<EmailSettingsRow>()
  if (!row) return null

  return {
    transport: normalizeTransport(row.email_transport),
    fromAddress: row.email_from_address,
    fromName: row.email_from_name,
    notificationEmail: row.notification_email,
    hasSmtpHost: Boolean(row.smtp_host),
  }
}

type TransportEnv = {
  EMAIL: SendEmail
  FORMZERO_ENCRYPTION_KEY?: string
}

/**
 * Builds the transport the stored settings describe, or returns null when email
 * cannot be sent at all.
 *
 * Selection is driven by `settings.email_transport`, never by binding presence:
 * the EMAIL binding is always bound, so its existence says nothing about whether
 * the operator onboarded a sending domain. A genuine sender rejection surfaces at
 * send time as a named, non-retryable error in the delivery log instead.
 */
export async function resolveEmailTransport({
  env,
  db,
}: {
  env: TransportEnv
  db: D1Database
}): Promise<EmailTransport | null> {
  const settings = await loadEmailSettings(db)
  if (!settings) return null

  if (settings.transport === "smtp") {
    const config = await loadSmtpConfig({
      db,
      encryptionKey: env.FORMZERO_ENCRYPTION_KEY,
    })
    if (!config) return null
    const from: EmailSender = {
      email: settings.fromAddress ?? config.notification_email,
      ...(settings.fromName ? { name: settings.fromName } : {}),
    }
    return createSmtpTransport({ config, from })
  }

  // The Cloudflare transport has no fallback sender: env.EMAIL.send() needs an
  // address on a domain onboarded for sending, and notification_email is an
  // SMTP username that would be rejected with E_SENDER_NOT_VERIFIED.
  if (!settings.fromAddress) return null
  const from: EmailSender = {
    email: settings.fromAddress,
    ...(settings.fromName ? { name: settings.fromName } : {}),
  }
  return createCloudflareTransport({ email: env.EMAIL, from })
}

/** Whether a form may enable notifications, without building the transport. */
export async function hasUsableEmailTransport({
  env,
  db,
}: {
  env: TransportEnv
  db: D1Database
}) {
  return Boolean(await resolveEmailTransport({ env, db }))
}
