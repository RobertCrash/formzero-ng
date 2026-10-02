import { describe, expect, it, vi } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"

const loadFormWithPolicy = vi.hoisted(() => vi.fn())

vi.mock("../form-config/load-form-policy.server", () => ({
  loadFormWithPolicy,
}))

describe("background CSV export", () => {
  it("writes CSV rows through R2 multipart upload instead of put(stream)", async () => {
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

    const uploadedParts: ArrayBuffer[] = []
    const multipart = {
      uploadPart: vi.fn(async (_partNumber: number, value: ArrayBuffer | Uint8Array) => {
        const bytes =
          value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer)
        uploadedParts.push(bytes.slice().buffer)
        return { partNumber: _partNumber, etag: `etag-${_partNumber}` }
      }),
      complete: vi.fn(async () => ({})),
      abort: vi.fn(async () => {}),
    }
    const bucket = {
      get: vi.fn(),
      put: vi.fn(),
      createMultipartUpload: vi.fn(async () => multipart),
    }
    const { processExport } = await import("./process-export.server")

    await processExport("export-1", {
      DB: db as never,
      UPLOADS: bucket as never,
    })

    expect(bucket.put).not.toHaveBeenCalled()
    expect(bucket.createMultipartUpload).toHaveBeenCalledWith(
      "exports/contact/export-1.csv",
      { httpMetadata: { contentType: "text/csv; charset=utf-8" } }
    )
    expect(multipart.uploadPart).toHaveBeenCalled()
    expect(multipart.complete).toHaveBeenCalled()
    expect(multipart.abort).not.toHaveBeenCalled()

    const uploadedText = uploadedParts
      .map((part) => new TextDecoder().decode(part))
      .join("")
    expect(uploadedText).toContain('"owner@example.com"')
  })

  it("aborts the multipart upload when CSV production fails", async () => {
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
              all: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
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

    const multipart = {
      uploadPart: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(async () => {}),
    }
    const bucket = {
      get: vi.fn(),
      put: vi.fn(),
      createMultipartUpload: vi.fn(async () => multipart),
    }
    const { processExport } = await import("./process-export.server")

    await expect(
      processExport("export-1", {
        DB: db as never,
        UPLOADS: bucket as never,
      })
    ).rejects.toThrow("D1 unavailable")

    expect(multipart.abort).toHaveBeenCalled()
    expect(multipart.complete).not.toHaveBeenCalled()
  })
})
