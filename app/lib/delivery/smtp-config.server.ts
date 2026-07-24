import type { EmailConfig } from "~/types/settings"
import { getSecret, putSecret } from "../secrets/secret-store.server"

type SmtpSettingsRow = {
  notification_email: string | null
  notification_email_password: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: number | null
  smtp_from_address: string | null
  smtp_from_name: string | null
  smtp_secret_id: string | null
}

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
        smtp_from_address,
        smtp_from_name,
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
    from_address: settings.smtp_from_address ?? settings.notification_email,
    from_name: settings.smtp_from_name ?? undefined,
  }
}
