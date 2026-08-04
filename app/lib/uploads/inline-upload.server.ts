import type { FormWithPolicy } from "../form-config/types"
import { assertBinding } from "../platform/check-bindings.server"
import type { PreparedSubmissionFile } from "../submissions/create-submission.server"
import { SubmissionError } from "../submissions/errors"
import { limitAndHash } from "./limited-stream"
import { attachedObjectKey } from "./object-key"
import { sanitizeFilename, validateFiles } from "./validate-file"

export async function uploadInlineFiles({
  bucket,
  form,
  filesByField,
}: {
  bucket: R2Bucket
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
  assertBinding(bucket, "UPLOADS")

  const prepared: PreparedSubmissionFile[] = []
  try {
    for (const { fieldName, file } of validation.files) {
      const id = crypto.randomUUID()
      const objectKey = attachedObjectKey(form.id, id)
      // validateFiles already checked file.size, so the limit here is a
      // belt-and-braces cap on the actual bytes rather than the declared ones.
      const upload = limitAndHash(file.stream(), form.policy.uploads.maxFileBytes)
      await bucket.put(objectKey, upload.body, {
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
        sizeBytes: upload.bytesRead(),
        checksum: await upload.checksum(),
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
