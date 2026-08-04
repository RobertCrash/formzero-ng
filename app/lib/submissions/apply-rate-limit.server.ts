import type { RateLimitPolicy } from "../form-config/types"
import { assertBinding } from "../platform/check-bindings.server"
import { SubmissionError } from "./errors"

type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

type RateLimitEnv = {
  RATE_LIMIT_STRICT: RateLimitBinding
  RATE_LIMIT_STANDARD: RateLimitBinding
  RATE_LIMIT_RELAXED: RateLimitBinding
}

/**
 * Which bucket a request draws from.
 *
 * A direct upload is two requests — open a session, then submit — and both used
 * the same key, so each submission cost two tokens and a 5/min limit allowed
 * only two submissions. Separate scopes give the preparatory request its own
 * budget without weakening the limit on submissions themselves.
 */
export type RateLimitScope = "submission" | "upload-session"

export async function applyRateLimit({
  formId,
  sourceIpHash,
  config,
  env,
  scope = "submission",
}: {
  formId: string
  sourceIpHash: string | null
  config: RateLimitPolicy
  env: RateLimitEnv
  scope?: RateLimitScope
}) {
  if (!config.enabled) return { enabled: false as const }

  const binding =
    config.profile === "strict"
      ? assertBinding(env.RATE_LIMIT_STRICT, "RATE_LIMIT_STRICT")
      : config.profile === "standard"
        ? assertBinding(env.RATE_LIMIT_STANDARD, "RATE_LIMIT_STANDARD")
        : assertBinding(env.RATE_LIMIT_RELAXED, "RATE_LIMIT_RELAXED")

  if (!sourceIpHash) {
    throw new SubmissionError(
      "capability_unavailable",
      "Rate limiting requires IP_HASH_SECRET and a client IP address."
    )
  }
  const subject =
    config.key === "ip" ? `ip:${sourceIpHash}` : `${formId}:${sourceIpHash}`
  // The submission scope keeps the original key so existing counters carry over.
  const key = scope === "submission" ? subject : `${scope}:${subject}`
  const result = await binding.limit({ key })
  if (!result.success) {
    throw new SubmissionError(
      "rate_limit_exceeded",
      scope === "upload-session"
        ? "Too many upload requests. Try again later."
        : "Too many submissions. Try again later."
    )
  }

  return { enabled: true as const, profile: config.profile, scope }
}
