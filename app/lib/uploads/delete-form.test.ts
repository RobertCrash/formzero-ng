import { describe, expect, it, vi } from "vitest"
import { purgeDeletedForms, requestFormDeletion } from "./delete-form.server"

type Statement = { sql: string; values: unknown[] }

/**
 * Records statements and answers the handful of reads the purge performs, so the
 * batching behaviour can be asserted without a real D1.
 */
function fakeDb({
  form,
  files = [],
  exports: exportKeys = [],
}: {
  form: { id: string; deleted_at: number | null } | null
  files?: string[]
  exports?: string[]
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
      if (sql.includes("FROM submission_files")) {
        return { total: remainingFiles.length }
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
