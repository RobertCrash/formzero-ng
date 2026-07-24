import { data } from "react-router"
import type { Route } from "./+types/api.forms.$formId.uploads.$sessionId.complete"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import {
  resolveCorsHeaders,
  validateOrigin,
} from "~/lib/submissions/validate-origin"

export async function action({ request, params, context }: Route.ActionArgs) {
  const form = await loadFormWithPolicy(context.cloudflare.env.DB, params.formId)
  if (!form) return data({ success: false, error: "Form not found." }, { status: 404 })
  const cors = resolveCorsHeaders(request, form.policy.security)

  try {
    const origin = validateOrigin(request, form.policy.security)
    const session = await context.cloudflare.env.DB
      .prepare(`
        SELECT id, origin, expires_at
        FROM upload_sessions
        WHERE id = ?
          AND form_id = ?
          AND status = 'pending'
      `)
      .bind(params.sessionId, form.id)
      .first<{ id: string; origin: string | null; expires_at: number }>()
    if (!session || session.expires_at <= Date.now()) {
      throw new Error("Upload session is invalid or expired.")
    }
    if (session.origin !== origin) {
      throw new Error("Upload origin does not match the session.")
    }
    const files = await context.cloudflare.env.DB
      .prepare(`
        SELECT id, status
        FROM submission_files
        WHERE upload_session_id = ?
        ORDER BY created_at
      `)
      .bind(session.id)
      .all<{ id: string; status: string }>()
    if (
      files.results.length === 0 ||
      files.results.some((file) => file.status !== "completed")
    ) {
      throw new Error("Every file must finish uploading before completion.")
    }
    await context.cloudflare.env.DB
      .prepare(`
        UPDATE upload_sessions
        SET status = 'completed'
        WHERE id = ? AND status = 'pending'
      `)
      .bind(session.id)
      .run()
    return data(
      {
        success: true,
        uploadTokens: files.results.map((file) => file.id),
      },
      { headers: cors }
    )
  } catch (error) {
    return data(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Upload completion failed.",
      },
      { status: 400, headers: cors }
    )
  }
}
