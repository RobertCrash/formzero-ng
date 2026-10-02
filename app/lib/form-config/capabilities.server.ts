import type { FormPolicyV1 } from "./types"

/**
 * Capabilities describe what is *configured*, never what is *bound*.
 *
 * Every binding declared in wrangler.jsonc is guaranteed present at runtime, so
 * a missing binding is a deployment fault surfaced by checkPlatformBindings —
 * not a feature the operator chose to leave off. What genuinely varies is
 * optional secrets (TURNSTILE_SECRET) and stored configuration.
 *
 * FORMZERO_ENCRYPTION_KEY and FORMZERO_HASH_SECRET are required on AppEnv, so
 * credential encryption, form-owned Turnstile secrets, and rate limiting are
 * always available — they are not capability flags.
 */
type CapabilityEnv = {
  TURNSTILE_SECRET?: string
}

export type Capabilities = {
  /** An account-wide TURNSTILE_SECRET any form can verify against. */
  turnstileAccountSecret: boolean
  /** Whether Turnstile can be set up at all (always true: form secrets are storable). */
  turnstile: boolean
  scheduledMaintenance: boolean
  emailTransport: boolean
}

export function getCapabilities(
  env: CapabilityEnv,
  options: { emailTransport?: boolean } = {}
): Capabilities {
  const turnstileAccountSecret = Boolean(env.TURNSTILE_SECRET)
  return {
    turnstileAccountSecret,
    // Form-owned secrets are always storable (FORMZERO_ENCRYPTION_KEY is required).
    // Whether a given form actually has one is checked per policy below.
    turnstile: true,
    scheduledMaintenance: true,
    emailTransport: options.emailTransport ?? false,
  }
}

/**
 * The secret an enabled captcha will actually verify against, or why there is
 * none. Kept beside the capability check so the settings UI, the save path and
 * verify-turnstile.server.ts cannot drift apart on the resolution rule.
 */
export function resolveCaptchaSecretSource(
  captcha: FormPolicyV1["security"]["captcha"],
  env: CapabilityEnv
): { source: "form" | "account" } | { source: null; reason: string } {
  if (!captcha.enabled) return { source: null, reason: "Turnstile is disabled." }

  // An absent secretSource is a pre-existing policy, saved when the only
  // behaviour was to fall back to the account secret.
  const intended = captcha.secretSource ?? (captcha.credentialId ? "form" : "account")

  if (intended === "form") {
    if (!captcha.credentialId) {
      return {
        source: null,
        reason: "Turnstile is set to use a form-owned secret, but none is saved.",
      }
    }
    return { source: "form" }
  }

  if (!env.TURNSTILE_SECRET) {
    return {
      source: null,
      reason:
        "Turnstile needs a secret. Enter one for this form, or set the " +
        "account-wide TURNSTILE_SECRET with `wrangler secret put TURNSTILE_SECRET`.",
    }
  }
  return { source: "account" }
}

export function validatePolicyCapabilities(
  policy: FormPolicyV1,
  env: CapabilityEnv,
  options: { emailTransport?: boolean } = {}
) {
  const capabilities = getCapabilities(env, options)
  const errors: string[] = []

  if (policy.notifications.enabled && !capabilities.emailTransport) {
    errors.push(
      "Email notifications need a configured transport. Open global " +
        "notification settings and choose Cloudflare Email Service or custom SMTP."
    )
  }
  if (policy.security.captcha.enabled) {
    // Saving an enabled captcha with no reachable secret used to succeed and
    // then reject every submission at verification time.
    const resolved = resolveCaptchaSecretSource(policy.security.captcha, env)
    if (resolved.source === null) errors.push(resolved.reason)
  }
  return { capabilities, errors }
}
