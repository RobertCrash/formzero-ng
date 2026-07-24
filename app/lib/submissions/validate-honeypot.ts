import type { FormPolicyV1 } from "../form-config/types"
import type { SubmissionInternalFields } from "./normalize-fields"
import { SubmissionError } from "./errors"

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

  if (config.minimumFillTimeMs !== undefined && internal.startedAt) {
    const startedAt = Number(internal.startedAt)
    minimumTimePassed =
      Number.isFinite(startedAt) &&
      receivedAt - startedAt >= config.minimumFillTimeMs &&
      receivedAt >= startedAt
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
