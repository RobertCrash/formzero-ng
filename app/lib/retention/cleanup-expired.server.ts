import { deleteSubmissionWithFiles } from "../uploads/delete-submission.server"

export async function redactExpiredIps(db: D1Database, now = Date.now()) {
  const result = await db
    .prepare(`
      UPDATE submissions
      SET source_ip = NULL
      WHERE ip_delete_after IS NOT NULL
        AND ip_delete_after <= ?
        AND source_ip IS NOT NULL
    `)
    .bind(now)
    .run()
  return result.meta.changes
}

export async function deleteExpiredSubmissions(
  db: D1Database,
  bucket?: R2Bucket,
  now = Date.now()
) {
  const expired = await db
    .prepare(`
      SELECT id, form_id
      FROM submissions
      WHERE delete_after IS NOT NULL
        AND delete_after <= ?
        AND status != 'pending_delete'
      ORDER BY delete_after
      LIMIT 100
    `)
    .bind(now)
    .all<{ id: string; form_id: string }>()
  let deleted = 0
  for (const submission of expired.results) {
    const result = await deleteSubmissionWithFiles({
      db,
      bucket,
      formId: submission.form_id,
      submissionId: submission.id,
    })
    if (result.deleted) deleted++
  }
  return deleted
}
