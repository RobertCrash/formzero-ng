import { resolveCaptchaSecretSource } from "../form-config/capabilities.server"
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

/**
 * Resolves the secret the policy names, and only that one.
 *
 * An unreadable form-owned secret used to fall through to the account secret,
 * so a form could verify against a credential its owner never configured.
 */
async function resolveTurnstileSecret(config: CaptchaPolicy, env: TurnstileEnv) {
  const resolved = resolveCaptchaSecretSource(config, env)
  if (resolved.source === null) return { secret: null, reason: resolved.reason }

  if (resolved.source === "account") {
    return { secret: env.TURNSTILE_SECRET!, reason: null }
  }

  const secret = await getSecret({
    db: env.DB,
    encryptionKey: env.FORMZERO_ENCRYPTION_KEY!,
    // resolveCaptchaSecretSource returns "form" only with a credentialId set.
    secretId: (config as { credentialId: string }).credentialId,
  })
  return secret
    ? { secret, reason: null }
    : {
        secret: null,
        reason:
          "The stored Turnstile secret could not be read. Re-enter it in the " +
          "form's security settings.",
      }
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

  const { secret, reason } = await resolveTurnstileSecret(config, env)
  if (!secret) {
    // A misconfiguration, not a failed challenge: say so in the log while the
    // public response stays generic.
    console.error(`Turnstile verification could not run: ${reason}`)
    throw new SubmissionError("capability_unavailable", reason!)
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
