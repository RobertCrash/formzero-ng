import { EmailSendError } from "../email/message"
import { processEmail } from "./process-email.server"
import { processWebhook } from "./process-webhook.server"
import { processExport } from "./process-export.server"

const retryDelays = [0, 60, 300, 1_800, 7_200]

type DeliveryEnv = {
  DB: D1Database
  EMAIL: SendEmail
  UPLOADS: R2Bucket
  FORMZERO_ENCRYPTION_KEY?: string
  FORMZERO_PUBLIC_URL?: string
}

/**
 * An unverified sender or an invalid recipient fails identically on every
 * attempt. Retrying it five times delays the real diagnosis and buries the
 * cause under four duplicate failures.
 */
function isTerminal(error: unknown) {
  return error instanceof EmailSendError && !error.retryable
}

type DeliveryJobRow = {
  id: string
  kind: "notification_email" | "webhook" | "export"
  form_id: string
  submission_id: string | null
  target_id: string | null
  attempt_count: number
  config_snapshot: string | null
}

export async function processDeliveryJob(
  jobId: string,
  env: DeliveryEnv
): Promise<{ retryDelaySeconds?: number }> {
  const now = Date.now()
  const claim = await env.DB
    .prepare(`
      UPDATE delivery_jobs
      SET
        status = 'processing',
        locked_at = ?,
        attempt_count = attempt_count + 1,
        updated_at = ?
      WHERE id = ?
        AND status IN ('pending', 'published', 'retry')
        AND available_at <= ?
    `)
    .bind(now, now, jobId, now)
    .run()
  if (claim.meta.changes === 0) return {}

  const job = await env.DB
    .prepare(`
      SELECT
        id, kind, form_id, submission_id, target_id, attempt_count,
        config_snapshot
      FROM delivery_jobs
      WHERE id = ?
    `)
    .bind(jobId)
    .first<DeliveryJobRow>()
  if (!job || (job.kind !== "export" && !job.submission_id)) return {}

  // Deleting a form fails its queued jobs, but one already in flight would still
  // mail out or POST the submission data of a form the operator just erased.
  const form = await env.DB
    .prepare("SELECT deleted_at FROM forms WHERE id = ?")
    .bind(job.form_id)
    .first<{ deleted_at: number | null }>()
  if (!form || (form.deleted_at ?? null) !== null) {
    await env.DB
      .prepare(`
        UPDATE delivery_jobs
        SET
          status = 'failed',
          last_error = 'Form was deleted.',
          locked_at = NULL,
          updated_at = ?
        WHERE id = ?
      `)
      .bind(Date.now(), job.id)
      .run()
    return {}
  }

  const attemptId = crypto.randomUUID()
  await env.DB
    .prepare(`
      INSERT INTO delivery_attempts (
        id, job_id, attempt_number, started_at
      ) VALUES (?, ?, ?, ?)
    `)
    .bind(attemptId, job.id, job.attempt_count, now)
    .run()

  try {
    let responseStatus: number | null = null
    if (job.kind === "notification_email") {
      await processEmail(
        { ...job, submission_id: job.submission_id! },
        env
      )
    } else if (job.kind === "webhook") {
      if (!job.target_id) throw new Error("Webhook target is missing.")
      const result = await processWebhook(
        {
          ...job,
          submission_id: job.submission_id!,
          target_id: job.target_id,
        },
        env
      )
      responseStatus = result.responseStatus
    } else if (job.kind === "export") {
      if (!job.target_id) throw new Error("Export target is missing.")
      await processExport(job.target_id, env)
    }

    const completedAt = Date.now()
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE delivery_jobs
          SET
            status = 'completed',
            completed_at = ?,
            response_status = ?,
            last_error = NULL,
            locked_at = NULL,
            updated_at = ?
          WHERE id = ?
        `)
        .bind(completedAt, responseStatus, completedAt, job.id),
      env.DB
        .prepare(`
          UPDATE delivery_attempts
          SET completed_at = ?, response_status = ?
          WHERE id = ?
        `)
        .bind(completedAt, responseStatus, attemptId),
    ])
    return {}
  } catch (error) {
    const completedAt = Date.now()
    const message =
      error instanceof Error ? error.message.slice(0, 2_000) : "Delivery failed."
    const responseStatus =
      error &&
      typeof error === "object" &&
      "responseStatus" in error &&
      typeof error.responseStatus === "number"
        ? error.responseStatus
        : null
    const shouldRetry =
      job.attempt_count < retryDelays.length && !isTerminal(error)
    const retryDelaySeconds =
      retryDelays[Math.min(job.attempt_count, retryDelays.length - 1)]
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE delivery_jobs
          SET
            status = ?,
            available_at = ?,
            response_status = ?,
            last_error = ?,
            locked_at = NULL,
            updated_at = ?
          WHERE id = ?
        `)
        .bind(
          shouldRetry ? "retry" : "failed",
          completedAt + retryDelaySeconds * 1_000,
          responseStatus,
          message,
          completedAt,
          job.id
        ),
      env.DB
        .prepare(`
          UPDATE delivery_attempts
          SET completed_at = ?, response_status = ?, error = ?
          WHERE id = ?
        `)
        .bind(completedAt, responseStatus, message, attemptId),
    ])
    if (job.kind === "export" && job.target_id && !shouldRetry) {
      await env.DB
        .prepare(`
          UPDATE export_jobs
          SET status = 'failed', last_error = ?
          WHERE id = ?
        `)
        .bind(message, job.target_id)
        .run()
    }
    if (!shouldRetry) return {}
    return { retryDelaySeconds }
  }
}
