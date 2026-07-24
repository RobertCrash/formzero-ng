import type { Route } from "./+types/forms.$formId.submissions.$submissionId.files.$fileId"
import { requireAuth } from "~/lib/require-auth.server"

export async function loader({ request, params, context }: Route.LoaderArgs) {
  await requireAuth(request, context.cloudflare.env.DB)
  const file = await context.cloudflare.env.DB
    .prepare(`
      SELECT object_key, original_name, mime_type
      FROM submission_files
      WHERE id = ?
        AND form_id = ?
        AND submission_id = ?
        AND status = 'attached'
    `)
    .bind(params.fileId, params.formId, params.submissionId)
    .first<{
      object_key: string
      original_name: string
      mime_type: string
    }>()
  if (!file) throw new Response("File not found", { status: 404 })
  const object = await context.cloudflare.env.UPLOADS.get(file.object_key)
  if (!object) throw new Response("File body not found", { status: 404 })

  const filename = file.original_name.replace(/["\r\n]/g, "_")
  return new Response(object.body, {
    headers: {
      "Content-Type": file.mime_type || "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  })
}
