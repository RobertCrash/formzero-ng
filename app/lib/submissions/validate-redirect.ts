import type { FormPolicyV1 } from "../form-config/types"

export function validateRedirectUrl(
  value: string | undefined,
  policy: FormPolicyV1["redirects"],
  allowLocalhost = false
) {
  if (!value) return null

  try {
    const url = new URL(value)
    const isLocalhost =
      allowLocalhost &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
      return null
    }

    const allowed = policy.allowedOrigins.some((candidate) => {
      try {
        return new URL(candidate).origin === url.origin
      } catch {
        return false
      }
    })
    return allowed ? url.toString() : null
  } catch {
    return null
  }
}
