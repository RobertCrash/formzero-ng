import type { EmailTransportKind } from "~/lib/email/message"

export type Settings = {
  id: string
  email_transport: EmailTransportKind
  email_from_address: string | null
  email_from_name: string | null
  notification_email: string | null
  has_password: boolean
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: number
  updated_at: number
}

/** Connection and credentials for the custom SMTP transport. */
export type EmailConfig = {
  notification_email: string
  notification_email_password: string
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
}
