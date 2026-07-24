import type { FormPolicyV1 } from "./types"

type CapabilityEnv = {
  UPLOADS?: R2Bucket
  DELIVERY_QUEUE?: Queue
  RATE_LIMIT_STRICT?: unknown
  RATE_LIMIT_STANDARD?: unknown
  RATE_LIMIT_RELAXED?: unknown
  TURNSTILE_SECRET?: string
  FORMZERO_ENCRYPTION_KEY?: string
  IP_HASH_SECRET?: string
}

export function getCapabilities(env: CapabilityEnv) {
  return {
    uploads: Boolean(env.UPLOADS),
    backgroundDelivery: Boolean(env.DELIVERY_QUEUE),
    rateLimiting: Boolean(
      env.RATE_LIMIT_STRICT &&
        env.RATE_LIMIT_STANDARD &&
        env.RATE_LIMIT_RELAXED
    ),
    turnstile:
      Boolean(env.TURNSTILE_SECRET) || Boolean(env.FORMZERO_ENCRYPTION_KEY),
    ipHashing: Boolean(env.IP_HASH_SECRET),
    scheduledMaintenance: true,
  }
}

export function validatePolicyCapabilities(
  policy: FormPolicyV1,
  env: CapabilityEnv
) {
  const capabilities = getCapabilities(env)
  const errors: string[] = []

  if (policy.uploads.enabled && !capabilities.uploads) {
    errors.push("Uploads require the UPLOADS R2 binding.")
  }
  if (policy.notifications.enabled && !capabilities.backgroundDelivery) {
    errors.push("Background delivery requires DELIVERY_QUEUE.")
  }
  if (policy.security.rateLimit.enabled && !capabilities.rateLimiting) {
    errors.push("Rate limiting requires all three rate-limit bindings.")
  }
  if (policy.security.captcha.enabled && !capabilities.turnstile) {
    errors.push("Turnstile requires a configured secret or encryption key.")
  }
  return { capabilities, errors }
}
