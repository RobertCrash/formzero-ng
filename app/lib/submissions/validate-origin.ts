import type { FormPolicyV1 } from "../form-config/types"
import { SubmissionError } from "./errors"

export function normalizeOrigin(value: string) {
  const url = new URL(value)
  return url.origin.toLowerCase()
}

export function resolveCorsHeaders(
  request: Request,
  security: Pick<
    FormPolicyV1["security"],
    "allowedOrigins" | "allowMissingOrigin"
  >
) {
  const headers = new Headers({ Vary: "Origin" })
  const origin = request.headers.get("Origin")
  if (!origin) return headers

  try {
    const normalized = normalizeOrigin(origin)
    const allowed =
      (security.allowedOrigins.length === 0 && security.allowMissingOrigin) ||
      security.allowedOrigins.some(
        (candidate) => normalizeOrigin(candidate) === normalized
      )
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", origin)
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")
      headers.set("Access-Control-Allow-Headers", "Content-Type, Accept")
      headers.set("Access-Control-Max-Age", "86400")
    }
  } catch {
    // Invalid origins do not receive CORS permission headers.
  }

  return headers
}

export function validateOrigin(
  request: Request,
  security: FormPolicyV1["security"]
) {
  const origin = request.headers.get("Origin")
  if (!origin) {
    if (security.allowMissingOrigin) return null
    throw new SubmissionError(
      "origin_not_allowed",
      "Requests without an Origin header are not allowed."
    )
  }

  let normalized: string
  try {
    normalized = normalizeOrigin(origin)
  } catch {
    throw new SubmissionError("origin_not_allowed", "The Origin header is invalid.")
  }

  if (
    !(
      security.allowedOrigins.length === 0 &&
      security.allowMissingOrigin
    ) &&
    !security.allowedOrigins.some(
      (candidate) => normalizeOrigin(candidate) === normalized
    )
  ) {
    throw new SubmissionError(
      "origin_not_allowed",
      "This origin is not allowed to submit to the form."
    )
  }

  return normalized
}
