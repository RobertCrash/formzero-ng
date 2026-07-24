import type { FormPolicyV1 } from "../form-config/types"
import { SubmissionError } from "./errors"

export type ParsedSubmissionRequest = {
  encoding: "json" | "urlencoded" | "multipart"
  fields: Record<string, unknown>
  files: Record<string, File[]>
  payloadBytes: number
}

async function readBodyWithLimit(request: Request, maxBytes: number) {
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new SubmissionError(
        "payload_too_large",
        "The request payload exceeds the configured limit."
      )
    }
    chunks.push(value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
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

  const body = await readBodyWithLimit(request, policy.request.maxPayloadBytes)
  const parsedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  })

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
        payloadBytes: body.byteLength,
      }
    }

    const formData = await parsedRequest.formData()
    const values = formDataToValues(formData)
    return {
      encoding:
        contentType === "multipart/form-data" ? "multipart" : "urlencoded",
      ...values,
      payloadBytes: body.byteLength,
    }
  } catch (error) {
    if (error instanceof SubmissionError) throw error
    throw new SubmissionError("malformed_request", "The request body is malformed.")
  }
}
