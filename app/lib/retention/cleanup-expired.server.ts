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
  now = Date.now()
) {
  const result = await db
    .prepare(`
      DELETE FROM submissions
      WHERE delete_after IS NOT NULL
        AND delete_after <= ?
        AND status != 'pending_delete'
        AND NOT EXISTS (
          SELECT 1
          FROM submission_files
          WHERE submission_files.submission_id = submissions.id
            AND submission_files.status != 'deleted'
        )
    `)
    .bind(now)
    .run()
  return result.meta.changes
}
