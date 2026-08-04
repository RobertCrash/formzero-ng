import type { FormPolicyV1 } from "../form-config/types"
import {
  ByteLimitExceededError,
  createByteLimiter,
} from "../uploads/limited-stream"
import { SubmissionError } from "./errors"

export type ParsedSubmissionRequest = {
  encoding: "json" | "urlencoded" | "multipart"
  fields: Record<string, unknown>
  files: Record<string, File[]>
  payloadBytes: number
}


function formDataToValues(formData: FormData) {
  const fields: Record<string, unknown> = {}
  const files: Record<string, File[]> = {}

  for (const name of new Set(formData.keys())) {
    const values = formData.getAll(name)
    const textValues = values.filter(
      (value): value is string => typeof value === "string"
    )
    const fileValues = values.filter(
      (value): value is File => value instanceof File && value.size > 0
    )

    if (textValues.length === 1) fields[name] = textValues[0]
    if (textValues.length > 1) fields[name] = textValues
    if (fileValues.length > 0) files[name] = fileValues
  }

  return { fields, files }
}

export async function parseSubmissionRequest({
  request,
  policy,
}: {
  request: Request
  policy: FormPolicyV1
}): Promise<ParsedSubmissionRequest> {
  const contentTypeHeader = request.headers.get("Content-Type") ?? ""
  const contentType = contentTypeHeader.split(";", 1)[0].trim().toLowerCase()

  if (
    !policy.request.allowedContentTypes.includes(
      contentType as FormPolicyV1["request"]["allowedContentTypes"][number]
    )
  ) {
    throw new SubmissionError(
      "unsupported_content_type",
      "This content type is not accepted by the form."
    )
  }

  const declaredSize = Number(request.headers.get("Content-Length"))
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > policy.request.maxPayloadBytes
  ) {
    throw new SubmissionError(
      "payload_too_large",
      "The request payload exceeds the configured limit."
    )
  }

  // Counted as it is parsed rather than buffered twice: the previous version
  // collected every chunk and then copied them into a second Uint8Array, so
  // peak memory was double the payload before parsing even started.
  const limited = createByteLimiter(policy.request.maxPayloadBytes)
  const parsedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body?.pipeThrough(limited.stream) ?? null,
    // Required whenever the body is a stream: the request finishes sending
    // before the response is read.
    duplex: "half",
  } as RequestInit & { duplex: "half" })

  try {
    if (contentType === "application/json") {
      const value = await parsedRequest.json()
      if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new SubmissionError(
          "malformed_request",
          "The JSON body must be an object."
        )
      }
      return {
        encoding: "json",
        fields: value as Record<string, unknown>,
        files: {},
        payloadBytes: limited.bytesRead(),
      }
    }

    const formData = await parsedRequest.formData()
    const values = formDataToValues(formData)
    return {
      encoding:
        contentType === "multipart/form-data" ? "multipart" : "urlencoded",
      ...values,
      payloadBytes: limited.bytesRead(),
    }
  } catch (error) {
    if (error instanceof SubmissionError) throw error
    // The limit errors the stream mid-parse, so it arrives here as a body
    // failure and has to be told apart from genuinely malformed input.
    if (
      error instanceof ByteLimitExceededError ||
      limited.bytesRead() > policy.request.maxPayloadBytes
    ) {
      throw new SubmissionError(
        "payload_too_large",
        "The request payload exceeds the configured limit."
      )
    }
    throw new SubmissionError("malformed_request", "The request body is malformed.")
  }
}
