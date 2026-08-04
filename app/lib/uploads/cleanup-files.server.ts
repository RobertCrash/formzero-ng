const EXPIRED_FILE_STATUSES =
  "'temporary', 'completed', 'attached', 'pending_delete', 'failed'"

export async function countExpiredUploads(db: D1Database, now: number) {
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM submission_files
      WHERE status IN (${EXPIRED_FILE_STATUSES})
        AND delete_after IS NOT NULL
        AND delete_after <= ?
    `)
    .bind(now)
    .first<{ total: number }>()
  return row?.total ?? 0
}

export async function cleanupExpiredUploads({
  db,
  bucket,
  now = Date.now(),
  limit = 100,
}: {
  db: D1Database
  bucket: R2Bucket
  now?: number
  limit?: number
}) {
  const files = await db
    .prepare(`
      SELECT id, object_key
      FROM submission_files
      WHERE status IN (${EXPIRED_FILE_STATUSES})
        AND delete_after IS NOT NULL
        AND delete_after <= ?
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

/**
 * Sweeps abandoned direct-upload objects one page at a time.
 *
 * This used to walk every page in a single invocation, so a bucket with a large
 * `_tmp/` prefix could exceed the Worker's CPU budget and lose the whole
 * maintenance run. Returning the cursor lets the next run continue instead.
 */
export async function cleanupOrphanedTemporaryObjects({
  bucket,
  olderThan = Date.now() - 2 * 60 * 60 * 1_000,
  cursor,
  maxPages = 4,
  deadline,
}: {
  bucket: R2Bucket
  olderThan?: number
  cursor?: string | null
  maxPages?: number
  /** Epoch ms after which no further page is fetched. */
  deadline?: number
}) {
  let nextCursor = cursor ?? undefined
  let deleted = 0
  let truncated = false

  for (let page = 0; page < maxPages; page++) {
    if (deadline !== undefined && Date.now() >= deadline) {
      truncated = Boolean(nextCursor)
      break
    }
    const listed = await bucket.list({
      prefix: "_tmp/",
      cursor: nextCursor,
      limit: 500,
    })
    const expired = listed.objects.filter(
      (object) => object.uploaded.getTime() <= olderThan
    )
    await Promise.all(expired.map((object) => bucket.delete(object.key)))
    deleted += expired.length
    truncated = listed.truncated
    nextCursor = listed.truncated ? listed.cursor : undefined
    if (!listed.truncated) break
  }

  // A finished sweep clears the cursor so the next run starts from the top and
  // picks up objects that have since aged out.
  return { deleted, cursor: nextCursor ?? null, truncated }
}
