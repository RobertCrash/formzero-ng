export async function countDeadLetteredDeliveries(db: D1Database) {
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM delivery_jobs
      WHERE dead_lettered_at IS NOT NULL
        AND status = 'failed'
    `)
    .first<{ total: number }>()
  return row?.total ?? 0
}
