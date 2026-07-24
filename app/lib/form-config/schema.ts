import { z } from "zod"
import { FIELD_TYPES } from "./types"

const contentTypeSchema = z.enum([
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
])

export const FieldRuleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  label: z.string().max(200).optional(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  trim: z.boolean().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  pattern: z.string().max(1_000).optional(),
  options: z.array(z.string().max(500)).max(500).optional(),
})

const captchaSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    provider: z.literal("turnstile"),
    siteKey: z.string().min(1).max(200),
    credentialId: z.string().min(1).max(200).optional(),
    expectedAction: z.string().min(1).max(100).optional(),
  }),
])

const rateLimitSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    profile: z.enum(["strict", "standard", "relaxed"]),
    key: z.enum(["ip", "ip-and-form"]),
  }),
])

function isAbsoluteHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

function originOf(value: string) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export const FormPolicyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    fields: z.array(FieldRuleSchema).max(100),
    request: z.object({
      maxPayloadBytes: z.number().int().min(1_024).max(100_000_000),
      rejectUnknownFields: z.boolean(),
      allowedContentTypes: z.array(contentTypeSchema).min(1),
    }),
    security: z.object({
      allowedOrigins: z.array(z.string().refine(isAbsoluteHttpUrl)).max(100),
      allowMissingOrigin: z.boolean(),
      captcha: captchaSchema,
      honeypot: z.object({
        enabled: z.boolean(),
        fieldName: z.string().min(1).max(100),
        startedAtFieldName: z.string().min(1).max(100).optional(),
        minimumFillTimeMs: z.number().int().nonnegative().max(3_600_000).optional(),
        response: z.enum(["reject", "accept-and-discard"]),
      }),
      rateLimit: rateLimitSchema,
    }),
    privacy: z.object({
      ipMode: z.enum(["full", "hashed", "none"]),
      ipRetentionDays: z.number().int().positive().max(3_650).nullable(),
      storeUserAgent: z.boolean(),
      storeReferer: z.boolean(),
      geoPrecision: z.enum(["none", "country", "region"]),
    }),
    notifications: z.object({
      enabled: z.boolean(),
      recipients: z.array(z.email()).max(20),
      replyToField: z.string().optional(),
      subjectTemplate: z.string().max(500).optional(),
    }),
    uploads: z.object({
      enabled: z.boolean(),
      mode: z.enum(["inline", "direct"]),
      maxFiles: z.number().int().min(1).max(100),
      maxFileBytes: z.number().int().min(1).max(100_000_000),
      maxTotalBytes: z.number().int().min(1).max(100_000_000),
      allowedMimeTypes: z.array(z.string().min(1).max(200)).max(100),
      allowedExtensions: z.array(z.string().min(1).max(20)).max(100),
    }),
    retention: z.object({
      submissionsDays: z.number().int().positive().max(3_650).nullable(),
      filesDays: z.number().int().positive().max(3_650).nullable(),
    }),
    redirects: z.object({
      successUrl: z.string().refine(isAbsoluteHttpUrl).optional(),
      errorUrl: z.string().refine(isAbsoluteHttpUrl).optional(),
      allowedOrigins: z.array(z.string().refine(isAbsoluteHttpUrl)).max(100),
    }),
  })
  .superRefine((policy, ctx) => {
    const names = new Set<string>()

    for (const [index, field] of policy.fields.entries()) {
      if (field.name.startsWith("_fz_") || field.name === "cf-turnstile-response") {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "name"],
          message: "This field name is reserved by FormZero.",
        })
      }

      if (names.has(field.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "name"],
          message: "Field names must be unique.",
        })
      }
      names.add(field.name)

      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index],
          message: "Minimum length cannot exceed maximum length.",
        })
      }

      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index],
          message: "Minimum cannot exceed maximum.",
        })
      }

      if (field.pattern) {
        try {
          new RegExp(field.pattern)
        } catch {
          ctx.addIssue({
            code: "custom",
            path: ["fields", index, "pattern"],
            message: "Pattern must be a valid regular expression.",
          })
        }
      }

      if (field.type === "select" && (!field.options || field.options.length === 0)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", index, "options"],
          message: "Select fields require at least one option.",
        })
      }
    }

    if (policy.notifications.enabled && policy.notifications.recipients.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["notifications", "recipients"],
        message: "At least one recipient is required.",
      })
    }

    if (policy.notifications.replyToField) {
      const field = policy.fields.find(
        (candidate) => candidate.name === policy.notifications.replyToField
      )
      if (!field || field.type !== "email") {
        ctx.addIssue({
          code: "custom",
          path: ["notifications", "replyToField"],
          message: "Reply-to must reference a configured email field.",
        })
      }
    }

    const fileFields = policy.fields.filter(
      (field) => field.type === "file" || field.type === "files"
    )
    if (policy.uploads.enabled && fileFields.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["uploads", "enabled"],
        message: "Uploads require at least one file field.",
      })
    }

    if (
      policy.uploads.enabled &&
      policy.uploads.mode === "inline" &&
      !policy.request.allowedContentTypes.includes("multipart/form-data")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["request", "allowedContentTypes"],
        message: "Inline uploads require multipart/form-data.",
      })
    }

    if (policy.uploads.maxFileBytes > policy.uploads.maxTotalBytes) {
      ctx.addIssue({
        code: "custom",
        path: ["uploads", "maxFileBytes"],
        message: "Per-file limit cannot exceed the total upload limit.",
      })
    }

    const redirectOrigins = new Set(
      policy.redirects.allowedOrigins.map(originOf).filter(Boolean)
    )
    for (const [key, value] of [
      ["successUrl", policy.redirects.successUrl],
      ["errorUrl", policy.redirects.errorUrl],
    ] as const) {
      if (value && !redirectOrigins.has(originOf(value))) {
        ctx.addIssue({
          code: "custom",
          path: ["redirects", key],
          message: "Redirect URL must match an allowed redirect origin.",
        })
      }
    }
  })
