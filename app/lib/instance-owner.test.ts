import { describe, expect, it } from "vitest"
import { claimInstanceOwner, releaseInstanceOwnerClaim } from "./auth.server"

/**
 * Models the one property that matters: `instance_owner` holds at most one row,
 * and `ON CONFLICT DO NOTHING` reports zero changes to every later claimant.
 */
function fakeDb({ hasUser = false } = {}) {
  let claimed: { email: string | null } | null = null
  return {
    get claimed() {
      return claimed
    },
    prepare(sql: string) {
      if (sql.includes("INSERT INTO instance_owner")) {
        return {
          bind: (email: unknown) => ({
            run: async () => {
              if (claimed) return { meta: { changes: 0 } }
              claimed = { email: email as string | null }
              return { meta: { changes: 1 } }
            },
          }),
        }
      }
      if (sql.includes("DELETE FROM instance_owner")) {
        return {
          run: async () => {
            if (hasUser) return { meta: { changes: 0 } }
            const had = claimed !== null
            claimed = null
            return { meta: { changes: had ? 1 : 0 } }
          },
        }
      }
      throw new Error(`Unexpected statement: ${sql}`)
    },
  }
}

describe("initial administrator registration", () => {
  it("lets exactly one of many simultaneous claims win", async () => {
    const db = fakeDb()
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((name) =>
        claimInstanceOwner({
          database: db as unknown as D1Database,
          email: `${name}@example.com`,
        })
      )
    )

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(db.claimed).not.toBeNull()
  })

  it("refuses a later claim once the slot is taken", async () => {
    const db = fakeDb()
    const database = db as unknown as D1Database
    expect(await claimInstanceOwner({ database, email: "first@example.com" })).toBe(true)
    expect(await claimInstanceOwner({ database, email: "second@example.com" })).toBe(false)
  })

  it("releases the slot when the sign-up it reserved did not complete", async () => {
    const db = fakeDb()
    const database = db as unknown as D1Database
    await claimInstanceOwner({ database, email: "first@example.com" })
    await releaseInstanceOwnerClaim({ database })
    expect(db.claimed).toBeNull()
    expect(await claimInstanceOwner({ database, email: "retry@example.com" })).toBe(true)
  })

  it("keeps the claim when a user does exist", async () => {
    const db = fakeDb({ hasUser: true })
    const database = db as unknown as D1Database
    await claimInstanceOwner({ database, email: "owner@example.com" })
    await releaseInstanceOwnerClaim({ database })
    expect(db.claimed).not.toBeNull()
  })
})
