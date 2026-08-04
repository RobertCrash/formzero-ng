import type { EmailConfig } from "~/types/settings"
import { getSecret, putSecret } from "../secrets/secret-store.server"

type SmtpSettingsRow = {
  notification_email: string | null
  notification_email_password: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: number | null
  smtp_secret_id: string | null
}

/**
 * Loads the stored SMTP connection, migrating a legacy plaintext password into
 * the encrypted secret store when a key is available.
 *
 * The sender address is deliberately not read here: it lives in
 * settings.email_from_address, is shared by both transports, and the superseded
 * smtp_from_address / smtp_from_name columns were never written by any code path.
 */
export async function loadSmtpConfig({
  db,
  encryptionKey,
}: {
  db: D1Database
  encryptionKey?: string
}): Promise<EmailConfig | null> {
  const settings = await db
    .prepare(`
      SELECT
        notification_email,
        notification_email_password,
        smtp_host,
        smtp_port,
        smtp_secure,
        smtp_secret_id
      FROM settings
      WHERE id = 'global'
    `)
    .first<SmtpSettingsRow>()

  if (
    !settings?.notification_email ||
    !settings.smtp_host ||
    !settings.smtp_port
  ) {
    return null
  }

  let password: string | null = null
  let secretId = settings.smtp_secret_id
  if (secretId && encryptionKey) {
    password = await getSecret({ db, encryptionKey, secretId })
  } else if (settings.notification_email_password) {
    password = settings.notification_email_password
    if (encryptionKey) {
      secretId = await putSecret({
        db,
        encryptionKey,
        formId: null,
        purpose: "smtp_password",
        value: password,
      })
      await db
        .prepare(`
          UPDATE settings
          SET
            smtp_secret_id = ?,
            notification_email_password = NULL,
            updated_at = ?
          WHERE id = 'global'
        `)
        .bind(secretId, Date.now())
        .run()
    }
  }

  if (!password) return null

  return {
    notification_email: settings.notification_email,
    notification_email_password: password,
    smtp_host: settings.smtp_host,
    smtp_port: settings.smtp_port,
    smtp_secure: settings.smtp_secure === 1,
  }
}
