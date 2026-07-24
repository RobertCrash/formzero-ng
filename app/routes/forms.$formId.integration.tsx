import { useState } from "react"
import { useLoaderData } from "react-router"
import type { Route } from "./+types/forms.$formId.integration"
import { Copy, Check } from "lucide-react"
import { Highlight, themes } from "prism-react-renderer"
import { requireAuth } from "~/lib/require-auth.server"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import type { FieldRule } from "~/lib/form-config/types"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs"
import { Button } from "~/components/ui/button"

export async function loader({ request, params, context }: Route.LoaderArgs) {
  await requireAuth(request, context.cloudflare.env.DB)
  const form = await loadFormWithPolicy(context.cloudflare.env.DB, params.formId)
  if (!form) throw new Response("Form not found", { status: 404 })
  return { form }
}

function htmlField(field: FieldRule) {
  const required = field.required ? " required" : ""
  const minLength =
    field.minLength !== undefined ? ` minlength="${field.minLength}"` : ""
  const maxLength =
    field.maxLength !== undefined ? ` maxlength="${field.maxLength}"` : ""
  const min = field.minimum !== undefined ? ` min="${field.minimum}"` : ""
  const max = field.maximum !== undefined ? ` max="${field.maximum}"` : ""
  const label = field.label ?? field.name
  if (field.type === "select") {
    return `  <label>${label}
    <select name="${field.name}"${required}>
${(field.options ?? []).map((option) => `      <option value="${option}">${option}</option>`).join("\n")}
    </select>
  </label>`
  }
  const type =
    field.type === "datetime"
      ? "datetime-local"
      : field.type === "string" || field.type === "string-array"
        ? "text"
        : field.type === "files"
          ? "file"
          : field.type
  const multiple =
    field.type === "files" || field.type === "string-array" ? " multiple" : ""
  return `  <label>${label}
    <input type="${type}" name="${field.name}"${required}${minLength}${maxLength}${min}${max}${multiple} />
  </label>`
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-2 top-2 z-10"
        onClick={async () => {
          await navigator.clipboard.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 2_000)
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
      <Highlight theme={themes.vsDark} code={code} language={language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={className}
            style={{ ...style, padding: "1rem", overflowX: "auto", borderRadius: "0.375rem" }}
          >
            {tokens.map((line, index) => (
              <div key={index} {...getLineProps({ line })}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  )
}

export default function IntegrationPage() {
  const { form } = useLoaderData<typeof loader>()
  const baseUrl = typeof window === "undefined" ? "" : window.location.origin
  const endpoint = `${baseUrl}/api/forms/${form.id}/submissions`
  const multipart =
    form.policy.uploads.enabled && form.policy.uploads.mode === "inline"
      ? ' enctype="multipart/form-data"'
      : ""
  const honeypot = form.policy.security.honeypot.enabled
    ? `  <input type="text" name="${form.policy.security.honeypot.fieldName}" tabindex="-1" autocomplete="off" hidden />
  <input type="hidden" name="${form.policy.security.honeypot.startedAtFieldName ?? "_fz_started_at"}" value="" data-formzero-started-at />`
    : ""
  const turnstile = form.policy.security.captcha.enabled
    ? `  <div class="cf-turnstile" data-sitekey="${form.policy.security.captcha.siteKey}"${form.policy.security.captcha.expectedAction ? ` data-action="${form.policy.security.captcha.expectedAction}"` : ""}></div>`
    : ""
  const html = `${form.policy.security.captcha.enabled ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n' : ""}<form action="${endpoint}" method="POST"${multipart}>
${form.policy.fields.map(htmlField).join("\n")}
${honeypot}
${turnstile}
  <button type="submit">Submit</button>
</form>${form.policy.security.honeypot.enabled ? `\n<script>document.querySelector('[data-formzero-started-at]').value = Date.now()</script>` : ""}`
  const javascript = `const response = await fetch('${endpoint}', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  body: JSON.stringify({
${form.policy.fields
  .filter((field) => field.type !== "file" && field.type !== "files")
  .map((field) => `    ${JSON.stringify(field.name)}: ''`)
  .join(",\n")}
  })
})

const result = await response.json()
if (!response.ok) {
  console.error(result.error.code, result.error.fields, result.error.requestId)
  throw new Error(result.error.message)
}
console.log('Submission:', result.id)${
    form.policy.uploads.enabled && form.policy.uploads.mode === "direct"
      ? `\n\n// Direct uploads: POST metadata to /api/forms/${form.id}/uploads,\n// PUT each file to the returned uploadUrl, complete the session,\n// then include uploadTokens as _fz_upload_tokens in the submission.`
      : ""
  }`
  const publicConfig = `const config = await fetch(
  '${baseUrl}/api/forms/${form.id}/public-config',
  { headers: { Accept: 'application/json' } }
).then(response => response.json())`

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Endpoint</CardTitle></CardHeader>
        <CardContent>
          <code className="break-all rounded bg-muted px-3 py-2 text-sm">
            {endpoint}
          </code>
          <p className="mt-2 text-sm text-muted-foreground">
            Allowed origins:{" "}
            {form.policy.security.allowedOrigins.join(", ") || "legacy unrestricted"}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Policy-aware examples</CardTitle></CardHeader>
        <CardContent>
          <Tabs defaultValue="html">
            <TabsList>
              <TabsTrigger value="html">HTML</TabsTrigger>
              <TabsTrigger value="javascript">JavaScript</TabsTrigger>
              <TabsTrigger value="config">Public config</TabsTrigger>
            </TabsList>
            <TabsContent value="html"><CodeBlock code={html} language="markup" /></TabsContent>
            <TabsContent value="javascript"><CodeBlock code={javascript} language="javascript" /></TabsContent>
            <TabsContent value="config"><CodeBlock code={publicConfig} language="javascript" /></TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
