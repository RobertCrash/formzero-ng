import { sendSubmissionNotification } from "../email.server"
import { migrateFormPolicy } from "../form-config/migrate-config"
import { loadSmtpConfig } from "./smtp-config.server"

type EmailEnv = {
  DB: D1Database
  FORMZERO_ENCRYPTION_KEY?: string
  FORMZERO_PUBLIC_URL?: string
}

export async function processEmail(
  job: {
    id: string
    form_id: string
    submission_id: string
  },
  env: EmailEnv
) {
  const row = await env.DB
    .prepare(`
      SELECT
        form.name AS form_name,
        form.config_json,
        form.config_schema_version,
        submission.data,
        submission.created_at
      FROM submissions AS submission
      JOIN forms AS form ON form.id = submission.form_id
      WHERE submission.id = ?
        AND submission.form_id = ?
    `)
    .bind(job.submission_id, job.form_id)
    .first<{
      form_name: string
      config_json: string
      config_schema_version: number
      data: string
      created_at: number
    }>()
  if (!row) throw new Error("Submission no longer exists.")

  const policy = migrateFormPolicy(
    JSON.parse(row.config_json),
    row.config_schema_version
  )
  if (!policy.notifications.enabled) return { skipped: true }

  const smtp = await loadSmtpConfig({
    db: env.DB,
    encryptionKey: env.FORMZERO_ENCRYPTION_KEY,
  })
  if (!smtp) throw new Error("SMTP transport is not configured.")

  const data = JSON.parse(row.data) as Record<string, unknown>
  const replyToValue = policy.notifications.replyToField
    ? data[policy.notifications.replyToField]
    : undefined
  const fileRows = await env.DB
    .prepare(`
      SELECT id, original_name, mime_type, size_bytes
      FROM submission_files
      WHERE submission_id = ?
        AND status = 'attached'
    `)
    .bind(job.submission_id)
    .all<{
      id: string
      original_name: string
      mime_type: string
      size_bytes: number
    }>()
  const baseUrl = env.FORMZERO_PUBLIC_URL?.replace(/\/$/, "") ?? ""

  const result = await sendSubmissionNotification(smtp, {
    id: job.submission_id,
    formId: job.form_id,
    formName: row.form_name,
    data,
    createdAt: row.created_at,
    recipients: policy.notifications.recipients,
    replyTo: typeof replyToValue === "string" ? replyToValue : undefined,
    subject: policy.notifications.subjectTemplate?.replace(
      /\{\{\s*form\.name\s*\}\}/g,
      row.form_name
    ),
    fields: policy.fields,
    files: fileRows.results.map((file) => ({
      id: file.id,
      name: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      downloadUrl: `${baseUrl}/forms/${encodeURIComponent(
        job.form_id
      )}/submissions/${encodeURIComponent(
        job.submission_id
      )}/files/${encodeURIComponent(file.id)}`,
    })),
  })
  if (!result.success) throw new Error(result.error ?? "Email delivery failed.")
  return { skipped: false }
}
