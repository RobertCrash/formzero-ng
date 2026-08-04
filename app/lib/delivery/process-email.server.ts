import { EmailTransportMissingError } from "../email/message"
import { renderSubmissionNotification } from "../email/render.server"
import {
  loadEmailSettings,
  resolveEmailTransport,
} from "../email/transport.server"
import { migrateFormPolicy } from "../form-config/migrate-config"
import { parseDeliverySnapshot } from "./config-snapshot"

type EmailEnv = {
  DB: D1Database
  EMAIL: SendEmail
  FORMZERO_ENCRYPTION_KEY?: string
  FORMZERO_PUBLIC_URL?: string
}

export async function processEmail(
  job: {
    id: string
    form_id: string
    submission_id: string
    config_snapshot?: string | null
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

  // The snapshot is what the submission was accepted under. Only jobs enqueued
  // before migration 0010 fall back to the form's current policy.
  const snapshot = parseDeliverySnapshot(job.config_snapshot ?? null)
  const livePolicy = snapshot
    ? null
    : migrateFormPolicy(JSON.parse(row.config_json), row.config_schema_version)
  const notifications = snapshot?.notifications ?? livePolicy!.notifications
  const fields = snapshot?.fields ?? livePolicy!.fields
  const formName = snapshot?.formName ?? row.form_name
  if (!notifications.enabled) return { skipped: true }

  const transport = await resolveEmailTransport({ env, db: env.DB })
  if (!transport) {
    const settings = await loadEmailSettings(env.DB)
    throw new EmailTransportMissingError(
      settings === null
        ? "No email transport is configured. Open global notification settings and choose a transport."
        : settings.transport === "smtp"
          ? "The custom SMTP transport is selected but its stored configuration is incomplete or undecryptable. Check the SMTP host, port and password, and that FORMZERO_ENCRYPTION_KEY is set."
          : "The Cloudflare email transport needs a sender address on a domain onboarded for sending. Set it in global notification settings."
    )
  }

  const data = JSON.parse(row.data) as Record<string, unknown>
  const replyToValue = notifications.replyToField
    ? data[notifications.replyToField]
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

  const rendered = renderSubmissionNotification({
    id: job.submission_id,
    formId: job.form_id,
    formName,
    data,
    createdAt: row.created_at,
    replyTo: typeof replyToValue === "string" ? replyToValue : undefined,
    subject: notifications.subjectTemplate?.replace(
      /\{\{\s*form\.name\s*\}\}/g,
      formName
    ),
    fields,
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

  // The policy schema requires at least one recipient whenever notifications
  // are enabled, so there is nothing to fall back to here.
  await transport.send({
    to: notifications.recipients,
    from: transport.from,
    replyTo: typeof replyToValue === "string" ? replyToValue : undefined,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })
  return { skipped: false }
}
