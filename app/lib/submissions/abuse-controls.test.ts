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
  it("accepts and discards a triggered submission", () => {
    const result = validateHoneypot({
      internal: { honeypot: "filled", uploadTokens: [] },
      config: {
        enabled: true,
        fieldName: "_fz_honeypot",
        response: "accept-and-discard",
      },
      receivedAt: Date.now(),
    })
    expect(result).toMatchObject({ triggered: true, discard: true })
  })
})
