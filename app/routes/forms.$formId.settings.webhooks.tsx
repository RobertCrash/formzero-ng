import { data, useFetcher, useLoaderData } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.webhooks"
import { requireAuth } from "~/lib/require-auth.server"
import {
  deleteSecret,
  putSecret,
} from "~/lib/secrets/secret-store.server"
import { validateWebhookDestination } from "~/lib/delivery/process-webhook.server"
import { publishDeliveryJobs } from "~/lib/delivery/publish-jobs.server"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"

type WebhookRow = {
  id: string
  url: string
  enabled: number
  event_types: string
  timeout_ms: number
  secret_id: string
  last_status: string | null
  last_response_status: number | null
  last_error: string | null
  last_job_id: string | null
  last_created_at: number | null
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  await requireAuth(request, context.cloudflare.env.DB)
  const webhooks = await context.cloudflare.env.DB
    .prepare(`
      SELECT
        webhook.*,
        job.status AS last_status,
        job.response_status AS last_response_status,
        job.last_error,
        job.id AS last_job_id,
        job.created_at AS last_created_at
      FROM form_webhooks AS webhook
      LEFT JOIN delivery_jobs AS job
        ON job.id = (
          SELECT id
          FROM delivery_jobs
          WHERE target_id = webhook.id
          ORDER BY created_at DESC
          LIMIT 1
        )
      WHERE webhook.form_id = ?
      ORDER BY webhook.created_at
    `)
    .bind(params.formId)
    .all<WebhookRow>()

  const attempts = await context.cloudflare.env.DB
    .prepare(`
      SELECT
        job.target_id AS webhook_id,
        attempt.attempt_number,
        attempt.started_at,
        attempt.completed_at,
        attempt.response_status,
        attempt.error
      FROM delivery_attempts AS attempt
      JOIN delivery_jobs AS job ON job.id = attempt.job_id
      WHERE job.form_id = ?
        AND job.kind = 'webhook'
      ORDER BY attempt.started_at DESC
      LIMIT 100
    `)
    .bind(params.formId)
    .all<{
      webhook_id: string
      attempt_number: number
      started_at: number
      completed_at: number | null
      response_status: number | null
      error: string | null
    }>()

  return { webhooks: webhooks.results, attempts: attempts.results }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env & {
    FORMZERO_ENCRYPTION_KEY?: string
    DELIVERY_QUEUE?: Queue<{ jobId: string }>
  }
  await requireAuth(request, env.DB)
  const body = await request.formData()
  const intent = String(body.get("intent") ?? "")
  const webhookId = String(body.get("webhook_id") ?? "")

  if (intent === "create") {
    const url = String(body.get("url") ?? "").trim()
    try {
      validateWebhookDestination(url)
    } catch (error) {
      return data(
        {
          success: false,
          error: error instanceof Error ? error.message : "Invalid webhook URL.",
        },
        { status: 400 }
      )
    }
    if (!env.FORMZERO_ENCRYPTION_KEY) {
      return data(
        { success: false, error: "FORMZERO_ENCRYPTION_KEY is not configured." },
        { status: 503 }
      )
    }
    const id = crypto.randomUUID()
    const secretId = await putSecret({
      db: env.DB,
      encryptionKey: env.FORMZERO_ENCRYPTION_KEY,
      formId: params.formId,
      purpose: "webhook_signing",
      value: crypto.randomUUID().replaceAll("-", ""),
    })
    const now = Date.now()
    await env.DB
      .prepare(`
        INSERT INTO form_webhooks (
          id, form_id, url, enabled, secret_id, event_types,
          timeout_ms, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, json('["submission.created"]'), 10000, ?, ?)
      `)
      .bind(id, params.formId, url, secretId, now, now)
      .run()
    return data({ success: true })
  }

  const webhook = await env.DB
    .prepare(`
      SELECT id, secret_id
      FROM form_webhooks
      WHERE id = ? AND form_id = ?
    `)
    .bind(webhookId, params.formId)
    .first<{ id: string; secret_id: string }>()
  if (!webhook) {
    return data({ success: false, error: "Webhook not found." }, { status: 404 })
  }

  if (intent === "delete") {
    await env.DB
      .prepare("DELETE FROM form_webhooks WHERE id = ? AND form_id = ?")
      .bind(webhookId, params.formId)
      .run()
    await deleteSecret(env.DB, webhook.secret_id)
    return data({ success: true })
  }

  if (intent === "toggle") {
    await env.DB
      .prepare(`
        UPDATE form_webhooks
        SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END, updated_at = ?
        WHERE id = ? AND form_id = ?
      `)
      .bind(Date.now(), webhookId, params.formId)
      .run()
    return data({ success: true })
  }

  if (intent === "rotate") {
    if (!env.FORMZERO_ENCRYPTION_KEY) {
      return data(
        { success: false, error: "FORMZERO_ENCRYPTION_KEY is not configured." },
        { status: 503 }
      )
    }
    await putSecret({
      db: env.DB,
      encryptionKey: env.FORMZERO_ENCRYPTION_KEY,
      formId: params.formId,
      purpose: "webhook_signing",
      value: crypto.randomUUID().replaceAll("-", ""),
      secretId: webhook.secret_id,
    })
    return data({ success: true })
  }

  if (intent === "retry") {
    const jobId = String(body.get("job_id") ?? "")
    await env.DB
      .prepare(`
        UPDATE delivery_jobs
        SET status = 'pending', available_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND target_id = ? AND form_id = ?
          AND status = 'failed'
      `)
      .bind(Date.now(), Date.now(), jobId, webhookId, params.formId)
      .run()
    await publishDeliveryJobs({
      db: env.DB,
      queue: env.DELIVERY_QUEUE,
      jobs: [{ id: jobId, kind: "webhook", targetId: webhookId }],
    })
    return data({ success: true })
  }

  if (intent === "test") {
    const submission = await env.DB
      .prepare(`
        SELECT id
        FROM submissions
        WHERE form_id = ? AND status = 'accepted'
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .bind(params.formId)
      .first<{ id: string }>()
    if (!submission) {
      return data(
        { success: false, error: "Create a submission before testing." },
        { status: 400 }
      )
    }
    const jobId = crypto.randomUUID()
    const now = Date.now()
    await env.DB
      .prepare(`
        INSERT INTO delivery_jobs (
          id, kind, form_id, submission_id, target_id, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (?, 'webhook', ?, ?, ?, 'pending', 0, ?, ?, ?)
      `)
      .bind(jobId, params.formId, submission.id, webhookId, now, now, now)
      .run()
    await publishDeliveryJobs({
      db: env.DB,
      queue: env.DELIVERY_QUEUE,
      jobs: [{ id: jobId, kind: "webhook", targetId: webhookId }],
    })
    return data({ success: true })
  }

  return data({ success: false, error: "Unknown action." }, { status: 400 })
}

export default function WebhookSettings() {
  const { webhooks, attempts } = useLoaderData<typeof loader>()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Add webhook</CardTitle></CardHeader>
        <CardContent>
          <fetcher.Form method="post" className="flex gap-2">
            <input type="hidden" name="intent" value="create" />
            <Input
              name="url"
              type="url"
              required
              placeholder="https://hooks.example.com/formzero"
            />
            <Button>Add</Button>
          </fetcher.Form>
        </CardContent>
      </Card>
      {webhooks.map((webhook) => (
        <Card key={webhook.id}>
          <CardHeader>
            <CardTitle className="break-all text-base">{webhook.url}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {webhook.enabled ? "Enabled" : "Disabled"} · Secret configured ·
              Last delivery: {webhook.last_status ?? "never"}
              {webhook.last_response_status
                ? ` (HTTP ${webhook.last_response_status})`
                : ""}
            </p>
            {webhook.last_error && (
              <p className="text-sm text-destructive">{webhook.last_error}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {["toggle", "test", "rotate", "delete"].map((intent) => (
                <fetcher.Form method="post" key={intent}>
                  <input type="hidden" name="intent" value={intent} />
                  <input type="hidden" name="webhook_id" value={webhook.id} />
                  <Button
                    size="sm"
                    variant={intent === "delete" ? "destructive" : "outline"}
                  >
                    {intent === "toggle"
                      ? webhook.enabled
                        ? "Disable"
                        : "Enable"
                      : intent.charAt(0).toUpperCase() + intent.slice(1)}
                  </Button>
                </fetcher.Form>
              ))}
              {webhook.last_status === "failed" && webhook.last_job_id && (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="retry" />
                  <input type="hidden" name="webhook_id" value={webhook.id} />
                  <input type="hidden" name="job_id" value={webhook.last_job_id} />
                  <Button size="sm" variant="outline">Retry</Button>
                </fetcher.Form>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-sm">Delivery history</summary>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {attempts
                  .filter((attempt) => attempt.webhook_id === webhook.id)
                  .map((attempt) => (
                    <p key={`${attempt.started_at}-${attempt.attempt_number}`}>
                      {new Date(attempt.started_at).toLocaleString()} · Attempt{" "}
                      {attempt.attempt_number} ·{" "}
                      {attempt.response_status
                        ? `HTTP ${attempt.response_status}`
                        : attempt.error ?? "processing"}
                    </p>
                  ))}
                {!attempts.some((attempt) => attempt.webhook_id === webhook.id) && (
                  <p>No delivery attempts yet.</p>
                )}
              </div>
            </details>
          </CardContent>
        </Card>
      ))}
      {fetcher.data?.error && (
        <p className="text-sm text-destructive">{fetcher.data.error}</p>
      )}
    </div>
  )
}
