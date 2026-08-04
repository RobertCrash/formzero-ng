import nodemailer from "nodemailer"
import type { EmailConfig } from "#/types/settings"
import {
  EmailSendError,
  type EmailMessagePayload,
  type EmailSender,
  type EmailTransport,
} from "./message"

/**
 * Secondary transport for operators who must send through their own mail server.
 *
 * This is the path that needs the `nodejs_compat` flag, since nodemailer manages
 * the SMTP socket itself. Cloudflare's own guidance is to prefer the Email
 * Service binding; keep this available, but do not make it the default.
 */

/** Authentication and address errors that will fail the same way every time. */
function classify(error: unknown) {
  if (!(error instanceof Error)) {
    return { retryable: true, message: "The SMTP server rejected the message." }
  }
  const message = error.message
  if (/invalid login|535|534|authentication failed/i.test(message)) {
    return {
      retryable: false,
      message: `SMTP authentication failed: ${message}. Re-enter the SMTP password in notification settings.`,
    }
  }
  if (/\b5\d\d\b/.test(message) && !/\b5(?:0[0-4]|21)\b/.test(message)) {
    return { retryable: false, message }
  }
  if (/ENOTFOUND|ECONNREFUSED/.test(message)) {
    return {
      retryable: false,
      message: `Cannot connect to the SMTP server: ${message}. Check the host and port.`,
    }
  }
  return { retryable: true, message }
}

export function createSmtpTransport({
  config,
  from,
}: {
  config: EmailConfig
  from: EmailSender
}): EmailTransport {
  return {
    kind: "smtp",
    from,
    async send(message: EmailMessagePayload) {
      const transporter = nodemailer.createTransport({
        host: config.smtp_host,
        port: config.smtp_port,
        secure: config.smtp_secure,
        auth: {
          user: config.notification_email,
          pass: config.notification_email_password,
        },
      })

      try {
        const info = await transporter.sendMail({
          from: message.from.name
            ? `"${message.from.name}" <${message.from.email}>`
            : message.from.email,
          to: message.to,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
        })
        return { messageId: info.messageId }
      } catch (error) {
        const { retryable, message: detail } = classify(error)
        throw new EmailSendError(detail, { retryable, cause: error })
      }
    },
  }
}
