import { beforeEach, describe, expect, it, vi } from "vitest"
import { EmailSendError } from "./message"
import { createCloudflareTransport } from "./send-cloudflare.server"

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
}))

vi.mock("../secrets/secret-store.server", () => ({
  getSecret: mocks.getSecret,
  putSecret: mocks.putSecret,
  deleteSecret: vi.fn(),
}))

/**
 * Minimal D1 stand-in that dispatches on SQL fragments and records every
 * statement, so a test can assert what a write would have done.
 */
function fakeDb(
  responses: Array<{ match: string; first?: unknown; all?: unknown }>
) {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    statements,
    prepare(sql: string) {
      const handler = responses.find((entry) => sql.includes(entry.match))
      const record = (values: unknown[]) => {
        statements.push({ sql, values })
      }
      const result = {
        first: async () => handler?.first ?? null,
        all: async () => handler?.all ?? { results: [] },
        run: async () => ({ meta: { changes: 1 } }),
      }
      return {
        ...result,
        bind: (...values: unknown[]) => {
          record(values)
          return result
        },
      }
    },
  }
  return db as typeof db & D1Database
}

const SMTP_SELECT = "smtp_secret_id\n      FROM settings"
const SETTINGS_SELECT = "email_transport"

describe("loadSmtpConfig", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns null when a stored secret cannot be decrypted without a key", async () => {
    const { loadSmtpConfig } = await import("../delivery/smtp-config.server")
    const db = fakeDb([
      {
        match: SMTP_SELECT,
        first: {
          notification_email: "ops@example.com",
          notification_email_password: null,
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_secure: 0,
          smtp_secret_id: "secret-1",
        },
      },
    ])

    await expect(loadSmtpConfig({ db })).resolves.toBeNull()
    expect(mocks.getSecret).not.toHaveBeenCalled()
  })

  it("migrates a legacy plaintext password into the secret store", async () => {
    mocks.putSecret.mockResolvedValue("secret-new")
    const { loadSmtpConfig } = await import("../delivery/smtp-config.server")
    const db = fakeDb([
      {
        match: SMTP_SELECT,
        first: {
          notification_email: "ops@example.com",
          notification_email_password: "legacy-password",
          smtp_host: "smtp.example.com",
          smtp_port: 465,
          smtp_secure: 1,
          smtp_secret_id: null,
        },
      },
    ])

    const config = await loadSmtpConfig({ db, encryptionKey: "00".repeat(32) })

    expect(config).toEqual({
      notification_email: "ops@example.com",
      notification_email_password: "legacy-password",
      smtp_host: "smtp.example.com",
      smtp_port: 465,
      smtp_secure: true,
    })
    expect(mocks.putSecret).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "smtp_password", value: "legacy-password" })
    )
  })

  it("does not read the superseded smtp_from_* columns", async () => {
    const { loadSmtpConfig } = await import("../delivery/smtp-config.server")
    const db = fakeDb([{ match: SMTP_SELECT, first: null }])
    await loadSmtpConfig({ db })
    expect(db.statements).toHaveLength(0)
  })
})

describe("resolveEmailTransport", () => {
  beforeEach(() => vi.clearAllMocks())

  const email = { send: vi.fn() } as unknown as SendEmail

  it("selects Cloudflare when a sender address is configured", async () => {
    const { resolveEmailTransport } = await import("./transport.server")
    const db = fakeDb([
      {
        match: SETTINGS_SELECT,
        first: {
          email_transport: "cloudflare",
          email_from_address: "forms@example.com",
          email_from_name: "FormZero",
          notification_email: null,
          smtp_host: null,
        },
      },
    ])

    const transport = await resolveEmailTransport({ env: { EMAIL: email }, db })

    expect(transport?.kind).toBe("cloudflare")
    expect(transport?.from).toEqual({
      email: "forms@example.com",
      name: "FormZero",
    })
  })

  it("refuses Cloudflare without a sender, rather than falling back to the SMTP username", async () => {
    const { resolveEmailTransport } = await import("./transport.server")
    const db = fakeDb([
      {
        match: SETTINGS_SELECT,
        first: {
          email_transport: "cloudflare",
          email_from_address: null,
          email_from_name: null,
          notification_email: "ops@gmail.com",
          smtp_host: null,
        },
      },
    ])

    await expect(
      resolveEmailTransport({ env: { EMAIL: email }, db })
    ).resolves.toBeNull()
  })

  it("selects SMTP from stored settings, not from binding presence", async () => {
    mocks.getSecret.mockResolvedValue("stored-password")
    const { resolveEmailTransport } = await import("./transport.server")
    const db = fakeDb([
      {
        match: SETTINGS_SELECT,
        first: {
          email_transport: "smtp",
          email_from_address: null,
          email_from_name: null,
          notification_email: "ops@example.com",
          smtp_host: "smtp.example.com",
        },
      },
      {
        match: SMTP_SELECT,
        first: {
          notification_email: "ops@example.com",
          notification_email_password: null,
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_secure: 0,
          smtp_secret_id: "secret-1",
        },
      },
    ])

    const transport = await resolveEmailTransport({
      env: { EMAIL: email, FORMZERO_ENCRYPTION_KEY: "00".repeat(32) },
      db,
    })

    expect(transport?.kind).toBe("smtp")
    // The sender defaults to the SMTP account address when none is stored.
    expect(transport?.from).toEqual({ email: "ops@example.com" })
  })

  it("returns null for SMTP with no encryption key", async () => {
    const { resolveEmailTransport } = await import("./transport.server")
    const db = fakeDb([
      {
        match: SETTINGS_SELECT,
        first: {
          email_transport: "smtp",
          email_from_address: null,
          email_from_name: null,
          notification_email: "ops@example.com",
          smtp_host: "smtp.example.com",
        },
      },
      {
        match: SMTP_SELECT,
        first: {
          notification_email: "ops@example.com",
          notification_email_password: null,
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_secure: 0,
          smtp_secret_id: "secret-1",
        },
      },
    ])

    await expect(
      resolveEmailTransport({ env: { EMAIL: email }, db })
    ).resolves.toBeNull()
  })

  it("returns null when no settings row exists", async () => {
    const { resolveEmailTransport } = await import("./transport.server")
    const db = fakeDb([{ match: SETTINGS_SELECT, first: null }])

    await expect(
      resolveEmailTransport({ env: { EMAIL: email }, db })
    ).resolves.toBeNull()
  })
})

describe("Cloudflare send error classification", () => {
  const message = {
    to: ["owner@example.com"],
    from: { email: "forms@example.com" },
    subject: "New submission",
    html: "<p>ok</p>",
    text: "ok",
  }

  it("marks an unverified sender terminal and explains how to fix it", async () => {
    const email = {
      send: vi.fn().mockRejectedValue(
        Object.assign(new Error("sender not verified"), {
          code: "E_SENDER_NOT_VERIFIED",
        })
      ),
    } as unknown as SendEmail
    const transport = createCloudflareTransport({
      email,
      from: { email: "forms@example.com" },
    })

    const error = await transport.send(message).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("wrangler email sending enable")
  })

  it("marks a rate limit retryable", async () => {
    const email = {
      send: vi.fn().mockRejectedValue(
        Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" })
      ),
    } as unknown as SendEmail
    const transport = createCloudflareTransport({
      email,
      from: { email: "forms@example.com" },
    })

    const error = await transport.send(message).catch((thrown) => thrown)

    expect(error.retryable).toBe(true)
  })

  it("rejects more than 50 recipients before calling the binding", async () => {
    const send = vi.fn()
    const transport = createCloudflareTransport({
      email: { send } as unknown as SendEmail,
      from: { email: "forms@example.com" },
    })

    const error = await transport
      .send({
        ...message,
        to: Array.from({ length: 51 }, (_, index) => `user${index}@example.com`),
      })
      .catch((thrown) => thrown)

    expect(error.code).toBe("E_TOO_MANY_RECIPIENTS")
    expect(send).not.toHaveBeenCalled()
  })
})
