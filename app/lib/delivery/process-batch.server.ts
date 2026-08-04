import { processDeliveryJob } from "./process-job.server"

export type DeliveryQueueMessage = {
  jobId: string
}

export const DELIVERY_QUEUE_NAME = "formzero-deliveries"
export const DELIVERY_DLQ_NAME = "formzero-deliveries-dlq"

type BatchEnv = {
  DB: D1Database
  EMAIL: SendEmail
  UPLOADS: R2Bucket
  FORMZERO_ENCRYPTION_KEY?: string
  FORMZERO_PUBLIC_URL?: string
}

/**
 * Records a delivery the queue has given up on.
 *
 * Cloudflare only sends a message here after `max_retries`, so there is nothing
 * left to attempt automatically. The row is marked failed and stamped, which is
 * what the dashboard shows and what the operator replays from.
 */
async function recordDeadLetters(
  batch: MessageBatch<DeliveryQueueMessage>,
  env: Pick<BatchEnv, "DB">
) {
  const now = Date.now()
  for (const message of batch.messages) {
    try {
      await env.DB
        .prepare(`
          UPDATE delivery_jobs
          SET
            status = 'failed',
            dead_lettered_at = ?,
            locked_at = NULL,
            last_error = COALESCE(last_error, 'Delivery exhausted its retries.'),
            updated_at = ?
          WHERE id = ?
        `)
        .bind(now, now, message.body.jobId)
        .run()
      // Structured so a dead letter is findable in Workers Logs by job id.
      console.error(
        "Delivery dead-lettered:",
        JSON.stringify({ jobId: message.body.jobId, attempts: message.attempts })
      )
    } catch (error) {
      console.error("Failed to record dead-lettered delivery:", error)
    }
    // Acked either way: retrying the DLQ message cannot make the delivery work,
    // and a message that keeps returning hides the ones behind it.
    message.ack()
  }
}

export async function processDeliveryBatch(
  batch: MessageBatch<DeliveryQueueMessage>,
  env: BatchEnv
) {
  if (batch.queue === DELIVERY_DLQ_NAME) {
    await recordDeadLetters(batch, env)
    return
  }

  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        const result = await processDeliveryJob(message.body.jobId, env)
        if (result.retryDelaySeconds !== undefined) {
          message.retry({ delaySeconds: result.retryDelaySeconds })
        } else {
          message.ack()
        }
      } catch (error) {
        console.error("Delivery queue processing failed:", error)
        try {
          const now = Date.now()
          await env.DB
            .prepare(`
              UPDATE delivery_jobs
              SET
                status = 'retry',
                available_at = ?,
                locked_at = NULL,
                last_error = ?,
                updated_at = ?
              WHERE id = ?
                AND status = 'processing'
            `)
            .bind(
              now + 60_000,
              error instanceof Error
                ? error.message.slice(0, 2_000)
                : "Unexpected queue processing failure.",
              now,
              message.body.jobId
            )
            .run()
        } catch (releaseError) {
          console.error("Failed to release delivery job claim:", releaseError)
        }
        message.retry({ delaySeconds: 60 })
      }
    })
  )
}
