export type Settings = {
  id: string
  notification_email: string | null
  has_password: boolean
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: number
  updated_at: number
}

export type EmailConfig = {
  notification_email: string
  notification_email_password: string
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  from_address?: string
  from_name?: string
}
