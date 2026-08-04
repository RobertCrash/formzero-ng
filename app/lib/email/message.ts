export type EmailSender = {
  email: string
  name?: string
}

export type EmailMessagePayload = {
  to: string[]
  from: EmailSender
  replyTo?: string
  subject: string
  html: string
  text: string
}

export type EmailTransportKind = "cloudflare" | "smtp"

export type EmailTransport = {
  kind: EmailTransportKind
  /** Sender the transport will actually use, for display in diagnostics. */
  from: EmailSender
  send(message: EmailMessagePayload): Promise<{ messageId?: string }>
}

/**
 * A send failure that already knows whether retrying can help.
 *
 * Without this, `processDeliveryJob` retries everything, so a permanently
 * rejected sender burns all five attempts and its real cause is buried under
 * four identical failures.
 */
export class EmailSendError extends Error {
  readonly retryable: boolean
  readonly code?: string

  constructor(
    message: string,
    options: { retryable: boolean; code?: string; cause?: unknown }
  ) {
    super(message, { cause: options.cause })
    this.name = "EmailSendError"
    this.retryable = options.retryable
    this.code = options.code
  }
}

/** No transport is configured at all, so no attempt was made. */
export class EmailTransportMissingError extends EmailSendError {
  constructor(message: string) {
    super(message, { retryable: false, code: "E_TRANSPORT_NOT_CONFIGURED" })
    this.name = "EmailTransportMissingError"
  }
}
