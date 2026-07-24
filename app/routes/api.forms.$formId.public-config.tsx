import { data } from "react-router"
import type { Route } from "./+types/api.forms.$formId.public-config"
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server"
import { resolveCorsHeaders } from "~/lib/submissions/validate-origin"

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const form = await loadFormWithPolicy(context.cloudflare.env.DB, params.formId)
  if (!form) {
    return data({ success: false, error: "Form not found." }, { status: 404 })
  }
  const headers = resolveCorsHeaders(request, form.policy.security)
  headers.set("Cache-Control", "public, max-age=60")
  return data(
    {
      formId: form.id,
      fields: form.policy.fields,
      captcha: form.policy.security.captcha.enabled
        ? {
            enabled: true,
            provider: "turnstile",
            siteKey: form.policy.security.captcha.siteKey,
            expectedAction: form.policy.security.captcha.expectedAction,
          }
        : { enabled: false },
      honeypot: form.policy.security.honeypot.enabled
        ? {
            enabled: true,
            fieldName: form.policy.security.honeypot.fieldName,
            startedAtFieldName:
              form.policy.security.honeypot.startedAtFieldName,
          }
        : { enabled: false },
      uploads: {
        enabled: form.policy.uploads.enabled,
        mode: form.policy.uploads.mode,
        maxFiles: form.policy.uploads.maxFiles,
        maxFileBytes: form.policy.uploads.maxFileBytes,
        maxTotalBytes: form.policy.uploads.maxTotalBytes,
        allowedMimeTypes: form.policy.uploads.allowedMimeTypes,
        allowedExtensions: form.policy.uploads.allowedExtensions,
      },
    },
    { headers }
  )
}
