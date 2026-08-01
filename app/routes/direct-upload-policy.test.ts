import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDefaultFormPolicy } from "~/lib/form-config/defaults"

const loadFormWithPolicy = vi.hoisted(() => vi.fn())

vi.mock("~/lib/form-config/load-form-policy.server", () => ({
  loadFormWithPolicy,
}))

describe("direct-upload policy enforcement", () => {
  beforeEach(() => {
    const policy = createDefaultFormPolicy()
    policy.security.allowMissingOrigin = true
    policy.uploads = {
      enabled: true,
      mode: "direct",
      maxFiles: 2,
      maxFileBytes: 1_000,
      maxTotalBytes: 2_000,
      allowedMimeTypes: ["application/pdf"],
      allowedExtensions: [".pdf"],
    }
    policy.fields = [
      { name: "attachment", type: "file", required: true },
    ]
    loadFormWithPolicy.mockResolvedValue({
      id: "contact",
      name: "Contact",
      configSchemaVersion: 1,
      configRevision: 1,
      policy,
    })
  })

  it("rejects a filename with a disallowed extension", async () => {
    const batch = vi.fn().mockResolvedValue([])
    const { action } = await import("./api.forms.$formId.uploads")
    const result = await action({
      request: new Request("https://example.com/api/forms/contact/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [
            {
              field: "attachment",
              name: "payload.exe",
              type: "application/pdf",
              size: 100,
            },
          ],
        }),
      }),
      params: { formId: "contact" },
      context: {
        cloudflare: {
          env: { DB: { batch } },
        },
      },
    } as never)

    expect(result.init?.status).toBe(400)
    expect(batch).not.toHaveBeenCalled()
  })
})
