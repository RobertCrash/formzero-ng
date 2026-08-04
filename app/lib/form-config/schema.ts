import { z } from "zod"
import { describePatternProblem } from "../submissions/safe-pattern"
import { FIELD_TYPES } from "./types"
import {
  INLINE_MAX_TOTAL_BYTES,
  inlineRequestFloorBytes,
} from "./upload-limits"

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

const captchaSchema = z
  .discriminatedUnion("enabled", [
    z.object({ enabled: z.literal(false) }),
    z.object({
      enabled: z.literal(true),
      provider: z.literal("turnstile"),
      siteKey: z.string().min(1).max(200),
      /**
       * Which secret verification must use. Left undefined by policies written
       * before this field existed; those are read as "account" to match the
       * fallback they were saved under.
       */
      secretSource: z.enum(["form", "account"]).optional(),
      credentialId: z.string().min(1).max(200).optional(),
      expectedAction: z.string().min(1).max(100).optional(),
    }),
  ])
  .superRefine((captcha, ctx) => {
    // Whether a secret is *reachable* depends on env and cannot be judged here;
    // validatePolicyCapabilities does that. What is checkable is that the policy
    // does not name a per-form secret it never stored, which used to resolve by
    // silently borrowing the account secret instead.
    if (captcha.enabled && captcha.secretSource === "form" && !captcha.credentialId) {
      ctx.addIssue({
        code: "custom",
        path: ["credentialId"],
        message: "A form-owned Turnstile secret must be saved before it can be used.",
      })
    }
  })

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
        // Checked against the restricted matcher that will actually run it, not
        // against `new RegExp`, so a pattern cannot be saved that the submission
        // path would then reject at request time.
        const problem = describePatternProblem(field.pattern)
        if (problem) {
          ctx.addIssue({
            code: "custom",
            path: ["fields", index, "pattern"],
            message: problem,
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

    if (!policy.uploads.enabled) {
      // A required field that can never be supplied rejects every submission.
      for (const field of fileFields) {
        if (!field.required) continue
        ctx.addIssue({
          code: "custom",
          path: ["fields", policy.fields.indexOf(field), "required"],
          message:
            `"${field.name}" is a required file field, but uploads are ` +
            "disabled, so no submission could ever satisfy it.",
        })
      }
    }

    if (policy.uploads.enabled && fileFields.length > policy.uploads.maxFiles) {
      // Every single-file field needs its own slot, so a form with more file
      // fields than maxFiles cannot have them all filled in.
      ctx.addIssue({
        code: "custom",
        path: ["uploads", "maxFiles"],
        message:
          `The form has ${fileFields.length} file fields but allows only ` +
          `${policy.uploads.maxFiles} files per submission.`,
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

    if (policy.uploads.enabled && policy.uploads.mode === "inline") {
      // The request limit governs the whole multipart body, so an upload set
      // larger than it can never reach per-file validation.
      const floor = inlineRequestFloorBytes(policy.uploads)
      if (policy.request.maxPayloadBytes < floor) {
        ctx.addIssue({
          code: "custom",
          path: ["request", "maxPayloadBytes"],
          message:
            `Inline uploads of up to ${policy.uploads.maxTotalBytes} bytes in ` +
            `${policy.uploads.maxFiles} files need a request limit of at least ` +
            `${floor} bytes, including multipart overhead.`,
        })
      }
      if (policy.uploads.maxTotalBytes > INLINE_MAX_TOTAL_BYTES) {
        ctx.addIssue({
          code: "custom",
          path: ["uploads", "maxTotalBytes"],
          message:
            `Inline uploads are limited to ${INLINE_MAX_TOTAL_BYTES} bytes in ` +
            "total because the request body is parsed in the Worker. Use direct " +
            "upload mode for larger files.",
        })
      }
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
