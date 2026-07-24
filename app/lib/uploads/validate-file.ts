import type { FormPolicyV1 } from "../form-config/types"
import { SubmissionError } from "../submissions/errors"

export function sanitizeFilename(value: string) {
  const basename = value.split(/[\\/]/).pop() ?? "file"
  return basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .slice(0, 255) || "file"
}

function extensionOf(value: string) {
  const index = value.lastIndexOf(".")
  return index >= 0 ? value.slice(index).toLowerCase() : ""
}

export function validateFiles(
  filesByField: Record<string, File[]>,
  policy: FormPolicyV1
) {
  const files = Object.entries(filesByField).flatMap(([fieldName, files]) =>
    files.map((file) => ({ fieldName, file }))
  )
  const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0)

  if (!policy.uploads.enabled && files.length > 0) {
    throw new SubmissionError(
      "file_validation_failed",
      "File uploads are not enabled for this form."
    )
  }
  if (files.length > policy.uploads.maxFiles) {
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

  for (const { fieldName, file } of files) {
    if (file.size > policy.uploads.maxFileBytes) {
      throw new SubmissionError(
        "payload_too_large",
        `The file in ${fieldName} exceeds the configured limit.`
      )
    }
    if (
      policy.uploads.allowedMimeTypes.length > 0 &&
      !policy.uploads.allowedMimeTypes.includes(file.type.toLowerCase())
    ) {
      throw new SubmissionError(
        "file_validation_failed",
        `The file type ${file.type || "unknown"} is not allowed.`
      )
    }
    const extension = extensionOf(file.name)
    if (
      policy.uploads.allowedExtensions.length > 0 &&
      !policy.uploads.allowedExtensions
        .map((item) => (item.startsWith(".") ? item : `.${item}`).toLowerCase())
        .includes(extension)
    ) {
      throw new SubmissionError(
        "file_validation_failed",
        `The file extension ${extension || "unknown"} is not allowed.`
      )
    }
  }

  return { files, totalBytes }
}

export function matchesKnownMagicBytes(
  bytes: ArrayBuffer,
  mimeType: string
) {
  const value = new Uint8Array(bytes)
  const startsWith = (...signature: number[]) =>
    signature.every((byte, index) => value[index] === byte)

  switch (mimeType.toLowerCase()) {
    case "application/pdf":
      return startsWith(0x25, 0x50, 0x44, 0x46)
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff)
    case "image/gif":
      return (
        startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
        startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
      )
    default:
      return true
  }
}
