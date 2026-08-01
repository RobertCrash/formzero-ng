import { processDeliveryJob } from "./process-job.server"

export type DeliveryQueueMessage = {
  jobId: string
}

export async function processDeliveryBatch(
  batch: MessageBatch<DeliveryQueueMessage>,
  env: {
    DB: D1Database
    FORMZERO_ENCRYPTION_KEY?: string
    FORMZERO_PUBLIC_URL?: string
    UPLOADS?: R2Bucket
  }
) {
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
