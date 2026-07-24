import { useState } from "react"
import { data, useFetcher, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.security"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import { putSecret } from "~/lib/secrets/secret-store.server"
import type { FormPolicyV1 } from "~/lib/form-config/types"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

export async function action({ request, params, context }: Route.ActionArgs) {
  const formData = await request.clone().formData()
  const turnstileSecret = String(formData.get("turnstile_secret") ?? "")
  if (!turnstileSecret) {
    return savePolicyRequest({
      request,
      formId: params.formId,
      env: context.cloudflare.env,
    })
  }

  const encryptionKey = (
    context.cloudflare.env as Env & { FORMZERO_ENCRYPTION_KEY?: string }
  ).FORMZERO_ENCRYPTION_KEY
  if (!encryptionKey) {
    return data(
      { success: false, error: "FORMZERO_ENCRYPTION_KEY is not configured." },
      { status: 503 }
    )
  }
  const rawPolicy = formData.get("policy")
  if (typeof rawPolicy !== "string") {
    return data({ success: false, error: "Policy is missing." }, { status: 400 })
  }
  const policy = JSON.parse(rawPolicy) as FormPolicyV1
  const existingId =
    policy.security.captcha.enabled
      ? policy.security.captcha.credentialId
      : undefined
  const credentialId = await putSecret({
    db: context.cloudflare.env.DB,
    encryptionKey,
    formId: params.formId,
    purpose: "turnstile_secret",
    value: turnstileSecret,
    secretId: existingId,
  })
  if (policy.security.captcha.enabled) {
    policy.security.captcha.credentialId = credentialId
  }
  const replacement = new FormData()
  replacement.set("revision", String(formData.get("revision")))
  replacement.set("policy", JSON.stringify(policy))
  const headers = new Headers(request.headers)
  headers.delete("Content-Type")
  headers.delete("Content-Length")
  return savePolicyRequest({
    request: new Request(request.url, {
      method: "POST",
      headers,
      body: replacement,
    }),
    formId: params.formId,
    env: context.cloudflare.env,
  })
}

export default function SecuritySettings() {
  const { form, capabilities } =
    useOutletContext<SettingsOutletContext>()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [origins, setOrigins] = useState(
    form.policy.security.allowedOrigins.join("\n")
  )
  const [allowMissingOrigin, setAllowMissingOrigin] = useState(
    form.policy.security.allowMissingOrigin
  )
  const [captchaEnabled, setCaptchaEnabled] = useState(
    form.policy.security.captcha.enabled
  )
  const [siteKey, setSiteKey] = useState(
    form.policy.security.captcha.enabled
      ? form.policy.security.captcha.siteKey
      : ""
  )
  const [expectedAction, setExpectedAction] = useState(
    form.policy.security.captcha.enabled
      ? form.policy.security.captcha.expectedAction ?? ""
      : ""
  )
  const [turnstileSecret, setTurnstileSecret] = useState("")
  const [honeypotEnabled, setHoneypotEnabled] = useState(
    form.policy.security.honeypot.enabled
  )
  const [minimumFillTime, setMinimumFillTime] = useState(
    form.policy.security.honeypot.minimumFillTimeMs ?? 1_500
  )
  const [rateProfile, setRateProfile] = useState<
    "off" | "strict" | "standard" | "relaxed"
  >(
    form.policy.security.rateLimit.enabled
      ? form.policy.security.rateLimit.profile
      : "off"
  )
  const [ipMode, setIpMode] = useState(form.policy.privacy.ipMode)

  const previousCaptcha = form.policy.security.captcha
  const policy: FormPolicyV1 = {
    ...form.policy,
    security: {
      ...form.policy.security,
      allowedOrigins: origins
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      allowMissingOrigin,
      captcha: captchaEnabled
        ? {
            enabled: true,
            provider: "turnstile",
            siteKey,
            expectedAction: expectedAction || undefined,
            credentialId: previousCaptcha.enabled
              ? previousCaptcha.credentialId
              : undefined,
          }
        : { enabled: false },
      honeypot: {
        ...form.policy.security.honeypot,
        enabled: honeypotEnabled,
        minimumFillTimeMs: minimumFillTime,
      },
      rateLimit:
        rateProfile === "off"
          ? { enabled: false }
          : { enabled: true, profile: rateProfile, key: "ip-and-form" },
    },
    privacy: { ...form.policy.privacy, ipMode },
  }

  return (
    <Card>
      <CardHeader><CardTitle>Security and privacy</CardTitle></CardHeader>
      <CardContent>
        <fetcher.Form method="post" className="space-y-5">
          <input type="hidden" name="revision" value={form.configRevision} />
          <input type="hidden" name="policy" value={JSON.stringify(policy)} />
          <div className="space-y-2">
            <Label htmlFor="allowed-origins">Allowed origins</Label>
            <textarea
              id="allowed-origins"
              className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
              value={origins}
              onChange={(event) => setOrigins(event.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowMissingOrigin}
              onChange={(event) => setAllowMissingOrigin(event.target.checked)}
            />
            Allow requests without an Origin header
          </label>
          {allowMissingOrigin && (
            <p className="text-sm text-amber-600">
              Missing origins allow server and command-line clients and reduce
              browser-origin protection.
            </p>
          )}
          <div className="space-y-3 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={captchaEnabled}
                disabled={!capabilities.turnstile}
                onChange={(event) => setCaptchaEnabled(event.target.checked)}
              />
              Enable Cloudflare Turnstile
            </label>
            {captchaEnabled && (
              <>
                <Input
                  placeholder="Turnstile site key"
                  value={siteKey}
                  onChange={(event) => setSiteKey(event.target.value)}
                />
                <Input
                  name="turnstile_secret"
                  type="password"
                  placeholder={
                    previousCaptcha.enabled && previousCaptcha.credentialId
                      ? "Leave blank to keep saved secret"
                      : "Turnstile secret"
                  }
                  value={turnstileSecret}
                  onChange={(event) => setTurnstileSecret(event.target.value)}
                />
                <Input
                  placeholder="Expected action (optional)"
                  value={expectedAction}
                  onChange={(event) => setExpectedAction(event.target.value)}
                />
              </>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={honeypotEnabled}
              onChange={(event) => setHoneypotEnabled(event.target.checked)}
            />
            Enable honeypot
          </label>
          <div className="space-y-2">
            <Label htmlFor="fill-time">Minimum completion time (ms)</Label>
            <Input
              id="fill-time"
              type="number"
              value={minimumFillTime}
              onChange={(event) => setMinimumFillTime(Number(event.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rate-profile">Rate-limit profile</Label>
            <select
              id="rate-profile"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={rateProfile}
              disabled={!capabilities.rateLimiting}
              onChange={(event) =>
                setRateProfile(event.target.value as typeof rateProfile)
              }
            >
              <option value="off">Off</option>
              <option value="strict">Strict (5/min)</option>
              <option value="standard">Standard (15/min)</option>
              <option value="relaxed">Relaxed (60/min)</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ip-mode">IP storage</Label>
            <select
              id="ip-mode"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={ipMode}
              onChange={(event) =>
                setIpMode(event.target.value as typeof ipMode)
              }
            >
              <option value="full">Full IP + keyed hash</option>
              <option value="hashed">Keyed hash only</option>
              <option value="none">Do not retain</option>
            </select>
          </div>
          {fetcher.data?.error && (
            <p className="text-sm text-destructive">{fetcher.data.error}</p>
          )}
          <Button disabled={fetcher.state !== "idle"}>Save security</Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  )
}
