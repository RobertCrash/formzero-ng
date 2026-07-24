import { data } from "react-router"
import type { Route } from "./+types/api.forms.$formId.uploads"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import { buildSubmissionContext } from "~/lib/submissions/build-context.server"
import { applyRateLimit } from "~/lib/submissions/apply-rate-limit.server"
import {
  resolveCorsHeaders,
  validateOrigin,
} from "~/lib/submissions/validate-origin"
import { temporaryObjectKey } from "~/lib/uploads/object-key"
import { sanitizeFilename } from "~/lib/uploads/validate-file"

type UploadRequest = {
  files: Array<{
    field: string
    name: string
    type: string
    size: number
  }>
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const form = await loadFormWithPolicy(context.cloudflare.env.DB, params.formId)
  const headers = form
    ? resolveCorsHeaders(request, form.policy.security)
    : new Headers({ Vary: "Origin" })
  return new Response(null, {
    status: request.method === "OPTIONS" ? (form ? 204 : 404) : 405,
    headers,
  })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env & { IP_HASH_SECRET?: string }
  const form = await loadFormWithPolicy(env.DB, params.formId)
  if (!form) return data({ success: false, error: "Form not found." }, { status: 404 })
  const cors = resolveCorsHeaders(request, form.policy.security)
  if (!form.policy.uploads.enabled || form.policy.uploads.mode !== "direct") {
    return data(
      { success: false, error: "Direct uploads are not enabled." },
      { status: 403, headers: cors }
    )
  }

  try {
    const origin = validateOrigin(request, form.policy.security)
    const requestContext = await buildSubmissionContext({
      request,
      env,
      policy: form.policy,
      receivedAt: Date.now(),
    })
    await applyRateLimit({
      formId: form.id,
      sourceIpHash: requestContext.rateLimitIpHash,
      config: form.policy.security.rateLimit,
      env,
    })
    const body = await request.json<UploadRequest>()
    if (
      !Array.isArray(body.files) ||
      body.files.length === 0 ||
      body.files.length > form.policy.uploads.maxFiles
    ) {
      throw new Error("Invalid file count.")
    }
    const total = body.files.reduce((sum, file) => sum + Number(file.size), 0)
    if (total > form.policy.uploads.maxTotalBytes) {
      throw new Error("Total file size exceeds the configured limit.")
    }
    const fieldRules = new Map(form.policy.fields.map((field) => [field.name, field]))
    for (const file of body.files) {
      const rule = fieldRules.get(file.field)
      if (!rule || (rule.type !== "file" && rule.type !== "files")) {
        throw new Error(`Field ${file.field} is not a configured file field.`)
      }
      if (file.size < 1 || file.size > form.policy.uploads.maxFileBytes) {
        throw new Error(`${file.name} exceeds the configured file limit.`)
      }
      if (
        form.policy.uploads.allowedMimeTypes.length > 0 &&
        !form.policy.uploads.allowedMimeTypes.includes(file.type.toLowerCase())
      ) {
        throw new Error(`${file.type} is not an allowed MIME type.`)
      }
    }

    const sessionId = crypto.randomUUID()
    const now = Date.now()
    const expiresAt = now + 60 * 60 * 1_000
    const fileRecords = body.files.map((file) => {
      const id = crypto.randomUUID()
      return {
        ...file,
        id,
        objectKey: temporaryObjectKey(form.id, sessionId, id),
      }
    })
    await env.DB.batch([
      env.DB
        .prepare(`
          INSERT INTO upload_sessions (
            id, form_id, status, origin, expires_at, created_at
          ) VALUES (?, ?, 'pending', ?, ?, ?)
        `)
        .bind(sessionId, form.id, origin, expiresAt, now),
      ...fileRecords.map((file) =>
        env.DB
          .prepare(`
            INSERT INTO submission_files (
              id, form_id, upload_session_id, field_name, object_key,
              original_name, mime_type, size_bytes, status, created_at, delete_after
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'temporary', ?, ?)
          `)
          .bind(
            file.id,
            form.id,
            sessionId,
            file.field,
            file.objectKey,
            sanitizeFilename(file.name),
            file.type || "application/octet-stream",
            file.size,
            now,
            expiresAt
          )
      ),
    ])

    return data(
      {
        success: true,
        sessionId,
        expiresAt,
        files: fileRecords.map((file) => ({
          id: file.id,
          uploadUrl: `/api/forms/${encodeURIComponent(
            form.id
          )}/uploads/${encodeURIComponent(
            sessionId
          )}/files/${encodeURIComponent(file.id)}`,
        })),
      },
      { status: 201, headers: cors }
    )
  } catch (error) {
    return data(
      {
        success: false,
        error: error instanceof Error ? error.message : "Upload session failed.",
      },
      { status: 400, headers: cors }
    )
  }
}
