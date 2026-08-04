import { describe, expect, it, vi } from "vitest"
import { processDeliveryJob } from "./process-job.server"

const mocks = vi.hoisted(() => ({
  processEmail: vi.fn(),
  processWebhook: vi.fn(),
  processExport: vi.fn(),
}))

vi.mock("./process-email.server", () => ({ processEmail: mocks.processEmail }))
vi.mock("./process-webhook.server", () => ({ processWebhook: mocks.processWebhook }))
vi.mock("./process-export.server", () => ({ processExport: mocks.processExport }))

function fakeEnv(deletedAt: number | null) {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({
          run: async () => {
            statements.push({ sql, values })
            return { meta: { changes: 1 } }
          },
          first: async () => {
            if (sql.includes("FROM forms")) return { deleted_at: deletedAt }
            return {
              id: "job-1",
              kind: "notification_email",
              form_id: "contact",
              submission_id: "sub-1",
              target_id: null,
              attempt_count: 1,
              config_snapshot: null,
            }
          },
        }),
      }
    },
    batch: async (prepared: unknown[]) => prepared.map(() => ({ meta: { changes: 1 } })),
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

describe("delivery for a deleted form", () => {
  it("fails the in-flight job instead of delivering the erased submission", async () => {
    const { env, statements } = fakeEnv(1_700_000_000_000)

    const result = await processDeliveryJob("job-1", env)

    expect(result).toEqual({})
    expect(mocks.processEmail).not.toHaveBeenCalled()
    expect(
      statements.some((entry) => entry.sql.includes("'Form was deleted.'"))
    ).toBe(true)
  })

  it("delivers normally while the form is live", async () => {
    mocks.processEmail.mockResolvedValue({ skipped: false })
    const { env } = fakeEnv(null)

    await processDeliveryJob("job-1", env)

    expect(mocks.processEmail).toHaveBeenCalledOnce()
  })
})
