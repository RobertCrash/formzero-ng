import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  putSecret: vi.fn(),
  deleteSecret: vi.fn(),
}))

vi.mock("~/lib/require-auth.server", () => ({ requireAuth: mocks.requireAuth }))
vi.mock("~/lib/secrets/secret-store.server", () => ({
  putSecret: mocks.putSecret,
  deleteSecret: mocks.deleteSecret,
}))

type Statement = { sql: string; values: unknown[] }

/** Records every prepared statement so a test can assert what was written. */
function fakeDb(existing: unknown) {
  const statements: Statement[] = []
  const db = {
    statements,
    prepare(sql: string) {
      const result = {
        first: async () => (sql.includes("SELECT") ? existing : null),
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      }
      return {
        ...result,
        bind: (...values: unknown[]) => {
          statements.push({ sql, values })
          return result
        },
      }
    },
  }
  return db
}

function saveRequest(fields: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return new Request("https://example.com/settings/notifications", {
    method: "POST",
    body,
  })
}

type ActionResult = {
  data: { success?: boolean; error?: string }
  init?: { status?: number }
}

async function invoke(
  request: Request,
  db: ReturnType<typeof fakeDb>,
  encryptionKey?: string
): Promise<ActionResult> {
  return import("./settings.notifications").then(({ action }) =>
    action({
      request,
      context: {
        cloudflare: {
          env: { DB: db, FORMZERO_ENCRYPTION_KEY: encryptionKey },
        },
      },
    } as never)
  ) as Promise<ActionResult>
}

const legacyRow = {
  id: "global",
  // A legacy row keeps its password in notification_email_password and has
  // never been migrated to the secret store.
  smtp_secret_id: null,
  has_password: 1,
}

describe("global notification settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ id: "owner" })
    mocks.putSecret.mockResolvedValue("secret-new")
  })

  it("preserves a legacy credential when the password field is left blank", async () => {
    const db = fakeDb(legacyRow)

    const result = await invoke(
      saveRequest({
        email_transport: "smtp",
        notification_email: "ops@example.com",
        notification_email_password: "",
        smtp_host: "smtp.example.com",
        smtp_port: "587",
      }),
      db
    )

    expect(result.data.success).toBe(true)
    const update = db.statements.find((statement) =>
      statement.sql.includes("UPDATE settings")
    )
    expect(update).toBeDefined()
    expect(update!.sql).not.toContain("notification_email_password = NULL")
    expect(update!.sql).not.toContain("smtp_secret_id = ?")
    expect(mocks.putSecret).not.toHaveBeenCalled()
  })

  it("clears the legacy column only once a new secret has been written", async () => {
    const db = fakeDb(legacyRow)

    await invoke(
      saveRequest({
        email_transport: "smtp",
        notification_email: "ops@example.com",
        notification_email_password: "fresh-password",
        smtp_host: "smtp.example.com",
        smtp_port: "587",
      }),
      db,
      "00".repeat(32)
    )

    const update = db.statements.find((statement) =>
      statement.sql.includes("UPDATE settings")
    )
    expect(update!.sql).toContain("notification_email_password = NULL")
    expect(update!.values).toContain("secret-new")
    expect(mocks.putSecret).toHaveBeenCalledOnce()
  })

  it("names FORMZERO_ENCRYPTION_KEY when SMTP credentials cannot be stored", async () => {
    const db = fakeDb(legacyRow)

    const result = await invoke(
      saveRequest({
        email_transport: "smtp",
        notification_email: "ops@example.com",
        notification_email_password: "fresh-password",
        smtp_host: "smtp.example.com",
        smtp_port: "587",
      }),
      db
    )

    expect(result.init?.status).toBe(503)
    expect(result.data.error).toContain("FORMZERO_ENCRYPTION_KEY")
    expect(result.data.error).toContain("wrangler secret put")
  })

  it("saves the Cloudflare transport without any SMTP field", async () => {
    const db = fakeDb(null)

    const result = await invoke(
      saveRequest({
        email_transport: "cloudflare",
        email_from_address: "forms@example.com",
        email_from_name: "FormZero",
      }),
      db
    )

    expect(result.data.success).toBe(true)
    const insert = db.statements.find((statement) =>
      statement.sql.includes("INSERT INTO settings")
    )
    expect(insert!.values).toEqual([
      "forms@example.com",
      "FormZero",
      expect.any(Number),
    ])
  })

  it("requires a sender address under the Cloudflare transport", async () => {
    const db = fakeDb(null)

    const result = await invoke(
      saveRequest({ email_transport: "cloudflare", email_from_address: "" }),
      db
    )

    expect(result.init?.status).toBe(400)
    expect(result.data.error).toContain("sender address")
  })
})
