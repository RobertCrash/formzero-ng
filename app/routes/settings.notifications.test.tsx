import type { Route } from "./+types/settings.notifications.test"
import { data } from "react-router"
import { EmailSendError } from "~/lib/email/message"
import { renderTestEmail } from "~/lib/email/render.server"
import {
  loadEmailSettings,
  resolveEmailTransport,
} from "~/lib/email/transport.server"
import { requireAuth } from "~/lib/require-auth.server"

/**
 * Tests the transport the queue will actually use.
 *
 * The previous version sent with the password straight from the POST body,
 * never reading D1 and never decrypting, so a green test could coexist with a
 * queue that could not decrypt anything. Save first, then test what is stored.
 */
export async function action({ context, request }: Route.ActionArgs) {
  const env = context.cloudflare.env

  await requireAuth(request, env.DB)

  if (request.method !== "POST") {
    return data(
      { success: false, error: "Method not allowed" },
      { status: 405 }
    )
  }

  try {
    const settings = await loadEmailSettings(env.DB)
    if (!settings) {
      return data(
        {
          success: false,
          error: "Save your notification settings before sending a test.",
        },
        { status: 400 }
      )
    }

    const transport = await resolveEmailTransport({ env, db: env.DB })
    if (!transport) {
      return data(
        {
          success: false,
          error:
            settings.transport === "smtp"
              ? "The stored SMTP configuration is incomplete or cannot be decrypted. Re-enter the password, and confirm FORMZERO_ENCRYPTION_KEY is set."
              : "Set a sender address on a domain onboarded for Cloudflare Email Sending.",
        },
        { status: 503 }
      )
    }

    const recipient =
      settings.notificationEmail ?? settings.fromAddress ?? transport.from.email
    const rendered = renderTestEmail(
      transport.kind === "cloudflare"
        ? "Cloudflare Email Service"
        : `SMTP (${settings.notificationEmail ?? "stored configuration"})`
    )

    const result = await transport.send({
      to: [recipient],
      from: transport.from,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    })

    return data(
      {
        success: true,
        messageId: result.messageId,
        transport: transport.kind,
        recipient,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("Error testing email settings:", error)
    return data(
      {
        success: false,
        error:
          error instanceof EmailSendError
            ? error.message
            : "Failed to send test email",
      },
      { status: 400 }
    )
  }
}
