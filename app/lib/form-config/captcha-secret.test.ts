import { describe, expect, it } from "vitest"
import {
  getCapabilities,
  resolveCaptchaSecretSource,
  validatePolicyCapabilities,
} from "./capabilities.server"
import { createDefaultFormPolicy } from "./defaults"
import { FormPolicyV1Schema } from "./schema"
import type { CaptchaPolicy } from "./types"

const enabled = (extra: Partial<Extract<CaptchaPolicy, { enabled: true }>> = {}) =>
  ({
    enabled: true,
    provider: "turnstile",
    siteKey: "0x4AAA",
    ...extra,
  }) as CaptchaPolicy

const key = "00".repeat(32)

describe("Turnstile secret resolution", () => {
  it("does not treat the encryption key as a Turnstile secret", () => {
    const capabilities = getCapabilities({ FORMZERO_ENCRYPTION_KEY: key })
    expect(capabilities.turnstileAccountSecret).toBe(false)
    // The key still means a form *could* store its own secret.
    expect(capabilities.turnstile).toBe(true)

    const resolved = resolveCaptchaSecretSource(
      enabled({ secretSource: "form" }),
      { FORMZERO_ENCRYPTION_KEY: key }
    )
    expect(resolved.source).toBeNull()
  })

  it("refuses to borrow the account secret for a form-owned credential", () => {
    const resolved = resolveCaptchaSecretSource(
      enabled({ secretSource: "form", credentialId: "cred-1" }),
      { TURNSTILE_SECRET: "account-secret" }
    )
    expect(resolved.source).toBeNull()
    expect(resolved).toMatchObject({
      reason: expect.stringContaining("FORMZERO_ENCRYPTION_KEY"),
    })
  })

  it("reads a policy written before secretSource existed as using the account secret", () => {
    expect(
      resolveCaptchaSecretSource(enabled(), { TURNSTILE_SECRET: "s" }).source
    ).toBe("account")
    expect(
      resolveCaptchaSecretSource(enabled({ credentialId: "cred-1" }), {
        FORMZERO_ENCRYPTION_KEY: key,
      }).source
    ).toBe("form")
  })

  it("names the missing account secret", () => {
    const resolved = resolveCaptchaSecretSource(
      enabled({ secretSource: "account" }),
      {}
    )
    expect(resolved).toMatchObject({
      source: null,
      reason: expect.stringContaining("wrangler secret put TURNSTILE_SECRET"),
    })
  })
})

describe("policy validation", () => {
  function policyWithCaptcha(captcha: CaptchaPolicy) {
    const policy = createDefaultFormPolicy()
    policy.security.captcha = captcha
    return policy
  }

  it("rejects enabling a captcha that cannot verify anything", () => {
    const { errors } = validatePolicyCapabilities(
      policyWithCaptcha(enabled({ secretSource: "account" })),
      {}
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("Turnstile needs a secret")
  })

  it("accepts a captcha backed by the account secret", () => {
    const { errors } = validatePolicyCapabilities(
      policyWithCaptcha(enabled({ secretSource: "account" })),
      { TURNSTILE_SECRET: "s" }
    )
    expect(errors).toEqual([])
  })

  it("rejects a form-owned secret that was never saved", () => {
    const parsed = FormPolicyV1Schema.safeParse(
      policyWithCaptcha(enabled({ secretSource: "form" }))
    )
    expect(parsed.success).toBe(false)
    expect(parsed.error!.issues[0].message).toContain("must be saved")
  })

  it("still parses a legacy policy with no secretSource", () => {
    expect(
      FormPolicyV1Schema.safeParse(policyWithCaptcha(enabled())).success
    ).toBe(true)
  })
})
