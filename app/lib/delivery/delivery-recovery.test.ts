import { beforeEach, describe, expect, it, vi } from "vitest"

const processDeliveryJob = vi.hoisted(() => vi.fn())

vi.mock("./process-job.server", () => ({ processDeliveryJob }))

describe("queue recovery", () => {
  beforeEach(() => vi.clearAllMocks())

  it("releases a claimed job before retrying an unexpected failure", async () => {
    processDeliveryJob.mockRejectedValue(new Error("unexpected"))
    const sql: string[] = []
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const db = {
      prepare: vi.fn((query: string) => {
        sql.push(query)
        return { bind: vi.fn(() => ({ run })) }
      }),
    }
    const message = {
      body: { jobId: "job-1" },
      ack: vi.fn(),
      retry: vi.fn(),
    }
    const { processDeliveryBatch } = await import("./process-batch.server")

    await processDeliveryBatch(
      { messages: [message] } as never,
      { DB: db as never }
    )

    expect(sql.join("\n")).toContain("status = 'retry'")
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(message.ack).not.toHaveBeenCalled()
  })
})

describe("outbox draining", () => {
  it("publishes every available page in one maintenance pass", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `job-${index}`,
      kind: "webhook" as const,
      target_id: "webhook-1",
    }))
    const pages = [
      { results: firstPage },
      {
        results: [
          {
            id: "job-100",
            kind: "webhook" as const,
            target_id: "webhook-1",
          },
        ],
      },
    ]
    const all = vi.fn().mockImplementation(async () => pages.shift() ?? { results: [] })
    const db = {
      prepare: vi.fn((query: string) => {
        if (query.includes("SELECT id, kind, target_id")) {
          return { bind: vi.fn(() => ({ all })) }
        }
        return { bind: vi.fn(() => ({ query })) }
      }),
      batch: vi.fn().mockResolvedValue([]),
    }
    const sent: Array<{ body: { jobId: string } }> = []
    const queue = {
      send: vi.fn(),
      sendBatch: vi.fn(async (messages) => {
        sent.push(...messages)
      }),
    }
    const { publishPendingDeliveryJobs } = await import("./publish-jobs.server")

    const published = await publishPendingDeliveryJobs({
      db: db as never,
      queue,
      limit: 100,
    })

    expect(published).toBe(101)
    expect(sent).toHaveLength(101)
    expect(all).toHaveBeenCalledTimes(2)
  })
})
