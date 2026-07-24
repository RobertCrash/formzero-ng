import { beforeEach, describe, expect, it, vi } from "vitest"

const requireAuth = vi.fn()

vi.mock("~/lib/require-auth.server", () => ({ requireAuth }))

describe("notification settings security", () => {
  beforeEach(() => {
    requireAuth.mockReset()
    requireAuth.mockResolvedValue({ id: "user-1" })
  })

  it("authenticates and never selects the stored SMTP password", async () => {
    let query = ""
    const db = {
      prepare(sql: string) {
        query = sql
        return {
          first: vi.fn().mockResolvedValue({
            id: "global",
            notification_email: "owner@example.com",
            has_password: 1,
          }),
        }
      },
    }

    const { loader } = await import("./settings.notifications")
    const result = await loader({
      request: new Request("https://example.com/settings/notifications"),
      context: { cloudflare: { env: { DB: db } } },
    } as never)

    expect(requireAuth).toHaveBeenCalledOnce()
    expect(query).not.toMatch(/SELECT\s+\*/i)
    expect(query).not.toMatch(/,\s*notification_email_password\s*[,F]/i)
    expect(query).toContain("notification_email_password IS NOT NULL")
    expect(query).toContain("AS has_password")
    expect(JSON.stringify(result)).not.toContain('"notification_email_password"')
  })
})

function submissionDb() {
  const inserted = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
  const legacyPolicy = {
    schemaVersion: 1,
    fields: [],
    request: {
      maxPayloadBytes: 50_000,
      rejectUnknownFields: false,
      allowedContentTypes: [
        "application/json",
        "application/x-www-form-urlencoded",
      ],
    },
    security: {
      allowedOrigins: [],
      allowMissingOrigin: true,
      captcha: { enabled: false },
      honeypot: {
        enabled: false,
        fieldName: "_fz_honeypot",
        response: "accept-and-discard",
      },
      rateLimit: { enabled: false },
    },
    privacy: {
      ipMode: "none",
      ipRetentionDays: null,
      storeUserAgent: false,
      storeReferer: false,
      geoPrecision: "none",
    },
    notifications: { enabled: false, recipients: [] },
    uploads: {
      enabled: false,
      mode: "inline",
      maxFiles: 5,
      maxFileBytes: 10_000_000,
      maxTotalBytes: 25_000_000,
      allowedMimeTypes: [],
      allowedExtensions: [],
    },
    retention: { submissionsDays: null, filesDays: null },
    redirects: { allowedOrigins: [] },
  }

  return {
    inserted,
    db: {
      prepare(sql: string) {
        if (sql.includes("FROM forms")) {
          return {
            bind: () => ({
              first: vi.fn().mockResolvedValue({
                id: "contact",
                name: "Contact",
                config_json: JSON.stringify(legacyPolicy),
                config_schema_version: 1,
                config_revision: 1,
              }),
            }),
          }
        }

        if (sql.includes("FROM form_webhooks")) {
          return {
            bind: () => ({ all: vi.fn().mockResolvedValue({ results: [] }) }),
          }
        }

        return { bind: () => ({ sql }) }
      },
      batch: vi.fn().mockImplementation(async () => {
        await inserted()
        return []
      }),
    },
  }
}

describe("submission endpoint security", () => {
  it("rejects multipart file bodies until upload support is enabled", async () => {
    const { db, inserted } = submissionDb()
    const body = new FormData()
    body.set("attachment", new File(["secret"], "secret.txt"))

    const { action } = await import("./api.forms.$formId.submissions")
    const response = await action({
      request: new Request(
        "https://example.com/api/forms/contact/submissions",
        {
          method: "POST",
          headers: { Accept: "application/json" },
          body,
        }
      ),
      params: { formId: "contact" },
      context: {
        cloudflare: {
          env: { DB: db },
          ctx: { waitUntil: vi.fn() },
        },
      },
    } as never)

    expect(
      response instanceof Response ? response.status : response.init?.status
    ).toBe(415)
    expect(inserted).not.toHaveBeenCalled()
  })

  it("does not honor client-controlled redirect destinations", async () => {
    const { db } = submissionDb()
    const { action } = await import("./api.forms.$formId.submissions")
    const response = await action({
      request: new Request(
        "https://example.com/api/forms/contact/submissions?redirect=https://evil.example",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "name=Example",
        }
      ),
      params: { formId: "contact" },
      context: {
        cloudflare: {
          env: { DB: db },
          ctx: { waitUntil: vi.fn() },
        },
      },
    } as never)

    expect(response).toBeInstanceOf(Response)
    if (!(response instanceof Response)) throw new Error("Expected a redirect")
    expect(response.status).toBe(303)
    expect(response.headers.get("Location")).toBe("/success")
  })
})
