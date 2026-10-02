import { loadFormWithPolicy } from "../form-config/load-form-policy.server"
import { assertBinding } from "../platform/check-bindings.server"

/** R2 multipart parts must be at least 5 MiB except the final part. */
const MULTIPART_PART_BYTES = 5 * 1024 * 1024

function csvValue(value: unknown) {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

/**
 * Writes unknown-length CSV into R2 via multipart upload.
 *
 * A single `put(TransformStream)` fails on Workers because the body has no
 * known length. Multipart accepts bounded parts and can be aborted on failure.
 */
export async function processExport(
  exportJobId: string,
  env: { DB: D1Database; UPLOADS: R2Bucket }
) {
  assertBinding(env.UPLOADS, "UPLOADS")
  const job = await env.DB
    .prepare(`
      SELECT id, form_id
      FROM export_jobs
      WHERE id = ? AND status IN ('pending', 'processing')
    `)
    .bind(exportJobId)
    .first<{ id: string; form_id: string }>()
  if (!job) throw new Error("Export job no longer exists.")
  await env.DB
    .prepare("UPDATE export_jobs SET status = 'processing' WHERE id = ?")
    .bind(job.id)
    .run()
  const form = await loadFormWithPolicy(env.DB, job.form_id)
  if (!form) throw new Error("Form no longer exists.")

  let fieldNames = form.policy.fields.map((field) => field.name)
  if (fieldNames.length === 0) {
    const fields = await env.DB
      .prepare(`
        SELECT DISTINCT field.key AS name
        FROM submissions AS submission, json_each(submission.data) AS field
        WHERE submission.form_id = ?
        ORDER BY field.key
      `)
      .bind(form.id)
      .all<{ name: string }>()
    fieldNames = fields.results.map((field) => field.name)
  }

  let rowCount = 0
  const objectKey = `exports/${form.id}/${job.id}.csv`
  const multipart = await env.UPLOADS.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
  })
  const uploadedParts: R2UploadedPart[] = []
  let partNumber = 1
  let buffer = new Uint8Array(0)
  const encoder = new TextEncoder()

  const append = async (chunk: Uint8Array) => {
    if (chunk.byteLength === 0) return
    const next = new Uint8Array(buffer.byteLength + chunk.byteLength)
    next.set(buffer)
    next.set(chunk, buffer.byteLength)
    buffer = next
    while (buffer.byteLength >= MULTIPART_PART_BYTES) {
      const part = buffer.subarray(0, MULTIPART_PART_BYTES)
      buffer = buffer.subarray(MULTIPART_PART_BYTES)
      uploadedParts.push(await multipart.uploadPart(partNumber, part))
      partNumber++
    }
  }

  try {
    await append(
      encoder.encode(
        `${["ID", "Created At", ...fieldNames].map(csvValue).join(",")}\n`
      )
    )

    let cursorCreatedAt: number | null = null
    let cursorId: string | null = null
    while (true) {
      const statement = env.DB.prepare(`
        SELECT id, data, created_at
        FROM submissions
        WHERE form_id = ?
          AND status = 'accepted'
          ${
            cursorCreatedAt === null
              ? ""
              : "AND (created_at < ? OR (created_at = ? AND id < ?))"
          }
        ORDER BY created_at DESC, id DESC
        LIMIT 500
      `)
      const page: D1Result<{
        id: string
        data: string
        created_at: number
      }> = await (
        cursorCreatedAt === null
          ? statement.bind(form.id)
          : statement.bind(form.id, cursorCreatedAt, cursorCreatedAt, cursorId)
      ).all<{ id: string; data: string; created_at: number }>()
      for (const row of page.results) {
        const values = JSON.parse(row.data) as Record<string, unknown>
        const line = [
          row.id,
          new Date(row.created_at).toISOString(),
          ...fieldNames.map((field) => values[field]),
        ]
          .map(csvValue)
          .join(",")
        await append(encoder.encode(`${line}\n`))
        rowCount++
      }
      if (page.results.length < 500) break
      const last: { id: string; data: string; created_at: number } =
        page.results.at(-1)!
      cursorCreatedAt = last.created_at
      cursorId = last.id
    }

    if (buffer.byteLength > 0 || uploadedParts.length === 0) {
      // Final part may be smaller than 5 MiB. An empty export still needs one
      // part so complete() has something to finish.
      uploadedParts.push(await multipart.uploadPart(partNumber, buffer))
    }
    await multipart.complete(uploadedParts)
  } catch (error) {
    await multipart.abort().catch(() => {})
    throw error
  }

  const completedAt = Date.now()
  await env.DB
    .prepare(`
      UPDATE export_jobs
      SET
        status = 'completed',
        object_key = ?,
        row_count = ?,
        completed_at = ?,
        expires_at = ?
      WHERE id = ?
    `)
    .bind(
      objectKey,
      rowCount,
      completedAt,
      completedAt + 24 * 60 * 60 * 1_000,
      job.id
    )
    .run()
  return { objectKey, rowCount }
}

export { csvValue }
