import { describe, expect, it, vi } from "vitest"
import { applyRateLimit } from "./apply-rate-limit.server"

describe("rate-limit key selection", () => {
  it.each([
    ["ip", "ip:client-hash"],
    ["ip-and-form", "contact:client-hash"],
  ] as const)("uses only the configured %s key", async (key, expectedKey) => {
    const limit = vi.fn().mockResolvedValue({ success: true })

    await applyRateLimit({
      formId: "contact",
      sourceIpHash: "client-hash",
      config: { enabled: true, profile: "standard", key },
      env: {
        RATE_LIMIT_STRICT: { limit: vi.fn() },
        RATE_LIMIT_STANDARD: { limit },
        RATE_LIMIT_RELAXED: { limit: vi.fn() },
      },
    })

    expect(limit).toHaveBeenCalledOnce()
    expect(limit).toHaveBeenCalledWith({ key: expectedKey })
  })

  it("charges an upload session to its own bucket", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true })
    const env = {
      RATE_LIMIT_STRICT: { limit },
      RATE_LIMIT_STANDARD: { limit: vi.fn() },
      RATE_LIMIT_RELAXED: { limit: vi.fn() },
    }
    const config = { enabled: true, profile: "strict", key: "ip-and-form" } as const

    await applyRateLimit({
      formId: "contact",
      sourceIpHash: "client-hash",
      config,
      env,
      scope: "upload-session",
    })
    await applyRateLimit({
      formId: "contact",
      sourceIpHash: "client-hash",
      config,
      env,
    })

    // Two requests of one direct-upload submission, two distinct keys, so the
    // submission limit is charged once rather than twice.
    expect(limit.mock.calls.map(([input]) => input.key)).toEqual([
      "upload-session:contact:client-hash",
      "contact:client-hash",
    ])
  })

  it("says which limit was hit", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false })
    const error = await applyRateLimit({
      formId: "contact",
      sourceIpHash: "client-hash",
      config: { enabled: true, profile: "strict", key: "ip" },
      env: {
        RATE_LIMIT_STRICT: { limit },
        RATE_LIMIT_STANDARD: { limit: vi.fn() },
        RATE_LIMIT_RELAXED: { limit: vi.fn() },
      },
      scope: "upload-session",
    }).catch((thrown) => thrown)

    expect(error.message).toContain("upload requests")
  })
})
