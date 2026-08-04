import type { SubmissionEmailData } from "#/types/submission"

/**
 * Pure email rendering. No transport, no bindings, no I/O — so it is testable
 * on its own and identical whichever transport ends up sending the result.
 */

export type RenderedEmail = {
  subject: string
  html: string
  text: string
}

function layout({
  title,
  subtitle,
  body,
}: {
  title: string
  subtitle?: string
  body: string
}) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);">

          <!-- Header -->
          <tr>
            <td style="background-color: #252525; padding: 32px; text-align: center; border-bottom: 1px solid rgba(0, 0, 0, 0.1);">
              <h1 style="margin: 0; color: #fafafa; font-size: 24px; font-weight: 600; letter-spacing: -0.5px;">
                ${escapeHtml(title)}
              </h1>
              ${
                subtitle
                  ? `<p style="margin: 8px 0 0 0; color: #b4b4b4; font-size: 16px;">${escapeHtml(subtitle)}</p>`
                  : ""
              }
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 32px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #fafafa; padding: 24px 32px; text-align: center; border-top: 1px solid #ebebeb;">
              <p style="margin: 0; color: #8e8e8e; font-size: 14px;">
                Sent by <strong style="color: #595959;">FormZero</strong>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

export function renderTestEmail(transportLabel: string): RenderedEmail {
  return {
    subject: "FormZero - Test Email",
    text: `This is a test email from FormZero, sent through ${transportLabel}. Your stored notification settings work.`,
    html: layout({
      title: "Test Email",
      body: `
              <p style="margin: 0 0 16px 0; color: #252525; font-size: 16px; line-height: 1.6;">
                This is a test email from <strong>FormZero</strong>, sent through ${escapeHtml(transportLabel)}.
              </p>
              <p style="margin: 0; color: #252525; font-size: 16px; line-height: 1.6;">
                Your stored notification settings work.
              </p>
      `,
    }),
  }
}

export function renderSubmissionNotification(
  submission: SubmissionEmailData
): RenderedEmail {
  const submissionHtml = formatSubmissionData(
    submission.data,
    submission.fields,
    submission.files
  )
  const submissionText = formatSubmissionDataText(
    submission.data,
    submission.fields,
    submission.files
  )
  const timestamp = new Date(submission.createdAt).toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "long",
  })

  return {
    subject:
      submission.subject ?? `New Submission for "${submission.formName}"`,
    text: `
FormZero - New Form Submission

You have received a new submission for your form "${submission.formName}".

SUBMISSION DETAILS
==================
Form: ${submission.formName}
Submission ID: ${submission.id}
Received: ${timestamp}

SUBMITTED DATA
==============
${submissionText}

---
This email was automatically sent by FormZero
    `.trim(),
    html: layout({
      title: "New Form Submission",
      subtitle: submission.formName,
      body: `
              <!-- Introduction -->
              <p style="margin: 0 0 24px 0; color: #252525; font-size: 16px; line-height: 1.6;">
                You have received a new submission for your form <strong>${escapeHtml(submission.formName)}</strong>.
              </p>

              <!-- Metadata -->
              <div style="background-color: #fafafa; border-left: 4px solid #252525; padding: 16px; margin-bottom: 32px; border-radius: 6px;">
                <table width="100%" cellpadding="4" cellspacing="0">
                  <tr>
                    <td style="color: #8e8e8e; font-size: 14px; font-weight: 500; padding: 4px 0;">Submission ID:</td>
                    <td style="color: #252525; font-size: 14px; font-family: 'Courier New', monospace; padding: 4px 0;">${escapeHtml(submission.id)}</td>
                  </tr>
                  <tr>
                    <td style="color: #8e8e8e; font-size: 14px; font-weight: 500; padding: 4px 0;">Received:</td>
                    <td style="color: #252525; font-size: 14px; padding: 4px 0;">${escapeHtml(timestamp)}</td>
                  </tr>
                </table>
              </div>

              <!-- Submission Data -->
              <h2 style="margin: 0 0 16px 0; color: #252525; font-size: 18px; font-weight: 600;">
                Submitted Data
              </h2>

              ${submissionHtml}
      `,
    }),
  }
}

function orderedEntries(
  data: Record<string, any>,
  fields?: SubmissionEmailData["fields"]
) {
  if (!fields?.length) {
    return Object.entries(data).map(([key, value]) => ({
      key,
      label: key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      value,
    }))
  }

  const configured = fields
    .filter((field) => Object.hasOwn(data, field.name))
    .map((field) => ({
      key: field.name,
      label:
        field.label ??
        field.name.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      value: data[field.name],
    }))
  const known = new Set(fields.map((field) => field.name))
  const extra = Object.entries(data)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => ({
      key,
      label: key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      value,
    }))
  return [...configured, ...extra]
}

function formatSubmissionData(
  data: Record<string, any>,
  fields?: SubmissionEmailData["fields"],
  files?: SubmissionEmailData["files"]
): string {
  const entries = orderedEntries(data, fields)

  if (entries.length === 0 && !files?.length) {
    return '<p style="color: #8e8e8e; font-style: italic;">No data submitted</p>'
  }

  const rows = entries
    .map(({ label, value }) => {
      const displayValue = formatValue(value)

      return `
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #ebebeb; color: #8e8e8e; font-size: 14px; font-weight: 500; vertical-align: top; width: 35%;">
            ${escapeHtml(label)}
          </td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #ebebeb; color: #252525; font-size: 14px; vertical-align: top;">
            ${displayValue}
          </td>
        </tr>
      `
    })
    .join('')

  const fileRows = (files ?? [])
    .map(
      (file) => `
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #ebebeb; color: #8e8e8e; font-size: 14px; font-weight: 500; vertical-align: top; width: 35%;">
            Attachment
          </td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #ebebeb; font-size: 14px;">
            <a href="${escapeHtml(file.downloadUrl)}">${escapeHtml(file.name)}</a>
            (${escapeHtml(file.mimeType)}, ${file.sizeBytes} bytes)
          </td>
        </tr>
      `
    )
    .join("")

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #ebebeb; border-radius: 6px; overflow: hidden;">
      ${rows}${fileRows}
    </table>
  `
}

function formatSubmissionDataText(
  data: Record<string, any>,
  fields?: SubmissionEmailData["fields"],
  files?: SubmissionEmailData["files"]
): string {
  const entries = orderedEntries(data, fields)

  if (entries.length === 0 && !files?.length) {
    return 'No data submitted'
  }

  const values = entries
    .map(({ label, value }) => {
      return `${label}: ${formatValueText(value)}`
    })
    .join('\n')
  const attachments = (files ?? [])
    .map(
      (file) =>
        `Attachment: ${file.name} (${file.mimeType}, ${file.sizeBytes} bytes) ${file.downloadUrl}`
    )
    .join("\n")
  return [values, attachments].filter(Boolean).join("\n")
}

function formatValue(value: any): string {
  if (value === null || value === undefined) {
    return '<span style="color: #b4b4b4; font-style: italic;">Not provided</span>'
  }

  if (typeof value === 'boolean') {
    return value ? '✓ Yes' : '✗ No'
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span style="color: #b4b4b4; font-style: italic;">Empty list</span>'
    }
    return '<ul style="margin: 0; padding-left: 20px;">' +
      value.map(item => `<li>${escapeHtml(String(item))}</li>`).join('') +
      '</ul>'
  }

  if (typeof value === 'object') {
    return '<pre style="margin: 0; padding: 8px; background-color: #fafafa; border-radius: 6px; font-size: 13px; overflow-x: auto; color: #252525;">' +
      escapeHtml(JSON.stringify(value, null, 2)) +
      '</pre>'
  }

  const stringValue = String(value)
  if (stringValue.match(/^https?:\/\//)) {
    return `<a href="${escapeHtml(stringValue)}" style="color: #252525; text-decoration: underline;">${escapeHtml(stringValue)}</a>`
  }

  if (stringValue.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    return `<a href="mailto:${escapeHtml(stringValue)}" style="color: #252525; text-decoration: underline;">${escapeHtml(stringValue)}</a>`
  }

  return escapeHtml(stringValue)
}

function formatValueText(value: any): string {
  if (value === null || value === undefined) {
    return '(Not provided)'
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '(Empty list)'
    }
    return '\n  - ' + value.map(item => String(item)).join('\n  - ')
  }

  if (typeof value === 'object') {
    return '\n' + JSON.stringify(value, null, 2)
  }

  return String(value)
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }
  return text.replace(/[&<>"']/g, (m) => map[m])
}

export { escapeHtml }
