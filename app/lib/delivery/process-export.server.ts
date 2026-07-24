import { loadFormWithPolicy } from "../form-config/load-form-policy.server"

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

export async function processExport(
  exportJobId: string,
  env: { DB: D1Database; UPLOADS?: R2Bucket }
) {
  if (!env.UPLOADS) throw new Error("UPLOADS R2 binding is unavailable.")
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

  const lines = [
    ["ID", "Created At", ...fieldNames].map(csvValue).join(","),
  ]
  let cursorCreatedAt: number | null = null
  let cursorId: string | null = null
  let rowCount = 0
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
    const page: D1Result<{ id: string; data: string; created_at: number }> = await (
      cursorCreatedAt === null
        ? statement.bind(form.id)
        : statement.bind(form.id, cursorCreatedAt, cursorCreatedAt, cursorId)
    ).all<{ id: string; data: string; created_at: number }>()
    for (const row of page.results) {
      const values = JSON.parse(row.data) as Record<string, unknown>
      lines.push(
        [
          row.id,
          new Date(row.created_at).toISOString(),
          ...fieldNames.map((field) => values[field]),
        ]
          .map(csvValue)
          .join(",")
      )
      rowCount++
    }
    if (page.results.length < 500) break
    const last: { id: string; data: string; created_at: number } =
      page.results.at(-1)!
    cursorCreatedAt = last.created_at
    cursorId = last.id
  }

  const objectKey = `exports/${form.id}/${job.id}.csv`
  await env.UPLOADS.put(objectKey, lines.join("\n"), {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
  })
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
