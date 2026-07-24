import type { CaptchaPolicy } from "../form-config/types"
import { getSecret } from "../secrets/secret-store.server"
import { SubmissionError } from "./errors"

type TurnstileEnv = {
  DB: D1Database
  TURNSTILE_SECRET?: string
  FORMZERO_ENCRYPTION_KEY?: string
}

type TurnstileResponse = {
  success: boolean
  hostname?: string
  action?: string
  "error-codes"?: string[]
}

async function resolveTurnstileSecret(config: CaptchaPolicy, env: TurnstileEnv) {
  if (!config.enabled) return null
  if (
    config.credentialId &&
    env.FORMZERO_ENCRYPTION_KEY
  ) {
    return getSecret({
      db: env.DB,
      encryptionKey: env.FORMZERO_ENCRYPTION_KEY,
      secretId: config.credentialId,
    })
  }
  return env.TURNSTILE_SECRET ?? null
}

export async function verifyTurnstile({
  token,
  request,
  config,
  env,
  sourceIp,
}: {
  token?: string
  request: Request
  config: CaptchaPolicy
  env: TurnstileEnv
  sourceIp: string | null
}) {
  if (!config.enabled) return null
  if (!token) {
    throw new SubmissionError("captcha_failed", "CAPTCHA verification is required.")
  }

  const secret = await resolveTurnstileSecret(config, env)
  if (!secret) {
    throw new SubmissionError(
      "capability_unavailable",
      "Turnstile is enabled but its secret is not configured."
    )
  }

  const body = new FormData()
  body.set("secret", secret)
  body.set("response", token)
  body.set("idempotency_key", crypto.randomUUID())
  if (sourceIp) body.set("remoteip", sourceIp)

  let result: TurnstileResponse
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body }
    )
    if (!response.ok) throw new Error(`Siteverify returned ${response.status}`)
    result = await response.json<TurnstileResponse>()
  } catch {
    throw new SubmissionError(
      "captcha_failed",
      "CAPTCHA verification is temporarily unavailable."
    )
  }

  const expectedHostname = (() => {
    try {
      const origin = request.headers.get("Origin")
      return origin ? new URL(origin).hostname : null
    } catch {
      return null
    }
  })()

  if (
    !result.success ||
    (config.expectedAction && result.action !== config.expectedAction) ||
    (expectedHostname && result.hostname && result.hostname !== expectedHostname)
  ) {
    throw new SubmissionError("captcha_failed", "CAPTCHA verification failed.")
  }

  return {
    provider: "turnstile" as const,
    verified: true,
    hostname: result.hostname,
    action: result.action,
    errorCodes: result["error-codes"],
  }
}
