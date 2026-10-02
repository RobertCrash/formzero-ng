import { describePatternProblem } from "../submissions/safe-pattern"
import {
  INLINE_MAX_TOTAL_BYTES,
  inlineRequestFloorBytes,
} from "./upload-limits"
import { FormPolicyV1Schema } from "./schema"
import type { FormPolicyV1 } from "./types"

/**
 * Coerce stored schema-v1 policies that were valid under older, looser rules
 * into something the current schema accepts.
 *
 * Stricter validation must not leave already-saved forms unloadable (and
 * therefore unrepairable) through the dashboard. New saves still go through
 * FormPolicyV1Schema directly and remain strict.
 */
export function repairFormPolicyV1(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value

  const policy = structuredClone(value) as Record<string, unknown>
  const uploads = policy.uploads as Record<string, unknown> | undefined
  const request = policy.request as Record<string, unknown> | undefined
  const fields = policy.fields

  if (Array.isArray(fields)) {
    for (const entry of fields) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const field = entry as Record<string, unknown>
      if (typeof field.pattern === "string") {
        const problem = describePatternProblem(field.pattern)
        if (problem) delete field.pattern
      }
    }
  }

  if (
    uploads &&
    uploads.enabled === true &&
    uploads.mode === "inline" &&
    typeof uploads.maxTotalBytes === "number" &&
    typeof uploads.maxFiles === "number"
  ) {
    if (uploads.maxTotalBytes > INLINE_MAX_TOTAL_BYTES) {
      uploads.maxTotalBytes = INLINE_MAX_TOTAL_BYTES
    }
    if (
      typeof uploads.maxFileBytes === "number" &&
      uploads.maxFileBytes > (uploads.maxTotalBytes as number)
    ) {
      uploads.maxFileBytes = uploads.maxTotalBytes
    }
    if (request && typeof request.maxPayloadBytes === "number") {
      const floor = inlineRequestFloorBytes(
        uploads as FormPolicyV1["uploads"]
      )
      if (request.maxPayloadBytes < floor) {
        request.maxPayloadBytes = floor
      }
    }
    if (request && Array.isArray(request.allowedContentTypes)) {
      const types = request.allowedContentTypes as string[]
      if (!types.includes("multipart/form-data")) {
        request.allowedContentTypes = [...types, "multipart/form-data"]
      }
    }
  }

  return policy
}

export function migrateFormPolicy(
  value: unknown,
  schemaVersion: number
): FormPolicyV1 {
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported form policy schema version: ${schemaVersion}`)
  }

  return FormPolicyV1Schema.parse(repairFormPolicyV1(value))
}
