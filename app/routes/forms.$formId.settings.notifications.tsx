import { useState } from "react"
import { data, useFetcher, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.notifications"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import type { FormPolicyV1 } from "~/lib/form-config/types"
import { requireAuth } from "~/lib/require-auth.server"
import { loadSmtpConfig } from "~/lib/delivery/smtp-config.server"
import { sendSubmissionNotification } from "~/lib/email.server"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

export async function action({ request, params, context }: Route.ActionArgs) {
  const body = await request.clone().formData()
  if (body.get("intent") !== "test") {
    return savePolicyRequest({
      request,
      formId: params.formId,
      env: context.cloudflare.env,
    })
  }

  await requireAuth(request, context.cloudflare.env.DB)
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
  const smtp = await loadSmtpConfig({
    db: context.cloudflare.env.DB,
    encryptionKey: (
      context.cloudflare.env as Env & { FORMZERO_ENCRYPTION_KEY?: string }
    ).FORMZERO_ENCRYPTION_KEY,
  })
  if (!smtp) {
    return data(
      { success: false, error: "Configure global SMTP settings first." },
      { status: 503 }
    )
  }
  const formName = String(body.get("form_name") ?? params.formId)
  const result = await sendSubmissionNotification(smtp, {
    id: "test",
    formId: params.formId,
    formName,
    data: { message: "This is a FormZero notification test." },
    createdAt: Date.now(),
    recipients: policy.notifications.recipients,
    subject: policy.notifications.subjectTemplate?.replace(
      /\{\{\s*form\.name\s*\}\}/g,
      formName
    ),
    fields: policy.fields,
  })
  return data(result, { status: result.success ? 200 : 400 })
}

export default function NotificationSettings() {
  const { form, capabilities } =
    useOutletContext<SettingsOutletContext>()
  const save = useFetcher<{ success?: boolean; error?: string }>()
  const test = useFetcher<{ success?: boolean; error?: string }>()
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
    <Card>
      <CardHeader><CardTitle>Email notifications</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!capabilities.backgroundDelivery && !enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable per-form notifications
        </label>
        <div className="space-y-2">
          <Label htmlFor="recipients">Recipients</Label>
          <textarea
            id="recipients"
            className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
            value={recipients}
            onChange={(event) => setRecipients(event.target.value)}
            placeholder="owner@example.com"
          />
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
  )
}
