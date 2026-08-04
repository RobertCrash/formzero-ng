import { describe, expect, it } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"
import { parseSubmissionRequest } from "../submissions/parse-request.server"
import { SubmissionError } from "../submissions/errors"
import { ByteLimitExceededError, createByteLimiter } from "./limited-stream"

function streamOf(...chunks: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

describe("createByteLimiter", () => {
  it("passes data through and reports the total", async () => {
    const limiter = createByteLimiter(100)
    const text = await drain(streamOf("hello ", "world").pipeThrough(limiter.stream))
    expect(text).toBe("hello world")
    expect(limiter.bytesRead()).toBe(11)
  })

  it("errors on the chunk that crosses the limit, not at the end", async () => {
    const limiter = createByteLimiter(8)
    await expect(
      drain(streamOf("12345678", "9", "10", "11").pipeThrough(limiter.stream))
    ).rejects.toBeInstanceOf(ByteLimitExceededError)
    // Only the chunk that tripped the limit was counted; the rest never ran.
    expect(limiter.bytesRead()).toBe(9)
  })
})

describe("submission payload limit", () => {
  function jsonRequest(body: string, withContentLength: boolean) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (withContentLength) headers["Content-Length"] = String(body.length)
    return new Request("https://example.com/api/forms/contact/submissions", {
      method: "POST",
      headers,
      body,
    })
  }

  const policy = (() => {
    const value = createDefaultFormPolicy()
    value.request.maxPayloadBytes = 1_024
    return value
  })()

  it("rejects an oversized body declared in Content-Length before reading it", async () => {
    const error = await parseSubmissionRequest({
      request: jsonRequest(JSON.stringify({ a: "x".repeat(2_000) }), true),
      policy,
    }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(SubmissionError)
    expect(error.code).toBe("payload_too_large")
  })

  it("reports an oversized streamed body as too large, not malformed", async () => {
    const body = JSON.stringify({ a: "x".repeat(2_000) })
    const error = await parseSubmissionRequest({
      request: jsonRequest(body, false),
      policy,
    }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(SubmissionError)
    expect(error.code).toBe("payload_too_large")
  })

  it("counts the bytes it parsed", async () => {
    const body = JSON.stringify({ message: "hi" })
    const parsed = await parseSubmissionRequest({
      request: jsonRequest(body, true),
      policy,
    })
    expect(parsed.payloadBytes).toBe(body.length)
    expect(parsed.fields).toEqual({ message: "hi" })
  })
})
