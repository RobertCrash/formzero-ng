import type { FormWithPolicy } from "../form-config/types"
import type { BuiltSubmissionContext } from "./build-context.server"
import { calculateDeleteAfter } from "../retention/calculate-delete-after"
import { createDeliveryJobStatements } from "../delivery/create-jobs.server"

export type PreparedSubmissionFile = {
  id: string
  fieldName: string
  objectKey: string
  originalName: string
  mimeType: string
  sizeBytes: number
  checksum: string | null
  uploadSessionId: string | null
  existingMetadata?: boolean
}

export async function createSubmissionWithJobs({
  db,
  form,
  fields,
  files,
  submissionContext,
  metadata,
}: {
  db: D1Database
  form: FormWithPolicy
  fields: Record<string, unknown>
  files: PreparedSubmissionFile[]
  submissionContext: BuiltSubmissionContext["core"]
  metadata: Record<string, unknown>
}) {
  const submissionId = crypto.randomUUID()
  const processedAt = Date.now()
  const deleteAfter = calculateDeleteAfter(
    submissionContext.createdAt,
    form.policy.retention.submissionsDays
  )
  const ipDeleteAfter = calculateDeleteAfter(
    submissionContext.createdAt,
    form.policy.privacy.ipRetentionDays
  )

  const insertSubmission = db
    .prepare(`
      INSERT INTO submissions (
        id,
        form_id,
        request_id,
        config_revision,
        status,
        data,
        metadata_json,
        source_ip,
        source_ip_hash,
        source_origin,
        country_code,
        cf_ray,
        user_agent,
        created_at,
        processed_at,
        ip_delete_after,
        delete_after
      ) VALUES (
        ?, ?, ?, ?, 'accepted', json(?), json(?),
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    .bind(
      submissionId,
      form.id,
      submissionContext.requestId,
      form.configRevision,
      JSON.stringify(fields),
      JSON.stringify(metadata),
      submissionContext.sourceIp,
      submissionContext.sourceIpHash,
      submissionContext.origin,
      submissionContext.countryCode,
      submissionContext.cfRay,
      submissionContext.userAgent,
      submissionContext.createdAt,
      processedAt,
      ipDeleteAfter,
      deleteAfter
    )

  const fileStatements = files.map((file) =>
    file.existingMetadata
      ? db
          .prepare(`
            UPDATE submission_files
            SET
              submission_id = ?,
              object_key = ?,
              status = 'attached',
              delete_after = ?
            WHERE id = ?
              AND form_id = ?
              AND status = 'completed'
          `)
          .bind(
            submissionId,
            file.objectKey,
            calculateDeleteAfter(
              submissionContext.createdAt,
              form.policy.retention.filesDays
            ),
            file.id,
            form.id
          )
      : db
          .prepare(`
        INSERT INTO submission_files (
          id,
          form_id,
          submission_id,
          upload_session_id,
          field_name,
          object_key,
          original_name,
          mime_type,
          size_bytes,
          checksum,
          status,
          created_at,
          delete_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?)
          `)
          .bind(
            file.id,
            form.id,
            submissionId,
            file.uploadSessionId,
            file.fieldName,
            file.objectKey,
            file.originalName,
            file.mimeType,
            file.sizeBytes,
            file.checksum,
            processedAt,
            calculateDeleteAfter(
              submissionContext.createdAt,
              form.policy.retention.filesDays
            )
          )
  )

  const delivery = await createDeliveryJobStatements({
    db,
    form,
    submissionId,
    now: processedAt,
  })

  await db.batch([
    insertSubmission,
    ...fileStatements,
    ...delivery.statements,
  ])

  return {
    id: submissionId,
    requestId: submissionContext.requestId,
    deliveryJobs: delivery.jobs,
  }
}
