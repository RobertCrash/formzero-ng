import type { RateLimitPolicy } from "../form-config/types"
import { SubmissionError } from "./errors"

type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

type RateLimitEnv = {
  RATE_LIMIT_STRICT?: RateLimitBinding
  RATE_LIMIT_STANDARD?: RateLimitBinding
  RATE_LIMIT_RELAXED?: RateLimitBinding
}

export async function applyRateLimit({
  formId,
  sourceIpHash,
  config,
  env,
}: {
  formId: string
  sourceIpHash: string | null
  config: RateLimitPolicy
  env: RateLimitEnv
}) {
  if (!config.enabled) return { enabled: false as const }

  const binding =
    config.profile === "strict"
      ? env.RATE_LIMIT_STRICT
      : config.profile === "standard"
        ? env.RATE_LIMIT_STANDARD
        : env.RATE_LIMIT_RELAXED

  if (!binding) {
    throw new SubmissionError(
      "capability_unavailable",
      `The ${config.profile} rate-limit binding is not configured.`
    )
  }

  if (!sourceIpHash) {
    throw new SubmissionError(
      "capability_unavailable",
      "Rate limiting requires IP_HASH_SECRET and a client IP address."
    )
  }
  const key =
    config.key === "ip"
      ? `ip:${sourceIpHash}`
      : `${formId}:${sourceIpHash}`
  const result = await binding.limit({ key })
  if (!result.success) {
    throw new SubmissionError(
      "rate_limit_exceeded",
      "Too many submissions. Try again later."
    )
  }

  return { enabled: true as const, profile: config.profile }
}
