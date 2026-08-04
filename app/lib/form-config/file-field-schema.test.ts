import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "./defaults"
import { FormPolicyV1Schema } from "./schema"
import { inlineRequestFloorBytes } from "./upload-limits"

function policyWithFields(
  fields: Array<{ name: string; type: "file" | "files"; required: boolean }>,
  uploads: Partial<ReturnType<typeof createDefaultFormPolicy>["uploads"]> = {}
) {
  const policy = createDefaultFormPolicy()
  policy.fields = fields
  policy.uploads = { ...policy.uploads, ...uploads }
  if (policy.uploads.enabled && policy.uploads.mode === "inline") {
    policy.request.allowedContentTypes = ["multipart/form-data"]
    policy.request.maxPayloadBytes = inlineRequestFloorBytes(policy.uploads)
  }
  return policy
}

describe("file fields and upload settings", () => {
  it("rejects a required file field while uploads are disabled", () => {
    const parsed = FormPolicyV1Schema.safeParse(
      policyWithFields([{ name: "resume", type: "file", required: true }])
    )
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues[0].message).toContain("uploads are disabled")
  })

  it("allows an optional file field while uploads are disabled", () => {
    expect(
      FormPolicyV1Schema.safeParse(
        policyWithFields([{ name: "resume", type: "file", required: false }])
      ).success
    ).toBe(true)
  })

  it("rejects more file fields than a submission may carry files", () => {
    const parsed = FormPolicyV1Schema.safeParse(
      policyWithFields(
        [
          { name: "a", type: "file", required: false },
          { name: "b", type: "file", required: false },
          { name: "c", type: "file", required: false },
        ],
        { enabled: true, maxFiles: 2 }
      )
    )
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues).toContainEqual(
      expect.objectContaining({ path: ["uploads", "maxFiles"] })
    )
  })

  it("accepts as many file fields as maxFiles", () => {
    expect(
      FormPolicyV1Schema.safeParse(
        policyWithFields(
          [
            { name: "a", type: "file", required: false },
            { name: "b", type: "file", required: false },
          ],
          { enabled: true, maxFiles: 2 }
        )
      ).success
    ).toBe(true)
  })
})
