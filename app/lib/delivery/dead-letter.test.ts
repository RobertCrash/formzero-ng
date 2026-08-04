import { describe, expect, it, vi } from "vitest"
import {
  DELIVERY_DLQ_NAME,
  DELIVERY_QUEUE_NAME,
  processDeliveryBatch,
  type DeliveryQueueMessage,
} from "./process-batch.server"

const mocks = vi.hoisted(() => ({ processDeliveryJob: vi.fn() }))

vi.mock("./process-job.server", () => ({
  processDeliveryJob: mocks.processDeliveryJob,
}))

function fakeBatch(queue: string, jobIds: string[]) {
  const messages = jobIds.map((jobId) => ({
    id: `msg-${jobId}`,
    timestamp: new Date(),
    attempts: 6,
    body: { jobId },
    ack: vi.fn(),
    retry: vi.fn(),
  }))
  return {
    batch: {
      queue,
      messages,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<DeliveryQueueMessage>,
    messages,
  }
}

function fakeEnv() {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({
          run: async () => {
            statements.push({ sql, values })
            return { meta: { changes: 1 } }
          },
        }),
      }
    },
  }
  return {
    statements,
    env: {
      DB: db as unknown as D1Database,
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
      UPLOADS: {} as R2Bucket,
    },
  }
}

describe("dead-letter consumer", () => {
  it("marks the delivery failed and stamps it, without attempting a send", async () => {
    const { batch, messages } = fakeBatch(DELIVERY_DLQ_NAME, ["job-1", "job-2"])
    const { statements, env } = fakeEnv()

    await processDeliveryBatch(batch, env)

    expect(mocks.processDeliveryJob).not.toHaveBeenCalled()
    expect(statements).toHaveLength(2)
    expect(statements[0].sql).toContain("dead_lettered_at = ?")
    expect(statements[0].values).toContain("job-1")
    // Retrying a dead letter cannot help, and would hide the messages behind it.
    expect(messages.every((message) => message.ack.mock.calls.length === 1)).toBe(true)
    expect(messages.every((message) => message.retry.mock.calls.length === 0)).toBe(true)
  })

  it("still processes normally on the main queue", async () => {
    mocks.processDeliveryJob.mockResolvedValue({})
    const { batch, messages } = fakeBatch(DELIVERY_QUEUE_NAME, ["job-3"])
    const { env } = fakeEnv()

    await processDeliveryBatch(batch, env)

    expect(mocks.processDeliveryJob).toHaveBeenCalledWith("job-3", env)
    expect(messages[0].ack).toHaveBeenCalledOnce()
  })
})
