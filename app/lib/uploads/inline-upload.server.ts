import type { FormWithPolicy } from "../form-config/types"
import type { PreparedSubmissionFile } from "../submissions/create-submission.server"
import { SubmissionError } from "../submissions/errors"
import { attachedObjectKey } from "./object-key"
import { sanitizeFilename, validateFiles } from "./validate-file"

function checksumHex(value: ArrayBuffer) {
  return crypto.subtle.digest("SHA-256", value).then((digest) =>
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  )
}

export async function uploadInlineFiles({
  bucket,
  form,
  filesByField,
}: {
  bucket?: R2Bucket
  form: FormWithPolicy
  filesByField: Record<string, File[]>
}) {
  const validation = validateFiles(filesByField, form.policy)
  if (validation.files.length === 0) {
    return {
      files: [] as PreparedSubmissionFile[],
      cleanup: async () => {},
      totalBytes: 0,
    }
  }
  if (!bucket) {
    throw new SubmissionError(
      "capability_unavailable",
      "Uploads are enabled but the R2 binding is not configured."
    )
  }

  const prepared: PreparedSubmissionFile[] = []
  try {
    for (const { fieldName, file } of validation.files) {
      const id = crypto.randomUUID()
      const objectKey = attachedObjectKey(form.id, id)
      const body = await file.arrayBuffer()
      const checksum = await checksumHex(body)
      await bucket.put(objectKey, body, {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: {
          formId: form.id,
          fileId: id,
          status: "temporary",
        },
      })
      prepared.push({
        id,
        fieldName,
        objectKey,
        originalName: sanitizeFilename(file.name),
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        checksum,
        uploadSessionId: null,
      })
    }
  } catch {
    await Promise.allSettled(prepared.map((file) => bucket.delete(file.objectKey)))
    throw new SubmissionError("internal_error", "The files could not be uploaded.")
  }

  return {
    files: prepared,
    totalBytes: validation.totalBytes,
    cleanup: async () => {
      await Promise.allSettled(prepared.map((file) => bucket.delete(file.objectKey)))
    },
  }
}
