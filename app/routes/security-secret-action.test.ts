import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDefaultFormPolicy } from "~/lib/form-config/defaults"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  loadFormWithPolicy: vi.fn(),
  putSecret: vi.fn(),
  deleteSecret: vi.fn(),
  savePolicyRequest: vi.fn(),
}))

vi.mock("~/lib/require-auth.server", () => ({
  requireAuth: mocks.requireAuth,
}))
vi.mock("~/lib/form-config/load-form-policy.server", () => ({
  loadFormWithPolicy: mocks.loadFormWithPolicy,
}))
vi.mock("~/lib/secrets/secret-store.server", () => ({
  putSecret: mocks.putSecret,
  deleteSecret: mocks.deleteSecret,
}))
vi.mock("~/lib/form-config/settings.server", () => ({
  savePolicyRequest: mocks.savePolicyRequest,
}))

function actionRequest(credentialId = "attacker-controlled-secret") {
  const policy = createDefaultFormPolicy()
  policy.security.captcha = {
    enabled: true,
    provider: "turnstile",
    siteKey: "site-key",
    credentialId,
  }
  const body = new FormData()
  body.set("revision", "3")
  body.set("policy", JSON.stringify(policy))
  body.set("turnstile_secret", "replacement-secret")
  return new Request("https://example.com/forms/contact/settings/security", {
    method: "POST",
    body,
  })
}

describe("Turnstile secret action", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ id: "owner" })
    const policy = createDefaultFormPolicy()
    policy.security.captcha = {
      enabled: true,
      provider: "turnstile",
      siteKey: "site-key",
      credentialId: "server-owned-secret",
    }
    mocks.loadFormWithPolicy.mockResolvedValue({
      id: "contact",
      name: "Contact",
      configRevision: 3,
      configSchemaVersion: 1,
      policy,
    })
    mocks.putSecret.mockResolvedValue("new-secret")
    mocks.savePolicyRequest.mockResolvedValue({
      data: { success: false, conflict: true },
      init: { status: 409 },
    })
  })

  it("authenticates before creating any secret", async () => {
    mocks.requireAuth.mockRejectedValue(new Response("Unauthorized", { status: 401 }))
    const { action } = await import("./forms.$formId.settings.security")

    await expect(
      action({
        request: actionRequest(),
        params: { formId: "contact" },
        context: {
          cloudflare: {
            env: {
              DB: {},
              FORMZERO_ENCRYPTION_KEY: "00".repeat(32),
            },
          },
        },
      } as never)
    ).rejects.toBeInstanceOf(Response)
    expect(mocks.putSecret).not.toHaveBeenCalled()
  })

  it("uses a new secret ID and cleans it up when policy saving conflicts", async () => {
    const { action } = await import("./forms.$formId.settings.security")
    const result = await action({
      request: actionRequest(),
      params: { formId: "contact" },
      context: {
        cloudflare: {
          env: {
            DB: {},
            FORMZERO_ENCRYPTION_KEY: "00".repeat(32),
          },
        },
      },
    } as never)

    expect(result.init?.status).toBe(409)
    expect(mocks.putSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: "contact",
        purpose: "turnstile_secret",
        secretId: undefined,
      })
    )
    expect(mocks.deleteSecret).toHaveBeenCalledWith({}, "new-secret")
  })
})
