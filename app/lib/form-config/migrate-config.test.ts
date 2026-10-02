import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "./defaults"
import { migrateFormPolicy, repairFormPolicyV1 } from "./migrate-config"
import { FormPolicyV1Schema } from "./schema"
import { inlineRequestFloorBytes } from "./upload-limits"

describe("migrateFormPolicy repair", () => {
  it("raises an undersized inline request limit so stored policies still load", () => {
    const policy = createDefaultFormPolicy()
    policy.uploads.enabled = true
    policy.uploads.mode = "inline"
    policy.uploads.maxTotalBytes = 25_000_000
    policy.uploads.maxFiles = 5
    policy.request.maxPayloadBytes = 50_000
    policy.fields = [{ name: "resume", type: "file", required: false }]

    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(false)

    const migrated = migrateFormPolicy(policy, 1)
    expect(migrated.request.maxPayloadBytes).toBe(
      inlineRequestFloorBytes(migrated.uploads)
    )
    expect(migrated.request.allowedContentTypes).toContain("multipart/form-data")
  })

  it("drops patterns the restricted matcher cannot run", () => {
    const policy = createDefaultFormPolicy()
    policy.fields = [
      {
        name: "code",
        type: "string",
        required: false,
        pattern: "^(a+)+$",
      },
    ]

    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(false)

    const repaired = repairFormPolicyV1(policy) as typeof policy
    expect(repaired.fields[0].pattern).toBeUndefined()
    expect(migrateFormPolicy(policy, 1).fields[0].pattern).toBeUndefined()
  })

  it("keeps new saves strict after repair is applied only on load", () => {
    const policy = createDefaultFormPolicy()
    policy.uploads.enabled = true
    policy.uploads.mode = "inline"
    policy.request.maxPayloadBytes = 50_000
    policy.fields = [{ name: "resume", type: "file", required: false }]

    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(false)
    expect(migrateFormPolicy(policy, 1).schemaVersion).toBe(1)
  })
})
