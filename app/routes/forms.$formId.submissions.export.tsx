import { data } from "react-router"
import type { Route } from "./+types/forms.$formId.submissions.export"
import { requireAuth } from "~/lib/require-auth.server"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import { csvValue } from "~/lib/delivery/process-export.server"
import { publishDeliveryJobs } from "~/lib/delivery/publish-jobs.server"

async function queueExport(formId: string, env: Env) {
  const exportId = crypto.randomUUID()
  const deliveryId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.batch([
    env.DB
      .prepare(`
        INSERT INTO export_jobs (id, form_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
      `)
      .bind(exportId, formId, now),
    env.DB
      .prepare(`
        INSERT INTO delivery_jobs (
          id, kind, form_id, target_id, status, attempt_count,
          available_at, created_at, updated_at
        ) VALUES (?, 'export', ?, ?, 'pending', 0, ?, ?, ?)
      `)
      .bind(deliveryId, formId, exportId, now, now, now),
  ])
  await publishDeliveryJobs({
    db: env.DB,
    queue: env.DELIVERY_QUEUE,
    jobs: [{ id: deliveryId, kind: "export", targetId: exportId }],
  })
  return exportId
}

export async function action({ request, params, context }: Route.ActionArgs) {
  await requireAuth(request, context.cloudflare.env.DB)
  const form = await loadFormWithPolicy(
    context.cloudflare.env.DB,
    params.formId
  )
  if (!form) {
    return data({ success: false, error: "Form not found." }, { status: 404 })
  }
  const exportId = await queueExport(form.id, context.cloudflare.env)
  return data(
    {
      success: true,
      pending: true,
      exportId,
      downloadUrl: `/forms/${form.id}/submissions/export?job=${exportId}`,
    },
    { status: 202 }
  )
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env.DB)
  const form = await loadFormWithPolicy(env.DB, params.formId)
  if (!form) throw new Response("Form not found", { status: 404 })
  const url = new URL(request.url)
  const exportJobId = url.searchParams.get("job")
  if (exportJobId) {
    const job = await env.DB
      .prepare(`
        SELECT object_key
        FROM export_jobs
        WHERE id = ? AND form_id = ? AND status = 'completed'
          AND expires_at > ?
      `)
      .bind(exportJobId, form.id, Date.now())
      .first<{ object_key: string }>()
    if (!job) throw new Response("Export is not ready or has expired.", { status: 404 })
    const object = await env.UPLOADS.get(job.object_key)
    if (!object) throw new Response("Export file not found.", { status: 404 })
    return new Response(object.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="submissions-${form.id}.csv"`,
        "Cache-Control": "private, no-store",
      },
    })
  }

  const count = await env.DB
    .prepare(`
      SELECT COUNT(*) AS count
      FROM submissions
      WHERE form_id = ? AND status = 'accepted'
    `)
    .bind(form.id)
    .first<{ count: number }>()

  if (Number(count?.count ?? 0) > 5_000) {
    const exportId = await queueExport(form.id, env)
    return data(
      {
        success: true,
        pending: true,
        exportId,
        downloadUrl: `/forms/${form.id}/submissions/export?job=${exportId}`,
      },
      { status: 202 }
    )
  }

  let fieldNames = form.policy.fields.map((field) => field.name)
  if (fieldNames.length === 0) {
    const fields = await env.DB
      .prepare(`
        SELECT DISTINCT field.key AS name
        FROM submissions AS submission, json_each(submission.data) AS field
        WHERE submission.form_id = ?
        ORDER BY field.key
      `)
      .bind(form.id)
      .all<{ name: string }>()
    fieldNames = fields.results.map((field) => field.name)
  }
  const submissions = await env.DB
    .prepare(`
      SELECT id, data, created_at
      FROM submissions
      WHERE form_id = ? AND status = 'accepted'
      ORDER BY created_at DESC, id DESC
    `)
    .bind(form.id)
    .all<{ id: string; data: string; created_at: number }>()
  const lines = [
    ["ID", "Created At", ...fieldNames].map(csvValue).join(","),
    ...submissions.results.map((row) => {
      const values = JSON.parse(row.data) as Record<string, unknown>
      return [
        row.id,
        new Date(row.created_at).toISOString(),
        ...fieldNames.map((field) => values[field]),
      ]
        .map(csvValue)
        .join(",")
    }),
  ]
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="submissions-${form.id}.csv"`,
      "Cache-Control": "private, no-store",
    },
  })
}
