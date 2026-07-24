import { data, redirect } from "react-router"
import type { FormPolicyV1 } from "../form-config/types"
import { SubmissionError } from "./errors"
import { validateRedirectUrl } from "./validate-redirect"

export function wantsJson(request: Request) {
  return (
    request.headers.get("Accept")?.includes("application/json") ||
    request.headers.get("Content-Type")?.includes("application/json") ||
    false
  )
}

export function submissionSuccess({
  request,
  submissionId,
  requestId,
  cors,
  redirects,
}: {
  request: Request
  submissionId?: string
  requestId: string
  cors: Headers
  redirects: FormPolicyV1["redirects"]
}) {
  if (wantsJson(request)) {
    return data(
      { success: true, id: submissionId, requestId },
      { status: submissionId ? 201 : 200, headers: cors }
    )
  }

  const destination =
    validateRedirectUrl(
      redirects.successUrl,
      redirects,
      import.meta.env?.MODE !== "production"
    ) ?? "/success"
  return redirect(destination, 303)
}

export function submissionFailure({
  request,
  error,
  requestId,
  cors,
  redirects,
}: {
  request: Request
  error: unknown
  requestId: string
  cors: Headers
  redirects?: FormPolicyV1["redirects"]
}) {
  const normalized =
    error instanceof SubmissionError
      ? error
      : new SubmissionError(
          "internal_error",
          "The submission could not be processed."
        )

  if (wantsJson(request)) {
    return data(
      {
        success: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          fields: normalized.fields,
          requestId,
        },
      },
      { status: normalized.status, headers: cors }
    )
  }

  const configured = redirects
    ? validateRedirectUrl(
        redirects.errorUrl,
        redirects,
        import.meta.env?.MODE !== "production"
      )
    : null
  const target = new URL(configured ?? "/error", request.url)
  target.searchParams.set("error", normalized.code)
  target.searchParams.set("request_id", requestId)
  return redirect(
    configured ? target.toString() : `${target.pathname}${target.search}`,
    303
  )
}
