import { data } from "react-router"
import type { Route } from "./+types/api.forms.$formId.uploads.$sessionId.files.$fileId"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import { limitAndHash } from "~/lib/uploads/limited-stream"
import {
  resolveCorsHeaders,
  validateOrigin,
} from "~/lib/submissions/validate-origin"

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  const form = await loadFormWithPolicy(env.DB, params.formId)
  if (!form) return data({ success: false, error: "Form not found." }, { status: 404 })
  const cors = resolveCorsHeaders(request, form.policy.security)
  if (request.method !== "PUT") {
    return data(
      { success: false, error: "Method not allowed." },
      { status: 405, headers: cors }
    )
  }

  try {
    const origin = validateOrigin(request, form.policy.security)
    const record = await env.DB
      .prepare(`
        SELECT
          file.object_key,
          file.mime_type,
          file.size_bytes,
          session.origin,
          session.expires_at
        FROM submission_files AS file
        JOIN upload_sessions AS session ON session.id = file.upload_session_id
        WHERE file.id = ?
          AND file.form_id = ?
          AND file.upload_session_id = ?
          AND file.status = 'temporary'
          AND session.status = 'pending'
      `)
      .bind(params.fileId, form.id, params.sessionId)
      .first<{
        object_key: string
        mime_type: string
        size_bytes: number
        origin: string | null
        expires_at: number
      }>()
    if (!record || record.expires_at <= Date.now()) {
      throw new Error("Upload authorization is invalid or expired.")
    }
    if (record.origin !== origin) {
      throw new Error("Upload origin does not match the session.")
    }
    // The session already committed to a size, so anything above it is a
    // mismatch rather than a policy question. Rejecting on the declared length
    // avoids reading a body that cannot be accepted.
    const limit = Math.min(record.size_bytes, form.policy.uploads.maxFileBytes)
    const declaredLength = Number(request.headers.get("Content-Length"))
    if (declaredLength && declaredLength !== record.size_bytes) {
      throw new Error("Uploaded size does not match the declared file size.")
    }
    if (record.size_bytes > form.policy.uploads.maxFileBytes) {
      throw new Error("Uploaded file size is invalid.")
    }
    const contentType =
      request.headers.get("Content-Type") || "application/octet-stream"
    if (contentType !== record.mime_type) {
      throw new Error("Uploaded MIME type does not match the session.")
    }
    if (!request.body) throw new Error("The upload request has no body.")

    // Hashed and counted while it flows into R2, so nothing larger than the
    // limit is ever held in the Worker.
    const upload = limitAndHash(request.body, limit)
    await env.UPLOADS.put(record.object_key, upload.body, {
      httpMetadata: { contentType },
      customMetadata: {
        formId: form.id,
        fileId: params.fileId,
        status: "completed",
      },
    })
    if (upload.bytesRead() !== record.size_bytes) {
      // A short body would otherwise leave a truncated object behind.
      await env.UPLOADS.delete(record.object_key)
      throw new Error("Uploaded file size is invalid.")
    }
    const checksum = await upload.checksum()
    await env.DB
      .prepare(`
        UPDATE submission_files
        SET status = 'completed', checksum = ?
        WHERE id = ? AND status = 'temporary'
      `)
      .bind(checksum, params.fileId)
      .run()
    return data({ success: true, checksum }, { headers: cors })
  } catch (error) {
    return data(
      {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed.",
      },
      { status: 400, headers: cors }
    )
  }
}
