import type { FormPolicyV1 } from "../form-config/types"

type ContextEnv = {
  IP_HASH_SECRET?: string
}

function toHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export async function createIpHmac(value: string, secret: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
}

export async function buildSubmissionContext({
  request,
  env,
  policy,
  receivedAt,
}: {
  request: Request
  env: ContextEnv
  policy: FormPolicyV1
  receivedAt: number
}) {
  const cf = (
    request as Request & {
      cf?: {
        country?: string
        colo?: string
        continent?: string
        regionCode?: string
        timezone?: string
        asn?: number
        asOrganization?: string
        httpProtocol?: string
        tlsVersion?: string
      }
    }
  ).cf
  const observedIp = request.headers.get("CF-Connecting-IP")
  const sourceIpHash =
    observedIp && env.IP_HASH_SECRET
      ? await createIpHmac(observedIp, env.IP_HASH_SECRET)
      : null
  const rawContentLength = request.headers.get("Content-Length")
  const contentLength =
    rawContentLength && /^\d+$/.test(rawContentLength)
      ? Number(rawContentLength)
      : null

  return {
    observedIp,
    rateLimitIpHash: sourceIpHash,
    core: {
      requestId: crypto.randomUUID(),
      createdAt: receivedAt,
      sourceIp: policy.privacy.ipMode === "full" ? observedIp : null,
      sourceIpHash:
        policy.privacy.ipMode === "none" ? null : sourceIpHash,
      origin: request.headers.get("Origin"),
      countryCode:
        policy.privacy.geoPrecision === "none"
          ? null
          : cf?.country ?? request.headers.get("CF-IPCountry"),
      cfRay: request.headers.get("CF-Ray"),
      userAgent: policy.privacy.storeUserAgent
        ? request.headers.get("User-Agent")
        : null,
    },
    metadata: {
      schemaVersion: 1,
      request: {
        method: request.method,
        contentType: request.headers.get("Content-Type"),
        contentLength,
        userAgent: policy.privacy.storeUserAgent
          ? request.headers.get("User-Agent")
          : null,
        referer: policy.privacy.storeReferer
          ? request.headers.get("Referer")
          : null,
        acceptLanguage: request.headers.get("Accept-Language"),
      },
      cloudflare: {
        colo: cf?.colo,
        continent: cf?.continent,
        regionCode:
          policy.privacy.geoPrecision === "region" ? cf?.regionCode : undefined,
        timezone: cf?.timezone,
        asn: cf?.asn,
        asOrganization: cf?.asOrganization,
        httpProtocol: cf?.httpProtocol,
        tlsVersion: cf?.tlsVersion,
      },
      security: {} as Record<string, unknown>,
      payload: {
        encoding: "json" as "json" | "urlencoded" | "multipart",
        payloadBytes: 0,
        fieldCount: 0,
        fileCount: 0,
        totalFileBytes: 0,
      },
      processing: {
        processingDurationMs: 0,
      },
    },
  }
}

export type BuiltSubmissionContext = Awaited<
  ReturnType<typeof buildSubmissionContext>
>
