import { useState } from "react"
import { data, useFetcher, useLoaderData, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.notifications"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import type { FormPolicyV1 } from "~/lib/form-config/types"
import { requireAuth } from "~/lib/require-auth.server"
import { EmailSendError } from "~/lib/email/message"
import { renderSubmissionNotification } from "~/lib/email/render.server"
import { resolveEmailTransport } from "~/lib/email/transport.server"
import { publishDeliveryJobs } from "~/lib/delivery/publish-jobs.server"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

export type EmailDeliveryLogEntry = {
  id: string
  status: string
  attempt_count: number
  last_error: string | null
  created_at: number
  completed_at: number | null
  dead_lettered_at: number | null
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env.DB)
  const jobs = await env.DB
    .prepare(`
      SELECT
        id, status, attempt_count, last_error, created_at, completed_at,
        dead_lettered_at
      FROM delivery_jobs
      WHERE form_id = ? AND kind = 'notification_email'
      ORDER BY created_at DESC
      LIMIT 20
    `)
    .bind(params.formId)
    .all<EmailDeliveryLogEntry>()
  return { deliveryLog: jobs.results }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const body = await request.clone().formData()
  const intent = body.get("intent")
  if (intent !== "test" && intent !== "retry") {
    return savePolicyRequest({
      request,
      formId: params.formId,
      env: context.cloudflare.env,
    })
  }

  await requireAuth(request, context.cloudflare.env.DB)

  if (intent === "retry") {
    const env = context.cloudflare.env
    const jobId = String(body.get("job_id") ?? "")
    const now = Date.now()
    const claimed = await env.DB
      .prepare(`
        UPDATE delivery_jobs
        SET
          status = 'pending',
          available_at = ?,
          last_error = NULL,
          dead_lettered_at = NULL,
          attempt_count = 0,
          updated_at = ?
        WHERE id = ? AND form_id = ?
          AND kind = 'notification_email'
          AND status = 'failed'
      `)
      .bind(now, now, jobId, params.formId)
      .run()
    if (claimed.meta.changes === 0) {
      return data(
        { success: false, error: "Only a failed delivery can be retried." },
        { status: 409 }
      )
    }
    await publishDeliveryJobs({
      db: env.DB,
      queue: env.DELIVERY_QUEUE,
      jobs: [{ id: jobId, kind: "notification_email", targetId: null }],
    })
    return data({ success: true })
  }

  const rawPolicy = body.get("policy")
  if (typeof rawPolicy !== "string") {
    return data({ success: false, error: "Policy is missing." }, { status: 400 })
  }
  const policy = JSON.parse(rawPolicy) as FormPolicyV1
  if (!policy.notifications.recipients.length) {
    return data(
      { success: false, error: "Add at least one recipient first." },
      { status: 400 }
    )
  }
  const transport = await resolveEmailTransport({
    env: context.cloudflare.env,
    db: context.cloudflare.env.DB,
  })
  if (!transport) {
    return data(
      {
        success: false,
        error: "Configure a global email transport first.",
      },
      { status: 503 }
    )
  }
  const formName = String(body.get("form_name") ?? params.formId)
  const rendered = renderSubmissionNotification({
    id: "test",
    formId: params.formId,
    formName,
    data: { message: "This is a FormZero notification test." },
    createdAt: Date.now(),
    subject: policy.notifications.subjectTemplate?.replace(
      /\{\{\s*form\.name\s*\}\}/g,
      formName
    ),
    fields: policy.fields,
  })
  try {
    await transport.send({
      to: policy.notifications.recipients,
      from: transport.from,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    })
    return data({ success: true, transport: transport.kind })
  } catch (error) {
    return data(
      {
        success: false,
        error:
          error instanceof EmailSendError
            ? error.message
            : "The test email could not be sent.",
      },
      { status: 400 }
    )
  }
}

export default function NotificationSettings() {
  const { form, capabilities } =
    useOutletContext<SettingsOutletContext>()
  const { deliveryLog } = useLoaderData<typeof loader>()
  const save = useFetcher<{ success?: boolean; error?: string }>()
  const test = useFetcher<{ success?: boolean; error?: string }>()
  const retry = useFetcher<{ success?: boolean; error?: string }>()
  const [enabled, setEnabled] = useState(form.policy.notifications.enabled)
  const [recipients, setRecipients] = useState(
    form.policy.notifications.recipients.join("\n")
  )
  const [replyToField, setReplyToField] = useState(
    form.policy.notifications.replyToField ?? ""
  )
  const [subject, setSubject] = useState(
    form.policy.notifications.subjectTemplate ?? "New {{form.name}} submission"
  )
  const policy: FormPolicyV1 = {
    ...form.policy,
    notifications: {
      enabled,
      recipients: recipients
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
      replyToField: replyToField || undefined,
      subjectTemplate: subject || undefined,
    },
  }

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader><CardTitle>Email notifications</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!capabilities.emailTransport && !enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable per-form notifications
        </label>
        {!capabilities.emailTransport && (
          <p className="text-sm text-muted-foreground">
            No global email transport is configured yet. Open global notification
            settings and choose Cloudflare Email Service or custom SMTP.
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="recipients">Recipients</Label>
          <textarea
            id="recipients"
            className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
            value={recipients}
            onChange={(event) => setRecipients(event.target.value)}
            placeholder="owner@example.com"
          />
          <p className="text-xs text-muted-foreground">
            One address per line. Changes apply to new submissions: anything
            already queued is delivered to the recipients configured when it was
            received.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="reply-to">Reply-to field</Label>
          <select
            id="reply-to"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={replyToField}
            onChange={(event) => setReplyToField(event.target.value)}
          >
            <option value="">None</option>
            {form.policy.fields
              .filter((field) => field.type === "email")
              .map((field) => (
                <option key={field.name} value={field.name}>
                  {field.label ?? field.name}
                </option>
              ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="subject">Subject template</Label>
          <Input
            id="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <save.Form method="post">
            <input type="hidden" name="revision" value={form.configRevision} />
            <input type="hidden" name="policy" value={JSON.stringify(policy)} />
            <Button disabled={save.state !== "idle"}>Save notifications</Button>
          </save.Form>
          <test.Form method="post">
            <input type="hidden" name="intent" value="test" />
            <input type="hidden" name="form_name" value={form.name} />
            <input type="hidden" name="policy" value={JSON.stringify(policy)} />
            <Button variant="outline" disabled={test.state !== "idle"}>
              Send test
            </Button>
          </test.Form>
        </div>
        {(save.data?.error || test.data?.error) && (
          <p className="text-sm text-destructive">
            {save.data?.error ?? test.data?.error}
          </p>
        )}
        {test.data?.success && (
          <p className="text-sm text-green-600">Test email sent.</p>
        )}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Delivery log</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {deliveryLog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No notification emails have been queued for this form yet.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {deliveryLog.map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 space-y-1">
                  <p>
                    <span
                      className={
                        job.status === "failed"
                          ? "font-medium text-destructive"
                          : "font-medium"
                      }
                    >
                      {job.status}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      · attempt {job.attempt_count} ·{" "}
                      {new Date(job.created_at).toLocaleString()}
                    </span>
                  </p>
                  {job.dead_lettered_at !== null && (
                    <p className="text-destructive">
                      Gave up after every retry on{" "}
                      {new Date(job.dead_lettered_at).toLocaleString()}. Fix the
                      cause below, then retry.
                    </p>
                  )}
                  {job.last_error && (
                    <p className="break-words text-muted-foreground">
                      {job.last_error}
                    </p>
                  )}
                </div>
                {job.status === "failed" && (
                  <retry.Form method="post" className="shrink-0">
                    <input type="hidden" name="intent" value="retry" />
                    <input type="hidden" name="job_id" value={job.id} />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retry.state !== "idle"}
                    >
                      Retry
                    </Button>
                  </retry.Form>
                )}
              </li>
            ))}
          </ul>
        )}
        {retry.data?.error && (
          <p className="text-sm text-destructive">{retry.data.error}</p>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
