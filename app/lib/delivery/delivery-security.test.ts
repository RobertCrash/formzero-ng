import { describe, expect, it, vi } from "vitest"
import { decryptSecret } from "../secrets/decrypt.server"
import { encryptSecret } from "../secrets/encrypt.server"
import { validateWebhookDestination } from "./process-webhook.server"
import { signWebhookPayload } from "./webhook-signature"
import { processDeliveryJob } from "./process-job.server"

describe("encrypted secrets", () => {
  it("round-trips with AES-GCM", async () => {
    const key = "00".repeat(32)
    const encrypted = await encryptSecret("top-secret", key)
    expect(encrypted).not.toContain("top-secret")
    await expect(decryptSecret(encrypted, key)).resolves.toBe("top-secret")
  })
})

describe("webhook security", () => {
  it("produces a timestamped HMAC signature", async () => {
    const signature = await signWebhookPayload({
      secret: "secret",
      timestamp: 123,
      body: '{"ok":true}',
    })
    expect(signature).toMatch(/^t=123,v1=[0-9a-f]{64}$/)
  })

  it("rejects local and private destinations", () => {
    expect(() => validateWebhookDestination("http://example.com")).toThrow()
    expect(() => validateWebhookDestination("https://localhost/hook")).toThrow()
    expect(() => validateWebhookDestination("https://192.168.1.2/hook")).toThrow()
    expect(() =>
      validateWebhookDestination("https://[::ffff:7f00:1]/hook")
    ).toThrow()
    expect(validateWebhookDestination("https://hooks.example.com").hostname).toBe(
      "hooks.example.com"
    )
    expect(validateWebhookDestination("https://fc.example.com").hostname).toBe(
      "fc.example.com"
    )
  })
})

describe("delivery idempotency", () => {
  it("acknowledges a duplicate job without sending it again", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } })
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ run }),
      }),
    }
    await expect(
      processDeliveryJob("duplicate", { DB: db as never })
    ).resolves.toEqual({})
    expect(run).toHaveBeenCalledOnce()
  })
})
