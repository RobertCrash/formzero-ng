import type { FormPolicyV1 } from "./types"

const sharedDefaults = {
  schemaVersion: 1,
  fields: [],
  request: {
    maxPayloadBytes: 50_000,
    rejectUnknownFields: true,
    allowedContentTypes: [
      "application/json",
      "application/x-www-form-urlencoded",
    ],
  },
  security: {
    allowedOrigins: [],
    allowMissingOrigin: false,
    captcha: { enabled: false },
    honeypot: {
      enabled: true,
      fieldName: "_fz_honeypot",
      startedAtFieldName: "_fz_started_at",
      minimumFillTimeMs: 1_500,
      response: "accept-and-discard",
    },
    rateLimit: { enabled: false },
  },
  privacy: {
    ipMode: "full",
    ipRetentionDays: 30,
    storeUserAgent: true,
    storeReferer: true,
    geoPrecision: "country",
  },
  notifications: {
    enabled: false,
    recipients: [],
  },
  uploads: {
    enabled: false,
    mode: "inline",
    maxFiles: 5,
    maxFileBytes: 10_000_000,
    maxTotalBytes: 25_000_000,
    allowedMimeTypes: [],
    allowedExtensions: [],
  },
  retention: {
    submissionsDays: null,
    filesDays: null,
  },
  redirects: {
    allowedOrigins: [],
  },
} as const

export function createDefaultFormPolicy(): FormPolicyV1 {
  return structuredClone(sharedDefaults) as unknown as FormPolicyV1
}

export function createLegacyFormPolicy(): FormPolicyV1 {
  const policy = createDefaultFormPolicy()
  policy.request.rejectUnknownFields = false
  policy.security.allowMissingOrigin = true
  policy.security.honeypot.enabled = false
  return policy
}
