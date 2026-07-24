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
        message.retry({ delaySeconds: 60 })
      }
    })
  )
}
