import { assertBinding } from "../platform/check-bindings.server"
import type { CreatedDeliveryJob } from "./create-jobs.server"

type DeliveryQueue = {
  send(message: { jobId: string }): Promise<unknown>
  sendBatch?(
    messages: Array<{ body: { jobId: string } }>
  ): Promise<unknown>
}

export async function publishDeliveryJobs({
  db,
  queue,
  jobs,
}: {
  db: D1Database
  queue: DeliveryQueue
  jobs: CreatedDeliveryJob[]
}) {
  if (jobs.length === 0) return
  // Previously a missing queue returned silently here, leaving jobs 'pending'
  // forever with nothing recorded anywhere.
  assertBinding(queue, "DELIVERY_QUEUE")

  if (queue.sendBatch) {
    await queue.sendBatch(jobs.map((job) => ({ body: { jobId: job.id } })))
  } else {
    await Promise.all(jobs.map((job) => queue.send({ jobId: job.id })))
  }

  const now = Date.now()
  await db.batch(
    jobs.map((job) =>
      db
        .prepare(`
          UPDATE delivery_jobs
          SET status = 'published', updated_at = ?
          WHERE id = ? AND status IN ('pending', 'retry')
        `)
        .bind(now, job.id)
    )
  )
}

export async function publishPendingDeliveryJobs({
  db,
  queue,
  limit = 100,
  maxJobs = 1_000,
}: {
  db: D1Database
  queue: DeliveryQueue
  limit?: number
  maxJobs?: number
}) {
  let published = 0
  while (published < maxJobs) {
    const pageSize = Math.min(limit, maxJobs - published)
    const result = await db
      .prepare(`
        SELECT id, kind, target_id
        FROM delivery_jobs
        WHERE status IN ('pending', 'retry')
          AND available_at <= ?
        ORDER BY created_at
        LIMIT ?
      `)
      .bind(Date.now(), pageSize)
      .all<{
        id: string
        kind: CreatedDeliveryJob["kind"]
        target_id: string | null
      }>()

    const jobs = result.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      targetId: row.target_id,
    }))
    await publishDeliveryJobs({ db, queue, jobs })
    published += jobs.length
    if (jobs.length < pageSize) break
  }
  return published
}
