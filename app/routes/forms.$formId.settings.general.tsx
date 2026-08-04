import { useState } from "react"
import {
  data,
  redirect,
  useFetcher,
  useOutletContext,
} from "react-router"
import type { Route } from "./+types/forms.$formId.settings.general"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { requireAuth } from "~/lib/require-auth.server"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { requestFormDeletion } from "~/lib/uploads/delete-form.server"

export async function action({ request, params, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB
  await requireAuth(request, db)

  if (request.method === "DELETE") {
    const result = await requestFormDeletion({ db, formId: params.formId })
    if (!result.found) {
      return data({ success: false, error: "Form not found." }, { status: 404 })
    }
    return redirect("/forms")
  }

  const clone = request.clone()
  const body = await clone.formData()
  if (body.get("intent") === "rename") {
    const name = String(body.get("name") ?? "").trim()
    if (!name) {
      return data(
        { success: false, error: "Form name is required." },
        { status: 400 }
      )
    }
    await db
      .prepare("UPDATE forms SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, Date.now(), params.formId)
      .run()
    return data({ success: true })
  }

  return savePolicyRequest({
    request,
    formId: params.formId,
    env: context.cloudflare.env,
  })
}

export default function GeneralSettings() {
  const { form } = useOutletContext<SettingsOutletContext>()
  const rename = useFetcher<{ success?: boolean; error?: string }>()
  const policySave = useFetcher<{ success?: boolean; error?: string }>()
  const deletion = useFetcher()
  const [name, setName] = useState(form.name)
  const [successUrl, setSuccessUrl] = useState(
    form.policy.redirects.successUrl ?? ""
  )
  const [errorUrl, setErrorUrl] = useState(form.policy.redirects.errorUrl ?? "")
  const [origins, setOrigins] = useState(
    form.policy.redirects.allowedOrigins.join("\n")
  )

  const policy = {
    ...form.policy,
    redirects: {
      successUrl: successUrl.trim() || undefined,
      errorUrl: errorUrl.trim() || undefined,
      allowedOrigins: origins
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    },
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader><CardTitle>General</CardTitle></CardHeader>
        <CardContent>
          <rename.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="rename" />
            <Label htmlFor="form-name">Form name</Label>
            <Input
              id="form-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Form ID: {form.id}</p>
            {rename.data?.error && (
              <p className="text-sm text-destructive">{rename.data.error}</p>
            )}
            <Button disabled={rename.state !== "idle"}>Save name</Button>
          </rename.Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Redirects</CardTitle></CardHeader>
        <CardContent>
          <policySave.Form method="post" className="space-y-4">
            <input type="hidden" name="revision" value={form.configRevision} />
            <input type="hidden" name="policy" value={JSON.stringify(policy)} />
            <div className="space-y-2">
              <Label htmlFor="success-url">Success URL</Label>
              <Input
                id="success-url"
                type="url"
                value={successUrl}
                onChange={(event) => setSuccessUrl(event.target.value)}
                placeholder="https://example.com/thanks"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="error-url">Error URL</Label>
              <Input
                id="error-url"
                type="url"
                value={errorUrl}
                onChange={(event) => setErrorUrl(event.target.value)}
                placeholder="https://example.com/form-error"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="redirect-origins">Allowed redirect origins</Label>
              <textarea
                id="redirect-origins"
                className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
                placeholder="https://example.com"
              />
            </div>
            {policySave.data?.error && (
              <p className="text-sm text-destructive">{policySave.data.error}</p>
            )}
            <Button disabled={policySave.state !== "idle"}>Save redirects</Button>
          </policySave.Form>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader><CardTitle>Danger zone</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The form stops accepting submissions immediately and disappears from
            the dashboard. Stored submissions and uploaded files are erased by the
            next maintenance run.
          </p>
          <Button
            variant="destructive"
            disabled={deletion.state !== "idle"}
            onClick={() => {
              if (window.confirm(`Delete "${form.name}" and all of its data?`)) {
                deletion.submit(null, { method: "delete" })
              }
            }}
          >
            Delete form
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
