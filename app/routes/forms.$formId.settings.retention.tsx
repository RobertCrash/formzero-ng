import { useState } from "react"
import { useFetcher, useLoaderData, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.retention"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { requireAuth } from "~/lib/require-auth.server"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import type { FormPolicyV1 } from "~/lib/form-config/types"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

const DAY_MS = 86_400_000

export async function loader({ request, params, context }: Route.LoaderArgs) {
  await requireAuth(request, context.cloudflare.env.DB)
  const counts = await context.cloudflare.env.DB
    .prepare(`
      SELECT
        COUNT(*) AS submissions,
        (SELECT COUNT(*) FROM submission_files WHERE form_id = ?) AS files
      FROM submissions
      WHERE form_id = ?
    `)
    .bind(params.formId, params.formId)
    .first<{ submissions: number; files: number }>()
  return { counts: counts ?? { submissions: 0, files: 0 } }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const body = await request.clone().formData()
  const result = await savePolicyRequest({
    request,
    formId: params.formId,
    env: context.cloudflare.env,
  })
  if (result.init?.status && result.init.status >= 400) return result
  if (body.get("apply_existing") !== "1") return result

  const rawPolicy = body.get("policy")
  if (typeof rawPolicy !== "string") return result
  const policy = JSON.parse(rawPolicy) as FormPolicyV1
  const submissionOffset =
    policy.retention.submissionsDays === null
      ? null
      : policy.retention.submissionsDays * DAY_MS
  const fileOffset =
    policy.retention.filesDays === null
      ? null
      : policy.retention.filesDays * DAY_MS
  const ipOffset =
    policy.privacy.ipRetentionDays === null
      ? null
      : policy.privacy.ipRetentionDays * DAY_MS
  await context.cloudflare.env.DB.batch([
    context.cloudflare.env.DB
      .prepare(`
        UPDATE submissions
        SET
          delete_after = CASE WHEN ? IS NULL THEN NULL ELSE created_at + ? END,
          ip_delete_after = CASE WHEN ? IS NULL THEN NULL ELSE created_at + ? END
        WHERE form_id = ?
      `)
      .bind(
        submissionOffset,
        submissionOffset,
        ipOffset,
        ipOffset,
        params.formId
      ),
    context.cloudflare.env.DB
      .prepare(`
        UPDATE submission_files
        SET delete_after = CASE WHEN ? IS NULL THEN NULL ELSE created_at + ? END
        WHERE form_id = ?
      `)
      .bind(fileOffset, fileOffset, params.formId),
  ])
  return result
}

function RetentionInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange(value: number | null): void
}) {
  const preset = value === null ? "forever" : [30, 90, 180, 365].includes(value) ? String(value) : "custom"
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <select
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        value={preset}
        onChange={(event) => {
          if (event.target.value === "forever") onChange(null)
          else if (event.target.value !== "custom") onChange(Number(event.target.value))
        }}
      >
        <option value="forever">Keep forever</option>
        <option value="30">30 days</option>
        <option value="90">90 days</option>
        <option value="180">180 days</option>
        <option value="365">365 days</option>
        <option value="custom">Custom</option>
      </select>
      {preset === "custom" && (
        <Input
          type="number"
          min={1}
          value={value ?? 1}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      )}
    </div>
  )
}

export default function RetentionSettings() {
  const { form } = useOutletContext<SettingsOutletContext>()
  const { counts } = useLoaderData<typeof loader>()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [submissionsDays, setSubmissionsDays] = useState(
    form.policy.retention.submissionsDays
  )
  const [filesDays, setFilesDays] = useState(form.policy.retention.filesDays)
  const [ipDays, setIpDays] = useState(form.policy.privacy.ipRetentionDays)
  const [applyExisting, setApplyExisting] = useState(false)
  const policy: FormPolicyV1 = {
    ...form.policy,
    retention: { submissionsDays, filesDays },
    privacy: { ...form.policy.privacy, ipRetentionDays: ipDays },
  }

  return (
    <Card>
      <CardHeader><CardTitle>Retention</CardTitle></CardHeader>
      <CardContent>
        <fetcher.Form method="post" className="space-y-5">
          <input type="hidden" name="revision" value={form.configRevision} />
          <input type="hidden" name="policy" value={JSON.stringify(policy)} />
          <input
            type="hidden"
            name="apply_existing"
            value={applyExisting ? "1" : "0"}
          />
          <RetentionInput
            label="Submission data"
            value={submissionsDays}
            onChange={setSubmissionsDays}
          />
          <RetentionInput
            label="Uploaded files"
            value={filesDays}
            onChange={setFilesDays}
          />
          <RetentionInput
            label="Raw IP addresses"
            value={ipDays}
            onChange={setIpDays}
          />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={applyExisting}
              onChange={(event) => setApplyExisting(event.target.checked)}
            />
            Apply these timestamps to {counts.submissions} existing submissions
            and {counts.files} files
          </label>
          {applyExisting && (
            <p className="text-sm text-amber-600">
              Shorter periods can make existing data eligible for deletion at
              the next maintenance run.
            </p>
          )}
          {fetcher.data?.error && (
            <p className="text-sm text-destructive">{fetcher.data.error}</p>
          )}
          <Button disabled={fetcher.state !== "idle"}>Save retention</Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  )
}
