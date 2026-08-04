import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"
import { validateHoneypot } from "./validate-honeypot"
import { resolveCorsHeaders, validateOrigin } from "./validate-origin"
import { validateRedirectUrl } from "./validate-redirect"

describe("origin and redirect controls", () => {
  it("echoes only an allowed CORS origin", () => {
    const policy = createDefaultFormPolicy()
    policy.security.allowedOrigins = ["https://site.example"]
    const allowedRequest = new Request("https://forms.example", {
      headers: { Origin: "https://site.example" },
    })
    const deniedRequest = new Request("https://forms.example", {
      headers: { Origin: "https://evil.example" },
    })

    expect(
      resolveCorsHeaders(allowedRequest, policy.security).get(
        "Access-Control-Allow-Origin"
      )
    ).toBe("https://site.example")
    expect(
      resolveCorsHeaders(deniedRequest, policy.security).has(
        "Access-Control-Allow-Origin"
      )
    ).toBe(false)
    expect(() => validateOrigin(deniedRequest, policy.security)).toThrow()
  })

  it("rejects redirect schemes and unlisted origins", () => {
    const redirects = {
      allowedOrigins: ["https://site.example"],
      successUrl: "https://site.example/thanks",
    }
    expect(
      validateRedirectUrl("https://site.example/thanks", redirects)
    ).toBe("https://site.example/thanks")
    expect(validateRedirectUrl("https://evil.example", redirects)).toBeNull()
    expect(validateRedirectUrl("javascript:alert(1)", redirects)).toBeNull()
  })
})

describe("honeypot", () => {
  const timed = {
    enabled: true as const,
    fieldName: "_fz_honeypot",
    startedAtFieldName: "_fz_started_at",
    minimumFillTimeMs: 1_500,
    response: "accept-and-discard" as const,
  }
  const now = 1_700_000_000_000

  function check(startedAt: string | undefined, config = timed) {
    return validateHoneypot({
      internal: { startedAt, uploadTokens: [] },
      config,
      receivedAt: now,
    })
  }

  it("accepts and discards a triggered submission", () => {
    const result = validateHoneypot({
      internal: { honeypot: "filled", uploadTokens: [] },
      config: {
        enabled: true,
        fieldName: "_fz_honeypot",
        response: "accept-and-discard",
      },
      receivedAt: now,
    })
    expect(result).toMatchObject({ triggered: true, discard: true })
  })

  it("no longer lets an omitted timestamp skip the minimum fill time", () => {
    expect(check(undefined)).toMatchObject({
      triggered: true,
      minimumTimePassed: false,
    })
    expect(check("")).toMatchObject({ minimumTimePassed: false })
  })

  it("accepts a form that took long enough", () => {
    expect(check(String(now - 2_000))).toMatchObject({
      triggered: false,
      minimumTimePassed: true,
    })
  })

  it("rejects one that was submitted too fast", () => {
    expect(check(String(now - 100))).toMatchObject({ minimumTimePassed: false })
  })

  it("rejects timestamps that are not plausible clock readings", () => {
    expect(check("not-a-number")).toMatchObject({ minimumTimePassed: false })
    expect(check("1.5e3")).toMatchObject({ minimumTimePassed: false })
    // In the future, so no time can have elapsed.
    expect(check(String(now + 5_000))).toMatchObject({ minimumTimePassed: false })
    // Older than a day: a replayed body rather than a slow human.
    expect(check(String(now - 48 * 60 * 60 * 1_000))).toMatchObject({
      minimumTimePassed: false,
    })
  })

  it("treats a zero minimum as no minimum, for clients without JavaScript", () => {
    expect(check(undefined, { ...timed, minimumFillTimeMs: 0 })).toMatchObject({
      triggered: false,
      minimumTimePassed: undefined,
    })
  })
})
