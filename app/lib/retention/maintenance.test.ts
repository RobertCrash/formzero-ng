import { beforeEach, describe, expect, it, vi } from "vitest"
import { runScheduledMaintenance } from "./run-scheduled-maintenance.server"

const mocks = vi.hoisted(() => ({
  publishPendingDeliveryJobs: vi.fn(),
  cleanupExpiredUploads: vi.fn(),
  countExpiredUploads: vi.fn(),
  cleanupOrphanedTemporaryObjects: vi.fn(),
  deleteSubmissionWithFiles: vi.fn(),
  purgeDeletedForms: vi.fn(),
  deleteExpiredSubmissions: vi.fn(),
  countExpiredSubmissions: vi.fn(),
  redactExpiredIps: vi.fn(),
}))

vi.mock("../delivery/publish-jobs.server", () => ({
  publishPendingDeliveryJobs: mocks.publishPendingDeliveryJobs,
}))
vi.mock("../uploads/cleanup-files.server", () => ({
  cleanupExpiredUploads: mocks.cleanupExpiredUploads,
  countExpiredUploads: mocks.countExpiredUploads,
  cleanupOrphanedTemporaryObjects: mocks.cleanupOrphanedTemporaryObjects,
}))
vi.mock("../uploads/delete-submission.server", () => ({
  deleteSubmissionWithFiles: mocks.deleteSubmissionWithFiles,
}))
vi.mock("../uploads/delete-form.server", () => ({
  purgeDeletedForms: mocks.purgeDeletedForms,
}))
vi.mock("./cleanup-expired.server", () => ({
  deleteExpiredSubmissions: mocks.deleteExpiredSubmissions,
  countExpiredSubmissions: mocks.countExpiredSubmissions,
  redactExpiredIps: mocks.redactExpiredIps,
}))

/** Records the maintenance_state writes so continuation can be asserted. */
function fakeEnv() {
  const savedState: Array<{ category: string; cursor: unknown; backlog: number }> = []
  const db = {
    prepare(sql: string) {
      const result = {
        first: async () => {
          if (sql.includes("FROM maintenance_state")) return null
          return { total: 0 }
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }
      return {
        ...result,
        bind: (...values: unknown[]) => {
          if (sql.includes("INSERT INTO maintenance_state")) {
            savedState.push({
              category: String(values[0]),
              cursor: values[1],
              backlog: Number(values[2]),
            })
          }
          return result
        },
      }
    },
  }
  return {
    savedState,
    env: {
      DB: db as unknown as D1Database,
      UPLOADS: { delete: vi.fn(), get: vi.fn(), list: vi.fn() } as unknown as R2Bucket,
      DELIVERY_QUEUE: { send: vi.fn() } as unknown as Queue<{ jobId: string }>,
    },
  }
}

describe("runScheduledMaintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.publishPendingDeliveryJobs.mockResolvedValue(0)
    mocks.redactExpiredIps.mockResolvedValue(0)
    mocks.cleanupExpiredUploads.mockResolvedValue(0)
    mocks.countExpiredUploads.mockResolvedValue(0)
    mocks.cleanupOrphanedTemporaryObjects.mockResolvedValue({
      deleted: 0,
      cursor: null,
      truncated: false,
    })
    mocks.deleteExpiredSubmissions.mockResolvedValue(0)
    mocks.countExpiredSubmissions.mockResolvedValue(0)
    mocks.purgeDeletedForms.mockResolvedValue({
      objectsRemoved: 0,
      formsRemoved: 0,
      backlog: 0,
    })
  })

  it("runs every category and reports each one", async () => {
    const { env } = fakeEnv()
    const report = await runScheduledMaintenance(env)

    expect(report.categories.map((entry) => entry.name)).toEqual([
      "delivery_locks",
      "delivery_publish",
      "ip_redaction",
      "deleted_forms",
      "expired_files",
      "orphaned_objects",
      "pending_deletes",
      "expired_submissions",
      "expired_exports",
    ])
    expect(report.categories.every((entry) => entry.status === "completed")).toBe(true)
  })

  it("keeps going after a category throws, and records why", async () => {
    const { env } = fakeEnv()
    mocks.cleanupExpiredUploads.mockRejectedValue(new Error("R2 unavailable"))

    const report = await runScheduledMaintenance(env)
    const byName = new Map(report.categories.map((entry) => [entry.name, entry]))

    expect(byName.get("expired_files")).toMatchObject({
      status: "failed",
      error: "R2 unavailable",
    })
    // The categories after the failure used to be skipped entirely.
    expect(byName.get("expired_submissions")!.status).toBe("completed")
    expect(byName.get("expired_exports")!.status).toBe("completed")
  })

  it("persists the R2 cursor so the next run resumes the sweep", async () => {
    const { env, savedState } = fakeEnv()
    mocks.cleanupOrphanedTemporaryObjects.mockResolvedValue({
      deleted: 500,
      cursor: "page-2",
      truncated: true,
    })

    const report = await runScheduledMaintenance(env)

    expect(savedState).toContainEqual({
      category: "orphaned_objects",
      cursor: "page-2",
      backlog: 1,
    })
    const entry = report.categories.find((item) => item.name === "orphaned_objects")
    expect(entry).toMatchObject({ processed: 500, backlog: 1 })
  })

  it("skips remaining categories once the budget is spent", async () => {
    const { env } = fakeEnv()
    mocks.publishPendingDeliveryJobs.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 60_000)
      return 0
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const report = await runScheduledMaintenance(env, { budgetMs: 1_000 })
    vi.useRealTimers()

    const skipped = report.categories.filter((entry) => entry.status === "skipped")
    expect(skipped.map((entry) => entry.name)).toEqual([
      "ip_redaction",
      "deleted_forms",
      "expired_files",
      "orphaned_objects",
      "pending_deletes",
      "expired_submissions",
      "expired_exports",
    ])
  })
})
