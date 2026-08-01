import { publishPendingDeliveryJobs } from "../delivery/publish-jobs.server"
import {
  cleanupExpiredUploads,
  cleanupOrphanedTemporaryObjects,
} from "../uploads/cleanup-files.server"
import { deleteSubmissionWithFiles } from "../uploads/delete-submission.server"
import {
  deleteExpiredSubmissions,
  redactExpiredIps,
} from "./cleanup-expired.server"

type MaintenanceEnv = {
  DB: D1Database
  UPLOADS?: R2Bucket
  DELIVERY_QUEUE?: Queue<{ jobId: string }>
}

export async function runScheduledMaintenance(env: MaintenanceEnv) {
  const now = Date.now()
  await env.DB
    .prepare(`
      UPDATE delivery_jobs
      SET
        status = 'retry',
        available_at = ?,
        locked_at = NULL,
        last_error = 'Processing lock expired',
        updated_at = ?
      WHERE status = 'processing'
        AND locked_at < ?
    `)
    .bind(now, now, now - 15 * 60 * 1_000)
    .run()

  const published = await publishPendingDeliveryJobs({
    db: env.DB,
    queue: env.DELIVERY_QUEUE,
  })
  const redactedIps = await redactExpiredIps(env.DB, now)
  const cleanedFiles = await cleanupExpiredUploads({
    db: env.DB,
    bucket: env.UPLOADS,
    now,
  })
  const cleanedOrphans = await cleanupOrphanedTemporaryObjects({
    bucket: env.UPLOADS,
  })

  const pendingDeletes = await env.DB
    .prepare(`
      SELECT id, form_id
      FROM submissions
      WHERE status = 'pending_delete'
      LIMIT 100
    `)
    .all<{ id: string; form_id: string }>()
  for (const submission of pendingDeletes.results) {
    await deleteSubmissionWithFiles({
      db: env.DB,
      bucket: env.UPLOADS,
      formId: submission.form_id,
      submissionId: submission.id,
    })
  }
  const deletedSubmissions = await deleteExpiredSubmissions(
    env.DB,
    env.UPLOADS,
    now
  )

  if (env.UPLOADS) {
    const exports = await env.DB
      .prepare(`
        SELECT id, object_key
        FROM export_jobs
        WHERE expires_at IS NOT NULL
          AND expires_at <= ?
          AND object_key IS NOT NULL
        LIMIT 100
      `)
      .bind(now)
      .all<{ id: string; object_key: string }>()
    for (const job of exports.results) {
      try {
        await env.UPLOADS.delete(job.object_key)
        await env.DB
          .prepare(`
            UPDATE export_jobs
            SET status = 'expired', object_key = NULL
            WHERE id = ?
          `)
          .bind(job.id)
          .run()
      } catch (error) {
        console.error("Failed to remove expired export:", job.id, error)
      }
    }
  }

  return {
    published,
    redactedIps,
    cleanedFiles,
    cleanedOrphans,
    deletedSubmissions,
  }
}
