import type { FieldRule } from "../form-config/types"
import { SubmissionError } from "./errors"

function asValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value]
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function isIsoDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
}

function validateString(value: unknown, rule: FieldRule) {
  if (typeof value !== "string") throw new Error("Must be text.")
  const normalized = rule.trim === false ? value : value.trim()

  if (rule.minLength !== undefined && normalized.length < rule.minLength) {
    throw new Error(`Must contain at least ${rule.minLength} characters.`)
  }
  if (rule.maxLength !== undefined && normalized.length > rule.maxLength) {
    throw new Error(`Must not exceed ${rule.maxLength} characters.`)
  }
  if (rule.pattern && !new RegExp(rule.pattern).test(normalized)) {
    throw new Error("Has an invalid format.")
  }

  return normalized
}

function normalizeValue(value: unknown, rule: FieldRule): unknown {
  if (rule.type === "string" || rule.type === "tel") {
    return validateString(value, rule)
  }

  if (rule.type === "email") {
    const normalized = validateString(value, rule)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("Enter a valid email address.")
    }
    return normalized
  }

  if (rule.type === "url") {
    const normalized = validateString(value, rule)
    try {
      const url = new URL(normalized)
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error()
    } catch {
      throw new Error("Enter a valid HTTP or HTTPS URL.")
    }
    return normalized
  }

  if (rule.type === "number") {
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()))
    ) {
      throw new Error("Enter a valid number.")
    }
    const normalized = Number(value)
    if (!Number.isFinite(normalized)) throw new Error("Enter a valid number.")
    if (rule.minimum !== undefined && normalized < rule.minimum) {
      throw new Error(`Must be at least ${rule.minimum}.`)
    }
    if (rule.maximum !== undefined && normalized > rule.maximum) {
      throw new Error(`Must not exceed ${rule.maximum}.`)
    }
    return normalized
  }

  if (rule.type === "boolean") {
    if (typeof value === "boolean") return value
    if (typeof value === "number" && (value === 0 || value === 1)) return value === 1
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase()
      if (["true", "1", "on", "yes"].includes(normalized)) return true
      if (["false", "0", "off", "no"].includes(normalized)) return false
    }
    throw new Error("Enter a valid boolean value.")
  }

  if (rule.type === "date") {
    const normalized = validateString(value, rule)
    if (!isIsoDate(normalized)) throw new Error("Enter a valid ISO date.")
    return normalized
  }

  if (rule.type === "datetime") {
    const normalized = validateString(value, rule)
    if (!isIsoDateTime(normalized)) {
      throw new Error("Enter a valid ISO date and time.")
    }
    return normalized
  }

  if (rule.type === "select") {
    const normalized = validateString(value, rule)
    if (!rule.options?.includes(normalized)) {
      throw new Error("Choose one of the configured options.")
    }
    return normalized
  }

  if (rule.type === "string-array") {
    const values = asValues(value)
    if (values.length > 100) throw new Error("Contains too many values.")
    return values.map((item) =>
      validateString(item, { ...rule, type: "string" })
    )
  }

  return value
}

export function validateAndNormalizeFields({
  values,
  files,
  attachedFileCounts = {},
  rules,
  rejectUnknownFields,
}: {
  values: Record<string, unknown>
  files: Record<string, File[]>
  attachedFileCounts?: Record<string, number>
  rules: FieldRule[]
  rejectUnknownFields: boolean
}) {
  const rulesByName = new Map(rules.map((rule) => [rule.name, rule]))
  const errors: Record<string, string> = {}
  const result: Record<string, unknown> = {}

  if (rejectUnknownFields) {
    for (const name of [
      ...Object.keys(values),
      ...Object.keys(files),
      ...Object.keys(attachedFileCounts),
    ]) {
      if (!rulesByName.has(name)) errors[name] = "This field is not allowed."
    }
  }

  for (const rule of rules) {
    const isFile = rule.type === "file" || rule.type === "files"
    const attachedCount = attachedFileCounts[rule.name] ?? 0
    const value = isFile
      ? (files[rule.name]?.length ?? 0) + attachedCount
      : values[rule.name]
    const missing =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (isFile && value === 0)

    if (missing) {
      if (rule.required) errors[rule.name] = "This field is required."
      continue
    }

    if (isFile) {
      const fileCount = (files[rule.name]?.length ?? 0) + attachedCount
      if (rule.type === "file" && fileCount > 1) {
        errors[rule.name] = "Only one file is allowed."
      }
      continue
    }

    try {
      result[rule.name] = normalizeValue(value, rule)
    } catch (error) {
      errors[rule.name] =
        error instanceof Error ? error.message : "This field is invalid."
    }
  }

  if (!rejectUnknownFields) {
    for (const [name, value] of Object.entries(values)) {
      if (!rulesByName.has(name)) result[name] = value
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new SubmissionError(
      "validation_failed",
      "The submission contains invalid fields.",
      errors
    )
  }

  return result
}
