import { describe, expect, it, vi } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"
import { createSubmissionWithJobs } from "./create-submission.server"

describe("direct-upload token claims", () => {
  it("rejects a submission when its conditional file claim loses a race", async () => {
    const policy = createDefaultFormPolicy()
    const form = {
      id: "contact",
      name: "Contact",
      configSchemaVersion: 1,
      configRevision: 1,
      policy,
    }
    const db = {
      prepare: vi.fn((query: string) => {
        if (query.includes("FROM form_webhooks")) {
          return {
            bind: vi.fn(() => ({
              all: vi.fn().mockResolvedValue({ results: [] }),
            })),
          }
        }
        return {
          bind: vi.fn(() => ({ query })),
        }
      }),
      batch: vi
        .fn()
        .mockResolvedValueOnce([
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 0 } },
        ])
        .mockResolvedValue([]),
    }

    await expect(
      createSubmissionWithJobs({
        db: db as never,
        form,
        fields: {},
        files: [
          {
            id: "file-1",
            fieldName: "attachment",
            objectKey: "forms/contact/2026/07/file-1",
            originalName: "file.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
            checksum: null,
            uploadSessionId: "session-1",
            existingMetadata: true,
          },
        ],
        submissionContext: {
          requestId: "00000000-0000-4000-8000-000000000001",
          createdAt: Date.now(),
          sourceIp: null,
          sourceIpHash: null,
          origin: null,
          countryCode: null,
          cfRay: null,
          userAgent: null,
        },
        metadata: {},
      })
    ).rejects.toThrow(/already attached|claimed/i)
  })
})
