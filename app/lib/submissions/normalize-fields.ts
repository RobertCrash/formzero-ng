import type { ParsedSubmissionRequest } from "./parse-request.server"

export type SubmissionInternalFields = {
  honeypot?: string
  startedAt?: string
  uploadTokens: string[]
  idempotencyKey?: string
  requestedRedirect?: string
  turnstileToken?: string
}

function firstString(value: unknown) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string")
  }
  return undefined
}

function stringList(value: unknown) {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }
  return []
}

export function extractInternalFields(
  parsed: ParsedSubmissionRequest,
  honeypotFieldName = "_fz_honeypot",
  startedAtFieldName = "_fz_started_at"
) {
  const fields = { ...parsed.fields }
  const internal: SubmissionInternalFields = {
    honeypot: firstString(fields[honeypotFieldName]),
    startedAt: firstString(fields[startedAtFieldName]),
    uploadTokens: stringList(fields._fz_upload_tokens),
    idempotencyKey: firstString(fields._fz_idempotency),
    requestedRedirect: firstString(fields._fz_redirect),
    turnstileToken: firstString(fields["cf-turnstile-response"]),
  }

  for (const key of Object.keys(fields)) {
    if (key.startsWith("_fz_") || key === "cf-turnstile-response") {
      delete fields[key]
    }
  }

  return { fields, internal }
}
