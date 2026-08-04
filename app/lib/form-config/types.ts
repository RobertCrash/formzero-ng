export const FIELD_TYPES = [
  "string",
  "email",
  "url",
  "tel",
  "number",
  "boolean",
  "date",
  "datetime",
  "select",
  "string-array",
  "file",
  "files",
] as const

export type FieldType = (typeof FIELD_TYPES)[number]

export type FieldRule = {
  name: string
  label?: string
  type: FieldType
  required: boolean
  trim?: boolean
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
  options?: string[]
}

export type CaptchaPolicy =
  | { enabled: false }
  | {
      enabled: true
      provider: "turnstile"
      siteKey: string
      /** Undefined in policies written before the field existed; read as "account". */
      secretSource?: "form" | "account"
      credentialId?: string
      expectedAction?: string
    }

export type RateLimitPolicy =
  | { enabled: false }
  | {
      enabled: true
      profile: "strict" | "standard" | "relaxed"
      key: "ip" | "ip-and-form"
    }

export type FormPolicyV1 = {
  schemaVersion: 1
  fields: FieldRule[]
  request: {
    maxPayloadBytes: number
    rejectUnknownFields: boolean
    allowedContentTypes: Array<
      | "application/json"
      | "application/x-www-form-urlencoded"
      | "multipart/form-data"
    >
  }
  security: {
    allowedOrigins: string[]
    allowMissingOrigin: boolean
    captcha: CaptchaPolicy
    honeypot: {
      enabled: boolean
      fieldName: string
      startedAtFieldName?: string
      minimumFillTimeMs?: number
      response: "reject" | "accept-and-discard"
    }
    rateLimit: RateLimitPolicy
  }
  privacy: {
    ipMode: "full" | "hashed" | "none"
    ipRetentionDays: number | null
    storeUserAgent: boolean
    storeReferer: boolean
    geoPrecision: "none" | "country" | "region"
  }
  notifications: {
    enabled: boolean
    recipients: string[]
    replyToField?: string
    subjectTemplate?: string
  }
  uploads: {
    enabled: boolean
    mode: "inline" | "direct"
    maxFiles: number
    maxFileBytes: number
    maxTotalBytes: number
    allowedMimeTypes: string[]
    allowedExtensions: string[]
  }
  retention: {
    submissionsDays: number | null
    filesDays: number | null
  }
  redirects: {
    successUrl?: string
    errorUrl?: string
    allowedOrigins: string[]
  }
}

export type FormWithPolicy = {
  id: string
  name: string
  configSchemaVersion: number
  configRevision: number
  policy: FormPolicyV1
}
