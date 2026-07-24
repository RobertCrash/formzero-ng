import type { FormWithPolicy } from "../form-config/types"

export type CreatedDeliveryJob = {
  id: string
  kind: "notification_email" | "webhook" | "export"
  targetId: string | null
}

export async function createDeliveryJobStatements({
  db,
  form,
  submissionId,
  now,
}: {
  db: D1Database
  form: FormWithPolicy
  submissionId: string
  now: number
}) {
  const jobs: CreatedDeliveryJob[] = []

  if (form.policy.notifications.enabled) {
    jobs.push({
      id: crypto.randomUUID(),
      kind: "notification_email",
      targetId: null,
    })
  }

  const webhooks = await db
    .prepare(`
      SELECT id
      FROM form_webhooks
      WHERE form_id = ?
        AND enabled = 1
        AND EXISTS (
          SELECT 1
          FROM json_each(event_types)
          WHERE value = 'submission.created'
        )
    `)
    .bind(form.id)
    .all<{ id: string }>()

  for (const webhook of webhooks.results) {
    jobs.push({
      id: crypto.randomUUID(),
      kind: "webhook",
      targetId: webhook.id,
    })
  }

  const statements = jobs.map((job) =>
    db
      .prepare(`
        INSERT INTO delivery_jobs (
          id,
          kind,
          form_id,
          submission_id,
          target_id,
          status,
          attempt_count,
          available_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `)
      .bind(
        job.id,
        job.kind,
        form.id,
        submissionId,
        job.targetId,
        now,
        now,
        now
      )
  )

  return { jobs, statements }
}
