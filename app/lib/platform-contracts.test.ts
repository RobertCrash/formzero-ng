import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL("../../migrations/0005_submission_platform.sql", import.meta.url),
  "utf8"
)
const retentionCleanup = readFileSync(
  new URL("./retention/cleanup-expired.server.ts", import.meta.url),
  "utf8"
)
const integrationRoute = readFileSync(
  new URL("../routes/forms.$formId.integration.tsx", import.meta.url),
  "utf8"
)
const submissionsTable = readFileSync(
  new URL(
    "../routes/forms.$formId.submissions/data-table.tsx",
    import.meta.url
  ),
  "utf8"
)
const notificationSettings = readFileSync(
  new URL(
    "../routes/forms.$formId.settings.notifications.tsx",
    import.meta.url
  ),
  "utf8"
)
const submissionRoute = readFileSync(
  new URL("../routes/api.forms.$formId.submissions.tsx", import.meta.url),
  "utf8"
)
const submissionsDashboard = readFileSync(
  new URL("../routes/forms.$formId.submissions.tsx", import.meta.url),
  "utf8"
)

describe("upgrade migration contracts", () => {
  it("preserves configured legacy SMTP notifications", () => {
    expect(migration).toContain("$.notifications.enabled")
    expect(migration).toContain("$.notifications.recipients")
    expect(migration).toMatch(/FROM settings[\s\S]+WHERE id = 'global'/)
  })

  it("quarantines malformed legacy submission JSON", () => {
    expect(migration).toMatch(
      /CASE\s+WHEN json_valid\(data\)\s+THEN json\(data\)\s+ELSE json_object/i
    )
    expect(migration).toContain("invalid_legacy_json")
  })
})

describe("retention contracts", () => {
  it("does not let attached files block parent submission expiry", () => {
    expect(retentionCleanup).not.toContain("NOT EXISTS")
  })
})

describe("dashboard recovery and integration contracts", () => {
  it("generates policy-aware JavaScript and HTML examples", () => {
    expect(integrationRoute).toContain("generateJavascriptExample")
    expect(integrationRoute).toContain("generateHtmlExample")
    expect(integrationRoute).toContain("cf-turnstile-response")
    expect(integrationRoute).toContain("_fz_upload_tokens")
  })

  it("labels client-side search as current-page only", () => {
    expect(submissionsTable).toContain("Search current page")
  })

  it("allows enabled notifications to be disabled after queue loss", () => {
    expect(notificationSettings).toContain(
      "disabled={!capabilities.backgroundDelivery && !enabled}"
    )
  })

  it("enforces one upload mode and one aggregate quota", () => {
    expect(submissionRoute).toContain("validateUploadRequestMode")
    expect(submissionRoute).toContain("validateCombinedUploadLimits")
  })

  it("treats direct-upload finalization as post-commit cleanup", () => {
    expect(submissionRoute).not.toContain("await directUploads.finalize()")
    expect(submissionRoute).toContain(
      "context.cloudflare.ctx.waitUntil(directUploads.finalize())"
    )
  })

  it("polls queued export jobs until a download is ready", () => {
    expect(submissionsDashboard).toContain("useRevalidator")
    expect(submissionsDashboard).toContain("setInterval")
  })
})
