export async function cleanupExpiredUploads({
  db,
  bucket,
  now = Date.now(),
  limit = 100,
}: {
  db: D1Database
  bucket?: R2Bucket
  now?: number
  limit?: number
}) {
  if (!bucket) return 0
  const files = await db
    .prepare(`
      SELECT id, object_key
      FROM submission_files
      WHERE (
        status IN ('temporary', 'completed', 'attached', 'pending_delete', 'failed')
        AND delete_after IS NOT NULL
        AND delete_after <= ?
      )
      ORDER BY delete_after
      LIMIT ?
    `)
    .bind(now, limit)
    .all<{ id: string; object_key: string }>()

  let deleted = 0
  for (const file of files.results) {
    try {
      await bucket.delete(file.object_key)
      await db
        .prepare("DELETE FROM submission_files WHERE id = ?")
        .bind(file.id)
        .run()
      deleted++
    } catch (error) {
      await db
        .prepare(`
          UPDATE submission_files
          SET status = 'failed'
          WHERE id = ?
        `)
        .bind(file.id)
        .run()
      console.error("Failed to clean up R2 object:", file.object_key, error)
    }
  }

  await db
    .prepare(`
      UPDATE upload_sessions
      SET status = 'expired'
      WHERE expires_at <= ?
        AND status IN ('pending', 'completed')
    `)
    .bind(now)
    .run()

  return deleted
}

export async function cleanupOrphanedTemporaryObjects({
  bucket,
  olderThan = Date.now() - 2 * 60 * 60 * 1_000,
}: {
  bucket?: R2Bucket
  olderThan?: number
}) {
  if (!bucket) return 0
  let cursor: string | undefined
  let deleted = 0
  do {
    const page = await bucket.list({
      prefix: "_tmp/",
      cursor,
      limit: 500,
    })
    const expired = page.objects.filter(
      (object) => object.uploaded.getTime() <= olderThan
    )
    await Promise.all(expired.map((object) => bucket.delete(object.key)))
    deleted += expired.length
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return deleted
}
