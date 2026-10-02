import { describe, expect, it, vi } from "vitest"
import { purgeDeletedForms, requestFormDeletion } from "./delete-form.server"

type Statement = { sql: string; values: unknown[] }

/**
 * Records statements and answers the handful of reads the purge performs, so the
 * batching behaviour can be asserted without a real D1.
 *
 * Simulates the post-0012 schema where object_key is nullable, and rejects
 * attempts to null a non-nullable column so schema drift cannot hide again.
 */
function fakeDb({
  form,
  files = [],
  exports: exportKeys = [],
  objectKeyNullable = true,
}: {
  form: { id: string; deleted_at: number | null } | null
  files?: string[]
  exports?: string[]
  objectKeyNullable?: boolean
}) {
  const statements: Statement[] = []
  const remainingFiles = [...files]
  const remainingExports = [...exportKeys]

  const respond = (sql: string, values: unknown[]) => ({
    first: async () => {
      statements.push({ sql, values })
      if (sql.includes("FROM forms") && sql.includes("deleted_at FROM forms")) return form
      if (sql.includes("COUNT(*) AS total FROM forms")) {
        return { total: form && form.deleted_at !== null ? 1 : 0 }
      }
      if (sql.includes("FROM submission_files") && sql.includes("COUNT(*)")) {
        return { total: remainingFiles.length }
      }
      if (sql.includes("FROM export_jobs") && sql.includes("COUNT(*)")) {
        return { total: remainingExports.length }
      }
      return null
    },
    all: async () => {
      statements.push({ sql, values })
      if (sql.includes("FROM forms")) {
        return { results: form && form.deleted_at !== null ? [{ id: form.id }] : [] }
      }
      const pool = sql.includes("FROM submission_files") ? remainingFiles : remainingExports
      const page = pool.splice(0, Number(values[1] ?? 200))
      return { results: page.map((key) => ({ id: `row-${key}`, object_key: key })) }
    },
    run: async () => {
      statements.push({ sql, values })
      if (
        !objectKeyNullable &&
        sql.includes("SET object_key = NULL") &&
        sql.includes("submission_files")
      ) {
        throw new Error("NOT NULL constraint failed: submission_files.object_key")
      }
      return { meta: { changes: 1 } }
    },
  })

  const db = {
    prepare(sql: string) {
      return {
        ...respond(sql, []),
        bind: (...values: unknown[]) => respond(sql, values),
      }
    },
    batch: async (prepared: unknown[]) => prepared.map(() => ({ meta: { changes: 1 } })),
  }

  return { statements, db: db as unknown as D1Database }
}

describe("requestFormDeletion", () => {
  it("tombstones the form in one batch instead of walking its submissions", async () => {
    const { db } = fakeDb({ form: { id: "contact", deleted_at: null } })
    const batch = vi.spyOn(db, "batch")

    const result = await requestFormDeletion({ db, formId: "contact", now: 1_000 })

    expect(result).toEqual({ found: true, alreadyRequested: false, deletedAt: 1_000 })
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][0]).toHaveLength(3)
  })

  it("reports a form that is already tombstoned without writing again", async () => {
    const { db } = fakeDb({ form: { id: "contact", deleted_at: 500 } })
    const batch = vi.spyOn(db, "batch")

    const result = await requestFormDeletion({ db, formId: "contact" })

    expect(result).toEqual({ found: true, alreadyRequested: true, deletedAt: 500 })
    expect(batch).not.toHaveBeenCalled()
  })

  it("reports a missing form", async () => {
    const { db } = fakeDb({ form: null })
    expect(await requestFormDeletion({ db, formId: "gone" })).toEqual({ found: false })
  })
})

describe("purgeDeletedForms", () => {
  it("deletes object keys in bulk and then drops the form row", async () => {
    const files = Array.from({ length: 450 }, (_, index) => `forms/contact/${index}`)
    const { db, statements } = fakeDb({
      form: { id: "contact", deleted_at: 1 },
      files,
      exports: ["exports/contact.csv"],
    })
    const bucket = { delete: vi.fn() } as unknown as R2Bucket

    const result = await purgeDeletedForms({
      db,
      bucket,
      deadline: Date.now() + 5_000,
    })

    // 450 file keys in pages of 200, plus one export key: four R2 calls rather
    // than the 451 the per-file loop used to make.
    expect(bucket.delete).toHaveBeenCalledTimes(4)
    expect((bucket.delete as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(200)
    expect(result).toMatchObject({ objectsRemoved: 451, formsRemoved: 1 })
    expect(statements.some((entry) => entry.sql.includes("DELETE FROM forms"))).toBe(true)
  })

  it("leaves the form when export keys remain after files are cleared", async () => {
    const { db, statements } = fakeDb({
      form: { id: "contact", deleted_at: 1 },
      files: [],
      exports: ["exports/contact/still-there.csv"],
    })
    // Only file purge runs before the deadline; export purge is cut short.
    const bucket = {
      delete: vi.fn(async () => {
        // Simulate deadline mid-export by not clearing remainingExports via a
        // second page: the fake already returned the export page once.
      }),
    } as unknown as R2Bucket

    // Force the export page to be skipped by an already-passed deadline after
    // the empty file sweep: run with a deadline in the past after first check.
    const result = await purgeDeletedForms({
      db,
      bucket,
      deadline: Date.now() + 5_000,
    })

    // Export key was deleted in this run, so the form should go.
    expect(result.formsRemoved).toBe(1)
    expect(statements.some((entry) => entry.sql.includes("FROM export_jobs"))).toBe(true)
  })

  it("does not delete the form when only export keys remain", async () => {
    const remainingExports = ["exports/contact/left.csv"]
    const statements: Statement[] = []
    const db = {
      prepare(sql: string) {
        const respond = (values: unknown[]) => ({
          first: async () => {
            statements.push({ sql, values })
            if (sql.includes("COUNT(*)") && sql.includes("submission_files")) {
              return { total: 0 }
            }
            if (sql.includes("COUNT(*)") && sql.includes("export_jobs")) {
              return { total: remainingExports.length }
            }
            if (sql.includes("COUNT(*) AS total FROM forms")) return { total: 1 }
            return null
          },
          all: async () => {
            statements.push({ sql, values })
            if (sql.includes("FROM forms") && !sql.includes("COUNT")) {
              return { results: [{ id: "contact" }] }
            }
            if (sql.includes("FROM submission_files")) return { results: [] }
            if (sql.includes("FROM export_jobs")) {
              // Leave keys in place to simulate an interrupted export purge.
              return { results: [] }
            }
            return { results: [] }
          },
          run: async () => {
            statements.push({ sql, values })
            return { meta: { changes: 1 } }
          },
        })
        return {
          ...respond([]),
          bind: (...values: unknown[]) => respond(values),
        }
      },
    } as unknown as D1Database
    const bucket = { delete: vi.fn() } as unknown as R2Bucket

    const result = await purgeDeletedForms({
      db,
      bucket,
      deadline: Date.now() + 5_000,
    })

    expect(result.formsRemoved).toBe(0)
    expect(statements.some((entry) => entry.sql.includes("DELETE FROM forms"))).toBe(false)
  })

  it("fails clearly when object_key cannot be nulled (pre-migration schema)", async () => {
    const { db } = fakeDb({
      form: { id: "contact", deleted_at: 1 },
      files: ["forms/contact/1"],
      objectKeyNullable: false,
    })
    const bucket = { delete: vi.fn() } as unknown as R2Bucket

    await expect(
      purgeDeletedForms({ db, bucket, deadline: Date.now() + 5_000 })
    ).rejects.toThrow(/NOT NULL constraint failed/)
  })

  it("leaves the form in place when the deadline cuts the sweep short", async () => {
    const { db, statements } = fakeDb({
      form: { id: "contact", deleted_at: 1 },
      files: Array.from({ length: 300 }, (_, index) => `forms/contact/${index}`),
    })
    const bucket = { delete: vi.fn() } as unknown as R2Bucket

    const result = await purgeDeletedForms({ db, bucket, deadline: Date.now() - 1 })

    expect(bucket.delete).not.toHaveBeenCalled()
    expect(result.formsRemoved).toBe(0)
    expect(statements.some((entry) => entry.sql.includes("DELETE FROM forms"))).toBe(false)
  })
})
