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
        RATE_LIMIT_STANDARD: { limit },
      },
    })

    expect(limit).toHaveBeenCalledOnce()
    expect(limit).toHaveBeenCalledWith({ key: expectedKey })
  })
})
