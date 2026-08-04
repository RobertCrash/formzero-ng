import { describe, expect, it, vi } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"

const loadFormWithPolicy = vi.hoisted(() => vi.fn())

vi.mock("../form-config/load-form-policy.server", () => ({
  loadFormWithPolicy,
}))

describe("background CSV export", () => {
  it("streams CSV rows into R2 instead of buffering the full export", async () => {
    const policy = createDefaultFormPolicy()
    policy.fields = [{ name: "email", type: "email", required: true }]
    loadFormWithPolicy.mockResolvedValue({
      id: "contact",
      name: "Contact",
      configSchemaVersion: 1,
      configRevision: 1,
      policy,
    })

    const db = {
      prepare: vi.fn((query: string) => {
        if (query.includes("FROM export_jobs")) {
          return {
            bind: vi.fn(() => ({
              first: vi.fn().mockResolvedValue({
                id: "export-1",
                form_id: "contact",
              }),
            })),
          }
        }
        if (query.includes("FROM submissions")) {
          return {
            bind: vi.fn(() => ({
              all: vi.fn().mockResolvedValue({
                results: [
                  {
                    id: "submission-1",
                    data: '{"email":"owner@example.com"}',
                    created_at: 1_700_000_000_000,
                  },
                ],
              }),
            })),
          }
        }
        return {
          bind: vi.fn(() => ({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          })),
        }
      }),
    }
    let uploadedBody: unknown
    let uploadedText = ""
    const bucket = {
      // processExport only writes, but assertBinding probes the read surface to
      // tell an R2 bucket apart from a name bound to another resource type.
      get: vi.fn(),
      put: vi.fn(async (_key: string, body: unknown) => {
        uploadedBody = body
        uploadedText =
          body instanceof ReadableStream
            ? await new Response(body).text()
            : String(body)
        return {}
      }),
    }
    const { processExport } = await import("./process-export.server")

    await processExport("export-1", {
      DB: db as never,
      UPLOADS: bucket as never,
    })

    expect(uploadedBody).toBeInstanceOf(ReadableStream)
    expect(uploadedText).toContain('"owner@example.com"')
  })
})
