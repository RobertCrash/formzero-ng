import type { FormWithPolicy } from "../form-config/types"
import { assertBinding } from "../platform/check-bindings.server"
import type { PreparedSubmissionFile } from "../submissions/create-submission.server"
import { SubmissionError } from "../submissions/errors"
import { attachedObjectKey } from "./object-key"
import { isAllowedFileExtension } from "./validate-file"

export async function prepareDirectUploads({
  db,
  bucket,
  form,
  tokens,
}: {
  db: D1Database
  bucket: R2Bucket
  form: FormWithPolicy
  tokens: string[]
}) {
  if (tokens.length === 0) {
    return {
      files: [] as PreparedSubmissionFile[],
      cleanup: async () => {},
      finalize: async () => {},
      totalBytes: 0,
    }
  }
  assertBinding(bucket, "UPLOADS")
  if (tokens.length > form.policy.uploads.maxFiles) {
    throw new SubmissionError(
      "file_validation_failed",
      "Too many direct-upload tokens were submitted."
    )
  }

  const placeholders = tokens.map(() => "?").join(",")
  const rows = await db
    .prepare(`
      SELECT
        file.id,
        file.upload_session_id,
        file.field_name,
        file.object_key,
        file.original_name,
        file.mime_type,
        file.size_bytes,
        file.checksum
      FROM submission_files AS file
      JOIN upload_sessions AS session ON session.id = file.upload_session_id
      WHERE file.form_id = ?
        AND file.id IN (${placeholders})
        AND file.status = 'completed'
        AND session.status = 'completed'
        AND session.expires_at > ?
    `)
    .bind(form.id, ...tokens, Date.now())
    .all<{
      id: string
      upload_session_id: string
      field_name: string
      object_key: string
      original_name: string
      mime_type: string
      size_bytes: number
      checksum: string | null
    }>()
  if (rows.results.length !== new Set(tokens).size) {
    throw new SubmissionError(
      "file_validation_failed",
      "One or more direct-upload tokens are invalid or expired."
    )
  }

  const totalBytes = rows.results.reduce((sum, row) => sum + row.size_bytes, 0)
  if (totalBytes > form.policy.uploads.maxTotalBytes) {
    throw new SubmissionError(
      "payload_too_large",
      "The direct uploads exceed the total file limit."
    )
  }
  for (const row of rows.results) {
    if (
      row.size_bytes > form.policy.uploads.maxFileBytes ||
      (form.policy.uploads.allowedMimeTypes.length > 0 &&
        !form.policy.uploads.allowedMimeTypes.includes(
          row.mime_type.toLowerCase()
        )) ||
      !isAllowedFileExtension(
        row.original_name,
        form.policy.uploads.allowedExtensions
      )
    ) {
      throw new SubmissionError(
        "file_validation_failed",
        "A direct upload no longer satisfies the form upload policy."
      )
    }
  }

  const prepared: PreparedSubmissionFile[] = []
  const oldKeys: string[] = []
  try {
    for (const row of rows.results) {
      const object = await bucket.get(row.object_key)
      if (!object) throw new Error("Uploaded R2 object is missing.")
      const objectKey = attachedObjectKey(form.id, row.id)
      await bucket.put(objectKey, object.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: {
          formId: form.id,
          fileId: row.id,
          status: "attached",
        },
      })
      oldKeys.push(row.object_key)
      prepared.push({
        id: row.id,
        fieldName: row.field_name,
        objectKey,
        originalName: row.original_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        checksum: row.checksum,
        uploadSessionId: row.upload_session_id,
        existingMetadata: true,
      })
    }
  } catch {
    await Promise.allSettled(prepared.map((file) => bucket.delete(file.objectKey)))
    throw new SubmissionError(
      "internal_error",
      "Direct uploads could not be attached."
    )
  }

  return {
    files: prepared,
    totalBytes,
    cleanup: async () => {
      await Promise.allSettled(prepared.map((file) => bucket.delete(file.objectKey)))
    },
    finalize: async () => {
      await Promise.allSettled(oldKeys.map((key) => bucket.delete(key)))
      const sessionIds = [...new Set(rows.results.map((row) => row.upload_session_id))]
      try {
        await db
          .prepare(`
            UPDATE upload_sessions
            SET status = 'attached'
            WHERE id IN (${sessionIds.map(() => "?").join(",")})
          `)
          .bind(...sessionIds)
          .run()
      } catch (error) {
        console.error("Failed to finalize direct-upload session cleanup:", error)
      }
    },
  }
}
