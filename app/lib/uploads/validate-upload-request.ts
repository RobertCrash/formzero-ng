import type { FormPolicyV1 } from "../form-config/types"
import type { PreparedSubmissionFile } from "../submissions/create-submission.server"
import { SubmissionError } from "../submissions/errors"

export function validateUploadRequestMode({
  policy,
  inlineFiles,
  directTokens,
}: {
  policy: FormPolicyV1
  inlineFiles: Record<string, File[]>
  directTokens: string[]
}) {
  const inlineCount = Object.values(inlineFiles).reduce(
    (count, files) => count + files.length,
    0
  )
  const hasInline = inlineCount > 0
  const hasDirect = directTokens.length > 0
  if (!policy.uploads.enabled && (hasInline || hasDirect)) {
    throw new SubmissionError(
      "file_validation_failed",
      "File uploads are not enabled for this form."
    )
  }
  if (policy.uploads.mode === "inline" && hasDirect) {
    throw new SubmissionError(
      "file_validation_failed",
      "Direct-upload tokens are not accepted in inline upload mode."
    )
  }
  if (policy.uploads.mode === "direct" && hasInline) {
    throw new SubmissionError(
      "file_validation_failed",
      "Multipart files are not accepted in direct upload mode."
    )
  }
}

export function validateCombinedUploadLimits({
  policy,
  inlineFiles,
  directFiles,
}: {
  policy: FormPolicyV1
  inlineFiles: Record<string, File[]>
  directFiles: PreparedSubmissionFile[]
}) {
  const inline = Object.values(inlineFiles).flat()
  const count = inline.length + directFiles.length
  const totalBytes =
    inline.reduce((total, file) => total + file.size, 0) +
    directFiles.reduce((total, file) => total + file.sizeBytes, 0)
  if (count > policy.uploads.maxFiles) {
    throw new SubmissionError(
      "file_validation_failed",
      `A maximum of ${policy.uploads.maxFiles} files is allowed.`
    )
  }
  if (totalBytes > policy.uploads.maxTotalBytes) {
    throw new SubmissionError(
      "payload_too_large",
      "The total file size exceeds the configured limit."
    )
  }
  return { count, totalBytes }
}
