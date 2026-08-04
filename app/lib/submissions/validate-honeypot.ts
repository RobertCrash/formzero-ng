import type { FormPolicyV1 } from "../form-config/types"
import type { SubmissionInternalFields } from "./normalize-fields"
import { SubmissionError } from "./errors"

/**
 * A marker older than this is treated as invalid rather than merely slow: it is
 * either a replayed body or a badly skewed clock, and neither is evidence that a
 * human spent time on the form.
 */
const MAX_MARKER_AGE_MS = 24 * 60 * 60 * 1_000

function checkFillTime({
  startedAt,
  receivedAt,
  minimumFillTimeMs,
}: {
  startedAt: string | undefined
  receivedAt: number
  minimumFillTimeMs: number
}) {
  if (!startedAt?.trim()) return false
  const value = Number(startedAt)
  if (!Number.isInteger(value) || value <= 0) return false
  const elapsed = receivedAt - value
  if (elapsed < 0 || elapsed > MAX_MARKER_AGE_MS) return false
  return elapsed >= minimumFillTimeMs
}

export function validateHoneypot({
  internal,
  config,
  receivedAt,
}: {
  internal: SubmissionInternalFields
  config: FormPolicyV1["security"]["honeypot"]
  receivedAt: number
}) {
  if (!config.enabled) {
    return { triggered: false, discard: false, minimumTimePassed: undefined }
  }

  const populated = Boolean(internal.honeypot?.trim())
  let minimumTimePassed: boolean | undefined

  // Zero is "no minimum", which is the only way to accept clients that cannot
  // produce the timestamp at all.
  if (config.minimumFillTimeMs) {
    // Absence used to leave this undefined, which read as "passed" — so simply
    // omitting the marker skipped the check, which is exactly what a bot does.
    // The control therefore only ever applied to clients that opted into it.
    minimumTimePassed = checkFillTime({
      startedAt: internal.startedAt,
      receivedAt,
      minimumFillTimeMs: config.minimumFillTimeMs,
    })
  }

  const triggered = populated || minimumTimePassed === false
  if (!triggered) {
    return { triggered: false, discard: false, minimumTimePassed }
  }

  if (config.response === "reject") {
    throw new SubmissionError("honeypot_triggered", "Submission rejected.")
  }

  return { triggered: true, discard: true, minimumTimePassed }
}
