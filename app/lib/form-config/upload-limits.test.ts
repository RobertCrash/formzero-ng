import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "./defaults"
import { FormPolicyV1Schema } from "./schema"
import {
  INLINE_MAX_TOTAL_BYTES,
  inlineRequestFloorBytes,
} from "./upload-limits"

function inlineUploadPolicy(
  overrides: Partial<ReturnType<typeof createDefaultFormPolicy>["uploads"]> = {}
) {
  const policy = createDefaultFormPolicy()
  policy.fields = [{ name: "resume", type: "file", required: false }]
  policy.request.allowedContentTypes = ["multipart/form-data"]
  policy.uploads = { ...policy.uploads, enabled: true, mode: "inline", ...overrides }
  return policy
}

describe("inline upload limits", () => {
  it("rejects the shipped default, where a 50 KB request cannot carry 25 MB of files", () => {
    const parsed = FormPolicyV1Schema.safeParse(inlineUploadPolicy())
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues[0].path).toEqual(["request", "maxPayloadBytes"])
  })

  it("accepts a request limit that covers the upload set plus overhead", () => {
    const policy = inlineUploadPolicy()
    policy.request.maxPayloadBytes = inlineRequestFloorBytes(policy.uploads)
    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(true)
  })

  it("rejects one byte below the floor", () => {
    const policy = inlineUploadPolicy()
    policy.request.maxPayloadBytes = inlineRequestFloorBytes(policy.uploads) - 1
    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(false)
  })

  it("caps inline totals well below the schema's 100 MB ceiling", () => {
    const policy = inlineUploadPolicy({
      maxFileBytes: 60_000_000,
      maxTotalBytes: 60_000_000,
    })
    policy.request.maxPayloadBytes = 100_000_000
    const parsed = FormPolicyV1Schema.safeParse(policy)
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues).toContainEqual(
      expect.objectContaining({ path: ["uploads", "maxTotalBytes"] })
    )
  })

  it("leaves direct mode free to use the full ceiling", () => {
    const policy = inlineUploadPolicy({
      mode: "direct",
      maxFileBytes: 60_000_000,
      maxTotalBytes: 60_000_000,
    })
    expect(policy.uploads.maxTotalBytes).toBeGreaterThan(INLINE_MAX_TOTAL_BYTES)
    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(true)
  })
})
