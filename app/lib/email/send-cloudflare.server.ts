import {
  EmailSendError,
  type EmailMessagePayload,
  type EmailSender,
  type EmailTransport,
} from "./message"

/** https://developers.cloudflare.com/email-service/platform/limits/ */
export const CLOUDFLARE_RECIPIENT_LIMIT = 50

/**
 * Codes worth another attempt: a transient service, a rate ceiling, or a
 * downstream mail server that may accept the same message later.
 */
const RETRYABLE_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_DELIVERY_FAILED",
  "E_INTERNAL_SERVER_ERROR",
])

/**
 * Codes that will fail identically on every retry. Retrying them wastes all
 * five attempts and buries the real cause under four duplicates.
 */
const TERMINAL_CODES = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_CONTENT_TOO_LARGE",
  "E_TOO_MANY_RECIPIENTS",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
])

/** Guidance that turns an opaque E_* code into an actionable instruction. */
const REMEDIES: Record<string, string> = {
  E_SENDER_NOT_VERIFIED:
    "Onboard the sender domain with `npx wrangler email sending enable <domain>`, or switch the transport to custom SMTP.",
  E_SENDER_DOMAIN_NOT_AVAILABLE:
    "The sender domain is not onboarded to Email Sending. Run `npx wrangler email sending enable <domain>`.",
  E_RECIPIENT_NOT_ALLOWED:
    "Before a sending domain is onboarded, only verified destination addresses in your own Cloudflare account can receive mail. Onboard the domain, or send to a verified address.",
  E_RECIPIENT_SUPPRESSED:
    "The recipient is on the account suppression list. Remove it in the Cloudflare dashboard.",
  E_TOO_MANY_RECIPIENTS: `Cloudflare Email Service accepts at most ${CLOUDFLARE_RECIPIENT_LIMIT} recipients per message. Reduce the form's recipient list.`,
  E_DAILY_LIMIT_EXCEEDED:
    "The account's daily sending quota is exhausted. Delivery retries after the quota resets.",
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

export function createCloudflareTransport({
  email,
  from,
}: {
  email: SendEmail
  from: EmailSender
}): EmailTransport {
  return {
    kind: "cloudflare",
    from,
    async send(message: EmailMessagePayload) {
      if (message.to.length === 0) {
        throw new EmailSendError("The message has no recipients.", {
          retryable: false,
          code: "E_FIELD_MISSING",
        })
      }
      if (message.to.length > CLOUDFLARE_RECIPIENT_LIMIT) {
        throw new EmailSendError(
          `Cloudflare Email Service accepts at most ${CLOUDFLARE_RECIPIENT_LIMIT} recipients per message; this message has ${message.to.length}.`,
          { retryable: false, code: "E_TOO_MANY_RECIPIENTS" }
        )
      }

      try {
        const result = await email.send({
          to: message.to,
          from: message.from.name
            ? { email: message.from.email, name: message.from.name }
            : message.from.email,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          subject: message.subject,
          html: message.html,
          text: message.text,
        })
        return { messageId: result?.messageId }
      } catch (error) {
        const code = errorCode(error)
        const detail =
          error instanceof Error ? error.message : "Email Service rejected the message."
        const remedy = code ? REMEDIES[code] : undefined
        throw new EmailSendError(
          [code ? `${code}: ${detail}` : detail, remedy].filter(Boolean).join(" "),
          {
            // Known-terminal codes fail identically forever, so they stop here.
            // Anything else — including an error with no code at all, which is
            // usually a transient network fault — is worth another attempt.
            retryable: code ? !TERMINAL_CODES.has(code) : true,
            code,
            cause: error,
          }
        )
      }
    },
  }
}

export { RETRYABLE_CODES, TERMINAL_CODES }
