import type { FormPolicyV1 } from "./types"

/**
 * Inline uploads travel inside the submission body, so `request.maxPayloadBytes`
 * is checked against the whole multipart envelope *before* any per-file limit
 * applies. A form configured for 25 MB of files behind a 50 KB request limit
 * therefore rejects every upload with `payload_too_large`, and nothing in the
 * settings UI hints at the contradiction.
 *
 * These helpers give the two limits one shared definition of "consistent".
 */

/** Boundary lines, the trailing delimiter, and the non-file text fields. */
export const MULTIPART_ENVELOPE_BYTES = 8_192

/** `Content-Disposition` and `Content-Type` headers plus the boundary per part. */
export const MULTIPART_PART_BYTES = 1_024

/**
 * Inline mode buffers the request body to parse it, so its ceiling is far below
 * the 100 MB the schema allows for direct-to-R2 uploads.
 */
export const INLINE_MAX_TOTAL_BYTES = 25_000_000

type Uploads = FormPolicyV1["uploads"]

/** The smallest `request.maxPayloadBytes` that can carry a full upload set. */
export function inlineRequestFloorBytes(uploads: Uploads) {
  return (
    uploads.maxTotalBytes +
    MULTIPART_ENVELOPE_BYTES +
    MULTIPART_PART_BYTES * uploads.maxFiles
  )
}

/** Whether inline uploads of this size can actually reach the handler. */
export function inlineLimitsAgree(policy: FormPolicyV1) {
  if (!policy.uploads.enabled || policy.uploads.mode !== "inline") return true
  return policy.request.maxPayloadBytes >= inlineRequestFloorBytes(policy.uploads)
}
