import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDefaultFormPolicy } from "../form-config/defaults"
import { EmailSendError, type EmailMessagePayload } from "../email/message"

const mocks = vi.hoisted(() => ({
  resolveEmailTransport: vi.fn(),
  loadEmailSettings: vi.fn(),
}))

vi.mock("../email/transport.server", () => ({
  resolveEmailTransport: mocks.resolveEmailTransport,
  loadEmailSettings: mocks.loadEmailSettings,
}))

function fakeDb({
  submission,
  files = [],
}: {
  submission: Record<string, unknown> | null
  files?: unknown[]
}) {
  return {
    prepare(sql: string) {
      const result = {
        first: async () => submission,
        all: async () => ({ results: files }),
        run: async () => ({ meta: { changes: 1 } }),
      }
      return { ...result, bind: () => result }
    },
  } as unknown as D1Database
}

function submissionRow(policyOverrides: Partial<
  ReturnType<typeof createDefaultFormPolicy>["notifications"]
> = {}) {
  const policy = createDefaultFormPolicy()
  policy.notifications = {
    enabled: true,
    recipients: ["owner@example.com"],
    ...policyOverrides,
  }
  policy.fields = [{ name: "email", type: "email", required: false }]
  return {
    form_name: "Contact",
    config_json: JSON.stringify(policy),
    config_schema_version: 1,
    data: JSON.stringify({ email: "sender@example.com", message: "Hello" }),
    created_at: 1_700_000_000_000,
  }
}

function fakeTransport() {
  const sent: EmailMessagePayload[] = []
  return {
    sent,
    transport: {
      kind: "cloudflare" as const,
      from: { email: "forms@example.com", name: "FormZero" },
      send: vi.fn(async (message: EmailMessagePayload) => {
        sent.push(message)
        return { messageId: "msg-1" }
      }),
    },
  }
}

const job = { id: "job-1", form_id: "contact", submission_id: "sub-1" }

describe("processEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadEmailSettings.mockResolvedValue({
      transport: "cloudflare",
      fromAddress: "forms@example.com",
      fromName: "FormZero",
      notificationEmail: "ops@example.com",
      hasSmtpHost: false,
    })
  })

  it("sends to the configured recipients with the transport's sender", async () => {
    const { sent, transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    const result = await processEmail(job, {
      DB: fakeDb({ submission: submissionRow() }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
    })

    expect(result).toEqual({ skipped: false })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(["owner@example.com"])
    expect(sent[0].from).toEqual({ email: "forms@example.com", name: "FormZero" })
    expect(sent[0].html).toContain("Contact")
  })

  it("substitutes the form name into the subject template", async () => {
    const { sent, transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    await processEmail(job, {
      DB: fakeDb({
        submission: submissionRow({
          recipients: ["owner@example.com"],
          subjectTemplate: "New {{ form.name }} submission",
        }),
      }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
    })

    expect(sent[0].subject).toBe("New Contact submission")
  })

  it("resolves reply-to from the configured field", async () => {
    const { sent, transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    await processEmail(job, {
      DB: fakeDb({
        submission: submissionRow({
          recipients: ["owner@example.com"],
          replyToField: "email",
        }),
      }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
    })

    expect(sent[0].replyTo).toBe("sender@example.com")
  })

  it("includes attachment links when a submission has files", async () => {
    const { sent, transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    await processEmail(job, {
      DB: fakeDb({
        submission: submissionRow(),
        files: [
          {
            id: "file-1",
            original_name: "resume.pdf",
            mime_type: "application/pdf",
            size_bytes: 1024,
          },
        ],
      }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
      FORMZERO_PUBLIC_URL: "https://forms.example.com/",
    })

    expect(sent[0].text).toContain(
      "https://forms.example.com/forms/contact/submissions/sub-1/files/file-1"
    )
  })

  it("reports a missing transport as terminal, naming what to configure", async () => {
    mocks.resolveEmailTransport.mockResolvedValue(null)
    mocks.loadEmailSettings.mockResolvedValue(null)
    const { processEmail } = await import("./process-email.server")

    const error = await processEmail(job, {
      DB: fakeDb({ submission: submissionRow() }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
    }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("No email transport is configured")
  })

  it("propagates a terminal send failure unchanged", async () => {
    mocks.resolveEmailTransport.mockResolvedValue({
      kind: "cloudflare" as const,
      from: { email: "forms@example.com" },
      send: vi.fn().mockRejectedValue(
        new EmailSendError("E_SENDER_NOT_VERIFIED: nope", {
          retryable: false,
          code: "E_SENDER_NOT_VERIFIED",
        })
      ),
    })
    const { processEmail } = await import("./process-email.server")

    const error = await processEmail(job, {
      DB: fakeDb({ submission: submissionRow() }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
    }).catch((thrown) => thrown)

    expect(error.retryable).toBe(false)
    expect(error.code).toBe("E_SENDER_NOT_VERIFIED")
  })

  it("delivers to the recipients captured at enqueue time, not the current ones", async () => {
    const { sent, transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    // The form has since been edited to notify somebody else entirely.
    await processEmail(
      {
        ...job,
        config_snapshot: JSON.stringify({
          version: 1,
          formName: "Contact form",
          configRevision: 4,
          notifications: {
            enabled: true,
            recipients: ["queued@example.com"],
            subjectTemplate: "{{ form.name }} at enqueue",
          },
          fields: [],
        }),
      },
      {
        DB: fakeDb({
          submission: submissionRow({ recipients: ["edited@example.com"] }),
        }),
        EMAIL: { send: vi.fn() } as unknown as SendEmail,
      }
    )

    expect(sent[0].to).toEqual(["queued@example.com"])
    expect(sent[0].subject).toBe("Contact form at enqueue")
  })

  it("falls back to the live policy for jobs queued before snapshots existed", async () => {
    const { sent, transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    await processEmail(
      { ...job, config_snapshot: null },
      {
        DB: fakeDb({ submission: submissionRow() }),
        EMAIL: { send: vi.fn() } as unknown as SendEmail,
      }
    )

    expect(sent[0].to).toEqual(["owner@example.com"])
  })

  it("skips a snapshot that disabled notifications", async () => {
    const { transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const { processEmail } = await import("./process-email.server")

    const result = await processEmail(
      {
        ...job,
        config_snapshot: JSON.stringify({
          version: 1,
          formName: "Contact",
          configRevision: 1,
          notifications: { enabled: false, recipients: [] },
          fields: [],
        }),
      },
      {
        DB: fakeDb({ submission: submissionRow() }),
        EMAIL: { send: vi.fn() } as unknown as SendEmail,
      }
    )

    expect(result).toEqual({ skipped: true })
    expect(transport.send).not.toHaveBeenCalled()
  })

  it("skips a form whose notifications are disabled", async () => {
    const { transport } = fakeTransport()
    mocks.resolveEmailTransport.mockResolvedValue(transport)
    const policy = createDefaultFormPolicy()
    const { processEmail } = await import("./process-email.server")

    const result = await processEmail(job, {
      DB: fakeDb({
        submission: {
          form_name: "Contact",
          config_json: JSON.stringify(policy),
          config_schema_version: 1,
          data: "{}",
          created_at: 1,
        },
      }),
      EMAIL: { send: vi.fn() } as unknown as SendEmail,
    })

    expect(result).toEqual({ skipped: true })
    expect(transport.send).not.toHaveBeenCalled()
  })
})
