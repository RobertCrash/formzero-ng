import { getSecret } from "../secrets/secret-store.server"
import { signWebhookPayload } from "./webhook-signature"

type WebhookEnv = {
  DB: D1Database
  FORMZERO_ENCRYPTION_KEY?: string
}

type WebhookJob = {
  id: string
  form_id: string
  submission_id: string
  target_id: string
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  )
}

function parseIpv6(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!normalized.includes(":")) return null
  const [leftRaw, rightRaw = ""] = normalized.split("::", 2)
  if (normalized.split("::").length > 2) return null
  const parsePart = (part: string) => {
    if (!part) return [] as number[]
    return part.split(":").flatMap((segment) => {
      if (segment.includes(".")) {
        const octets = segment.split(".").map(Number)
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) {
          return [Number.NaN]
        }
        return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return [Number.NaN]
      return [Number.parseInt(segment, 16)]
    })
  }
  const left = parsePart(leftRaw)
  const right = parsePart(rightRaw)
  if ([...left, ...right].some(Number.isNaN)) return null
  const missing = 8 - left.length - right.length
  if (
    missing < 0 ||
    (!normalized.includes("::") && missing !== 0) ||
    (normalized.includes("::") && missing < 1)
  ) {
    return null
  }
  return [...left, ...Array(missing).fill(0), ...right]
}

function isPrivateIpv6(hostname: string) {
  const segments = parseIpv6(hostname)
  if (!segments) return false
  const allZeroPrefix = segments.slice(0, 7).every((segment) => segment === 0)
  if (allZeroPrefix && (segments[7] === 0 || segments[7] === 1)) return true
  if ((segments[0] & 0xfe00) === 0xfc00) return true
  if ((segments[0] & 0xffc0) === 0xfe80) return true
  const mapped =
    segments.slice(0, 5).every((segment) => segment === 0) &&
    segments[5] === 0xffff
  if (mapped) {
    const ipv4 = [
      segments[6] >> 8,
      segments[6] & 0xff,
      segments[7] >> 8,
      segments[7] & 0xff,
    ].join(".")
    return isPrivateIpv4(ipv4)
  }
  return false
}

export function validateWebhookDestination(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:") {
    throw new Error("Webhook URLs must use HTTPS.")
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIpv6(hostname) ||
    isPrivateIpv4(hostname)
  ) {
    throw new Error("Webhook URLs cannot target local or private addresses.")
  }
  return url
}

export async function processWebhook(job: WebhookJob, env: WebhookEnv) {
  const webhook = await env.DB
    .prepare(`
      SELECT
        webhook.url,
        webhook.timeout_ms,
        webhook.secret_id,
        form.name AS form_name,
        submission.data,
        submission.created_at
      FROM form_webhooks AS webhook
      JOIN forms AS form ON form.id = webhook.form_id
      JOIN submissions AS submission ON submission.id = ?
      WHERE webhook.id = ?
        AND webhook.form_id = ?
        AND webhook.enabled = 1
    `)
    .bind(job.submission_id, job.target_id, job.form_id)
    .first<{
      url: string
      timeout_ms: number
      secret_id: string
      form_name: string
      data: string
      created_at: number
    }>()
  if (!webhook) throw new Error("Webhook target no longer exists.")
  if (!env.FORMZERO_ENCRYPTION_KEY) {
    throw new Error("FORMZERO_ENCRYPTION_KEY is not configured.")
  }
  const secret = await getSecret({
    db: env.DB,
    encryptionKey: env.FORMZERO_ENCRYPTION_KEY,
    secretId: webhook.secret_id,
  })
  if (!secret) throw new Error("Webhook signing secret is unavailable.")

  const files = await env.DB
    .prepare(`
      SELECT id, field_name, original_name, mime_type, size_bytes
      FROM submission_files
      WHERE submission_id = ?
        AND status = 'attached'
    `)
    .bind(job.submission_id)
    .all<{
      id: string
      field_name: string
      original_name: string
      mime_type: string
      size_bytes: number
    }>()
  const timestamp = Math.floor(Date.now() / 1_000)
  const body = JSON.stringify({
    id: `evt_${job.id}`,
    type: "submission.created",
    createdAt: new Date(webhook.created_at).toISOString(),
    form: { id: job.form_id, name: webhook.form_name },
    submission: {
      id: job.submission_id,
      createdAt: new Date(webhook.created_at).toISOString(),
      data: JSON.parse(webhook.data),
      files: files.results.map((file) => ({
        id: file.id,
        field: file.field_name,
        name: file.original_name,
        mimeType: file.mime_type,
        size: file.size_bytes,
      })),
    },
  })
  const signature = await signWebhookPayload({ secret, timestamp, body })
  const destination = validateWebhookDestination(webhook.url)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(webhook.timeout_ms, 1_000), 30_000)
  )

  try {
    const response = await fetch(destination, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "FormZero-Webhook/1.0",
        "FormZero-Signature": signature,
        "FormZero-Event": "submission.created",
        "FormZero-Delivery": job.id,
      },
      body,
    })
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Webhook redirects are not followed.")
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Webhook returned HTTP ${response.status}.`), {
        responseStatus: response.status,
      })
    }
    return { responseStatus: response.status }
  } finally {
    clearTimeout(timeout)
  }
}
