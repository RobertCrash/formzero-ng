export type SubmissionErrorCode =
  | "form_not_found"
  | "malformed_request"
  | "unsupported_content_type"
  | "payload_too_large"
  | "origin_not_allowed"
  | "rate_limit_exceeded"
  | "honeypot_triggered"
  | "captcha_failed"
  | "validation_failed"
  | "file_validation_failed"
  | "capability_unavailable"
  | "internal_error"

const statusByCode: Record<SubmissionErrorCode, number> = {
  form_not_found: 404,
  malformed_request: 400,
  unsupported_content_type: 415,
  payload_too_large: 413,
  origin_not_allowed: 403,
  rate_limit_exceeded: 429,
  honeypot_triggered: 403,
  captcha_failed: 403,
  validation_failed: 422,
  file_validation_failed: 422,
  capability_unavailable: 503,
  internal_error: 500,
}

export class SubmissionError extends Error {
  readonly code: SubmissionErrorCode
  readonly status: number
  readonly fields?: Record<string, string>

  constructor(
    code: SubmissionErrorCode,
    message: string,
    fields?: Record<string, string>
  ) {
    super(message)
    this.name = "SubmissionError"
    this.code = code
    this.status = statusByCode[code]
    this.fields = fields
  }
}
