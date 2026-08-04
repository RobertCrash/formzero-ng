import { data } from "react-router"
import { hasUsableEmailTransport } from "../email/transport.server"
import type { AppEnv } from "../env"
import { checkPlatformBindings } from "../platform/check-bindings.server"
import { requireAuth } from "../require-auth.server"
import { getCapabilities, validatePolicyCapabilities } from "./capabilities.server"
import { loadFormWithPolicy } from "./load-form-policy.server"
import { FormPolicyV1Schema } from "./schema"
import {
  FormPolicyConflictError,
  saveFormPolicy,
} from "./save-form-policy.server"

export async function loadFormSettingsContext({
  request,
  formId,
  env,
}: {
  request: Request
  formId: string
  env: AppEnv
}) {
  await requireAuth(request, env.DB)
  const form = await loadFormWithPolicy(env.DB, formId)
  if (!form) throw new Response("Form not found", { status: 404 })
  const operations = await env.DB
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM submission_files WHERE form_id = ?) AS file_count,
        (
          SELECT COALESCE(SUM(size_bytes), 0)
          FROM submission_files
          WHERE form_id = ? AND status = 'attached'
        ) AS stored_bytes,
        (
          SELECT COUNT(*)
          FROM delivery_jobs
          WHERE form_id = ? AND status IN ('pending', 'published', 'processing', 'retry')
        ) AS pending_deliveries,
        (
          SELECT COUNT(*)
          FROM delivery_jobs
          WHERE form_id = ? AND status = 'failed'
        ) AS failed_deliveries
    `)
    .bind(formId, formId, formId, formId)
    .first<{
      file_count: number
      stored_bytes: number
      pending_deliveries: number
      failed_deliveries: number
    }>()
  const emailTransport = await hasUsableEmailTransport({ env, db: env.DB })
  return {
    form,
    capabilities: getCapabilities(env, { emailTransport }),
    platform: checkPlatformBindings(env),
    operations: operations ?? {
      file_count: 0,
      stored_bytes: 0,
      pending_deliveries: 0,
      failed_deliveries: 0,
    },
  }
}

export async function savePolicyRequest({
  request,
  formId,
  env,
}: {
  request: Request
  formId: string
  env: AppEnv
}) {
  await requireAuth(request, env.DB)
  const body = await request.formData()
  const revision = Number(body.get("revision"))
  const rawPolicy = body.get("policy")
  if (!Number.isInteger(revision) || typeof rawPolicy !== "string") {
    return data(
      { success: false, error: "Invalid policy save request." },
      { status: 400 }
    )
  }

  let policy: unknown
  try {
    policy = JSON.parse(rawPolicy)
  } catch {
    return data(
      { success: false, error: "Policy must be valid JSON." },
      { status: 400 }
    )
  }
  const containsSecretKey = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false
    if (Array.isArray(value)) return value.some(containsSecretKey)
    return Object.entries(value).some(
      ([key, nested]) =>
        /(?:secret|password)/i.test(key) || containsSecretKey(nested)
    )
  }
  if (containsSecretKey(policy)) {
    return data(
      {
        success: false,
        error: "Secret and password values cannot be stored in form policy JSON.",
      },
      { status: 422 }
    )
  }
  const parsed = FormPolicyV1Schema.safeParse(policy)
  if (!parsed.success) {
    return data(
      {
        success: false,
        error: "The policy is invalid.",
        issues: parsed.error.issues,
      },
      { status: 422 }
    )
  }
  if (
    parsed.data.security.captcha.enabled &&
    parsed.data.security.captcha.credentialId
  ) {
    const credential = await env.DB
      .prepare(`
        SELECT id
        FROM form_secrets
        WHERE id = ?
          AND form_id = ?
          AND purpose = 'turnstile_secret'
      `)
      .bind(parsed.data.security.captcha.credentialId, formId)
      .first()
    if (!credential) {
      return data(
        {
          success: false,
          error: "Turnstile credential does not belong to this form.",
        },
        { status: 422 }
      )
    }
  }
  const capabilityCheck = validatePolicyCapabilities(parsed.data, env, {
    // Only pay for the transport lookup when the policy actually needs it.
    emailTransport: parsed.data.notifications.enabled
      ? await hasUsableEmailTransport({ env, db: env.DB })
      : false,
  })
  if (capabilityCheck.errors.length > 0) {
    return data(
      {
        success: false,
        error: capabilityCheck.errors.join(" "),
      },
      { status: 503 }
    )
  }

  try {
    const result = await saveFormPolicy({
      db: env.DB,
      formId,
      expectedRevision: revision,
      policy: parsed.data,
    })
    return data({ success: true, revision: result.revision })
  } catch (error) {
    if (error instanceof FormPolicyConflictError) {
      return data(
        { success: false, error: error.message, conflict: true },
        { status: 409 }
      )
    }
    throw error
  }
}
