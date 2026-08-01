import { useState } from "react"
import { useLoaderData } from "react-router"
import type { Route } from "./+types/forms.$formId.integration"
import { Copy, Check } from "lucide-react"
import { Highlight, themes } from "prism-react-renderer"
import { requireAuth } from "~/lib/require-auth.server"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import type { FieldRule, FormPolicyV1 } from "~/lib/form-config/types"
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

export function generateHtmlExample(
  endpoint: string,
  policy: FormPolicyV1
) {
  const fileFields = policy.fields.filter(
    (field) => field.type === "file" || field.type === "files"
  )
  if (policy.uploads.enabled && policy.uploads.mode === "direct" && fileFields.length) {
    return "<!-- Direct uploads require JavaScript. Use the JavaScript example. -->"
  }
  const multipart = policy.uploads.enabled && policy.uploads.mode === "inline"
  if (
    !multipart &&
    !policy.request.allowedContentTypes.includes(
      "application/x-www-form-urlencoded"
    )
  ) {
    return "<!-- This policy does not accept browser-native form encoding. Use the JavaScript example. -->"
  }
  const honeypot = policy.security.honeypot.enabled
    ? `  <input type="text" name="${policy.security.honeypot.fieldName}" tabindex="-1" autocomplete="off" hidden />
  <input type="hidden" name="${policy.security.honeypot.startedAtFieldName ?? "_fz_started_at"}" value="" data-formzero-started-at />`
    : ""
  const turnstile = policy.security.captcha.enabled
    ? `  <div class="cf-turnstile" data-sitekey="${policy.security.captcha.siteKey}"${policy.security.captcha.expectedAction ? ` data-action="${policy.security.captcha.expectedAction}"` : ""}></div>`
    : ""
  return `${policy.security.captcha.enabled ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n' : ""}<form action="${endpoint}" method="POST"${multipart ? ' enctype="multipart/form-data"' : ""}>
${policy.fields.map(htmlField).join("\n")}
${honeypot}
${turnstile}
  <button type="submit">Submit</button>
</form>${policy.security.honeypot.enabled ? `\n<script>document.querySelector('[data-formzero-started-at]').value = Date.now()</script>` : ""}`
}

export function generateJavascriptExample(
  endpoint: string,
  policy: FormPolicyV1
) {
  const values = policy.fields
    .filter((field) => field.type !== "file" && field.type !== "files")
    .map((field) => `  ${JSON.stringify(field.name)}: ''`)
  if (policy.security.honeypot.enabled) {
    values.push(
      `  ${JSON.stringify(policy.security.honeypot.fieldName)}: ''`,
      `  ${JSON.stringify(policy.security.honeypot.startedAtFieldName ?? "_fz_started_at")}: Date.now()`
    )
  }
  if (policy.security.captcha.enabled) {
    values.push(`  "cf-turnstile-response": turnstile.getResponse()`)
  }
  const objectLiteral = `const values = {\n${values.join(",\n")}\n}`
  const responseHandling = `const result = await response.json()
if (!response.ok) {
  console.error(result.error.code, result.error.fields, result.error.requestId)
  throw new Error(result.error.message)
}
console.log('Submission:', result.id)`

  if (policy.uploads.enabled && policy.uploads.mode === "direct") {
    const fileFields = policy.fields.filter(
      (field) => field.type === "file" || field.type === "files"
    )
    const selectedFiles = fileFields
      .map(
        (field) =>
          `  ...Array.from(document.querySelector('[name="${field.name}"]').files).map(file => ({ field: "${field.name}", file }))`
      )
      .join(",\n")
    return `${objectLiteral}
const selectedFiles = [
${selectedFiles}
]
const session = await fetch('${endpoint.replace(/\/submissions$/, "/uploads")}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  body: JSON.stringify({
    files: selectedFiles.map(({ field, file }) => ({
      field, name: file.name, type: file.type, size: file.size
    }))
  })
}).then(response => response.json())

await Promise.all(session.files.map((authorization, index) =>
  fetch(authorization.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': selectedFiles[index].file.type },
    body: selectedFiles[index].file
  })
))
const completed = await fetch(
  '${endpoint.replace(/\/submissions$/, "/uploads")}/' + session.sessionId + '/complete',
  { method: 'POST', headers: { 'Accept': 'application/json' } }
).then(response => response.json())
values._fz_upload_tokens = completed.uploadTokens

const response = await fetch('${endpoint}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  body: JSON.stringify(values)
})
${responseHandling}`
  }

  const acceptsJson = policy.request.allowedContentTypes.includes(
    "application/json"
  )
  if (acceptsJson) {
    return `${objectLiteral}
const response = await fetch('${endpoint}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  body: JSON.stringify(values)
})
${responseHandling}`
  }

  const usesMultipart = policy.request.allowedContentTypes.includes(
    "multipart/form-data"
  )
  const bodySetup = usesMultipart
    ? `const body = new FormData()
for (const [name, value] of Object.entries(values)) body.append(name, String(value))
${policy.fields
  .filter((field) => field.type === "file" || field.type === "files")
  .map(
    (field) =>
      `for (const file of document.querySelector('[name="${field.name}"]').files) body.append("${field.name}", file)`
  )
  .join("\n")}`
    : `const body = new URLSearchParams()
for (const [name, value] of Object.entries(values)) body.append(name, String(value))`
  return `${objectLiteral}
${bodySetup}
const response = await fetch('${endpoint}', {
  method: 'POST',
  headers: { 'Accept': 'application/json' },
  body
})
${responseHandling}`
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
  const html = generateHtmlExample(endpoint, form.policy)
  const javascript = generateJavascriptExample(endpoint, form.policy)
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
