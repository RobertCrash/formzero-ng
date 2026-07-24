import { useMemo, useState } from "react"
import { useFetcher, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.advanced"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"

export async function action({ request, params, context }: Route.ActionArgs) {
  return savePolicyRequest({
    request,
    formId: params.formId,
    env: context.cloudflare.env,
  })
}

export default function AdvancedSettings() {
  const { form } = useOutletContext<SettingsOutletContext>()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const original = useMemo(
    () => JSON.stringify(form.policy, null, 2),
    [form.policy]
  )
  const [value, setValue] = useState(original)
  const [showDiff, setShowDiff] = useState(false)
  let formatted = value
  let parseError: string | null = null
  try {
    formatted = JSON.stringify(JSON.parse(value), null, 2)
  } catch (error) {
    parseError = error instanceof Error ? error.message : "Invalid JSON"
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced policy JSON</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Schema version {form.configSchemaVersion}, revision{" "}
          {form.configRevision}. Secret values are rejected.
        </p>
        <textarea
          className="min-h-[32rem] w-full rounded-md border bg-background p-3 font-mono text-xs"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setShowDiff(false)
          }}
          spellCheck={false}
        />
        {parseError && <p className="text-sm text-destructive">{parseError}</p>}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(parseError)}
            onClick={() => {
              setValue(formatted)
              setShowDiff(true)
            }}
          >
            Format and preview
          </Button>
          <fetcher.Form method="post">
            <input type="hidden" name="revision" value={form.configRevision} />
            <input type="hidden" name="policy" value={value} />
            <Button
              disabled={
                Boolean(parseError) || !showDiff || fetcher.state !== "idle"
              }
            >
              Save JSON
            </Button>
          </fetcher.Form>
        </div>
        {showDiff && (
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 text-sm font-medium">Current</p>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                {original}
              </pre>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Proposed</p>
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
                {formatted}
              </pre>
            </div>
          </div>
        )}
        {fetcher.data?.error && (
          <p className="text-sm text-destructive">{fetcher.data.error}</p>
        )}
      </CardContent>
    </Card>
  )
}
