# Audit backend implementation
_Exported on 7/24/2026 at 16:59:59 GMT+2 from Cursor (3.12.30)_

---

**User**

Review the newly implemented uncommitted changes in /home/robert/Work/Dev/Web/formzero-ng read-only. Focus on correctness defects in the submission pipeline, D1 migration, Queue/outbox retries, encryption/webhooks, R2 upload/direct-upload/deletion, and scheduled maintenance. Do not edit. Return only actionable high/medium severity findings with exact file paths and rationale; say no findings if none.

---

**Cursor**

[P1] Preserve existing SMTP notifications during migration — migrations/0005_submission_platform.sql:43-46

Every migrated form gets notifications disabled, although the previous endpoint emailed the configured global address. Deploying this migration silently stops all existing notifications.

[P1] Honor the configured rate-limit key — app/lib/submissions/apply-rate-limit.server.ts:41-42

Every request consumes a shared `form:<id>` quota regardless of `config.key`. Thus one form is limited globally to 5/15/60 submissions per minute, and one client can exhaust the quota for everyone.

[P1] Delete submissions when their retention expires — app/lib/retention/cleanup-expired.server.ts:21-30

An attached file blocks submission deletion until its own retention expires. If `filesDays` is `null`, a submission with files is retained forever even after `submissionsDays` expires.

[P1] Authenticate before storing Turnstile secrets — app/routes/forms.$formId.settings.security.tsx:13-49

`putSecret` runs before `savePolicyRequest` performs authentication. Unauthenticated POSTs can create unlimited encrypted secret rows and could overwrite a known credential ID.

[P2] Handle malformed legacy JSON during migration — migrations/0005_submission_platform.sql:103-112

The old schema did not enforce valid JSON. Any malformed historical `submissions.data` value makes `json(data)` abort the entire production migration instead of preserving or quarantining that row.

[P2] Stream large exports instead of accumulating them — app/lib/delivery/process-export.server.ts:49-95

Pagination does not bound memory because every CSV row remains in `lines`, followed by another full `join`. The background path specifically handles 5,000+ submissions and can exceed Worker memory for valid large submissions.

[P2] Enforce upload mode and aggregate limits — app/routes/api.forms.$formId.submissions.tsx:117-149

Direct tokens and inline files are always processed together, regardless of `uploads.mode`, and each helper independently permits `maxFiles` and `maxTotalBytes`. A mixed request can therefore attach twice the configured quota.

[P2] Enforce extension restrictions for direct uploads — app/routes/api.forms.$formId.uploads.tsx:71-86

Direct-upload session creation validates size and MIME type but never `allowedExtensions`. A filename forbidden by policy is accepted and later attached without further validation.

[P2] Atomically claim direct-upload tokens — app/lib/submissions/create-submission.server.ts:88-111

Concurrent submissions can both pre-read the same completed token. The loser’s conditional update affects zero rows, but the batch still commits its submission and delivery jobs, returning success without the promised file.

[P2] Do not report failure after committing the submission — app/routes/api.forms.$formId.submissions.tsx:174-197

`directUploads.finalize()` runs after the D1 submission/job transaction but before the response and queue publication. A transient finalize failure returns an error despite committed data and delays delivery until the sweeper, encouraging duplicate retries.

[P2] Release claims before retrying unexpected worker errors — app/lib/delivery/process-batch.server.ts:25-27

Errors after a job is claimed but outside `processDeliveryJob`’s inner catch leave it `processing`. The retried message cannot reclaim it and is acknowledged, so recovery waits for the once-daily maintenance run.

[P2] Drain more than one outbox page per maintenance run — app/lib/delivery/publish-jobs.server.ts:41-69

The daily sweeper publishes at most 100 jobs. A queue outage producing more than 100 pending deliveries leaves the remainder recovering at only 100 per day.

[P2] Properly classify webhook IP destinations — app/lib/delivery/process-webhook.server.ts:36-44

String prefixes reject legitimate domains such as `fc.example.com`, while IPv4-mapped private IPv6 literals such as `::ffff:7f00:1` bypass all checks. Parse IP literals by address family and range instead.

