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

describe("Turnstile secret resolution", () => {
  it("treats Turnstile as always available to configure", () => {
    const capabilities = getCapabilities({})
    expect(capabilities.turnstileAccountSecret).toBe(false)
    expect(capabilities.turnstile).toBe(true)

    const resolved = resolveCaptchaSecretSource(
      enabled({ secretSource: "form" }),
      {}
    )
    expect(resolved.source).toBeNull()
  })

  it("uses the form-owned credential when credentialId is set", () => {
    const resolved = resolveCaptchaSecretSource(
      enabled({ secretSource: "form", credentialId: "cred-1" }),
      { TURNSTILE_SECRET: "account-secret" }
    )
    expect(resolved.source).toBe("form")
  })

  it("reads a policy written before secretSource existed as using the account secret", () => {
    expect(
      resolveCaptchaSecretSource(enabled(), { TURNSTILE_SECRET: "s" }).source
    ).toBe("account")
    expect(
      resolveCaptchaSecretSource(enabled({ credentialId: "cred-1" }), {}).source
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

  it("accepts rate limiting without a separate capability check", () => {
    const policy = createDefaultFormPolicy()
    policy.security.rateLimit = {
      enabled: true,
      profile: "standard",
      key: "ip-and-form",
    }
    const { errors } = validatePolicyCapabilities(policy, {})
    expect(errors).toEqual([])
  })

  it("allows secretSource in parsed policy JSON (not a credential value)", () => {
    const policy = policyWithCaptcha(
      enabled({ secretSource: "account" })
    )
    expect(FormPolicyV1Schema.safeParse(policy).success).toBe(true)
    const { errors } = validatePolicyCapabilities(policy, {
      TURNSTILE_SECRET: "s",
    })
    expect(errors).toEqual([])
  })
})
