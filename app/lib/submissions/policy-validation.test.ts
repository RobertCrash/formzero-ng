import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"
import { FormPolicyV1Schema } from "../form-config/schema"
import { SubmissionError } from "./errors"
import { parseSubmissionRequest } from "./parse-request.server"
import { validateAndNormalizeFields } from "./validate-fields"

describe("form policy schema", () => {
  it("accepts secure defaults", () => {
    expect(
      FormPolicyV1Schema.parse(createDefaultFormPolicy()).schemaVersion
    ).toBe(1)
  })

  it("rejects duplicate and reserved fields", () => {
    const policy = createDefaultFormPolicy()
    policy.fields = [
      { name: "email", type: "email", required: true },
      { name: "email", type: "string", required: false },
      { name: "_fz_secret", type: "string", required: false },
    ]
    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(false)
  })
})

describe("submission parsing and validation", () => {
  it("preserves repeated urlencoded values", async () => {
    const policy = createDefaultFormPolicy()
    policy.request.allowedContentTypes = ["application/x-www-form-urlencoded"]
    const parsed = await parseSubmissionRequest({
      request: new Request("https://example.com", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "interests=security&interests=privacy",
      }),
      policy,
    })
    expect(parsed.fields.interests).toEqual(["security", "privacy"])
  })

  it("normalizes values and reports per-field errors", () => {
    const rules = [
      { name: "email", type: "email" as const, required: true },
      {
        name: "age",
        type: "number" as const,
        required: true,
        minimum: 18,
      },
    ]
    expect(() =>
      validateAndNormalizeFields({
        values: { email: "invalid", age: "17" },
        files: {},
        rules,
        rejectUnknownFields: true,
      })
    ).toThrow(SubmissionError)

    try {
      validateAndNormalizeFields({
        values: { email: "invalid", age: "17" },
        files: {},
        rules,
        rejectUnknownFields: true,
      })
    } catch (error) {
      expect((error as SubmissionError).fields).toEqual({
        email: "Enter a valid email address.",
        age: "Must be at least 18.",
      })
    }
  })
})
