## Executive verdict

I reviewed `main` at commit [`91918af`](https://github.com/RobertCrash/formzero-ng/commit/91918afdb7b4937455742225541a1ef70e6ffa03), dated August 1, 2026.

Formzero-ng has a strong architectural foundation: the submission pipeline is well decomposed, policy validation is centralized, delivery uses an outbox pattern, sensitive credentials are encrypted, and Cloudflare’s services are used coherently. The latest commit also fixes several meaningful issues from earlier audits.

However, I would not promote this revision to a production service handling untrusted public traffic yet. There are several functional and operational release blockers, mostly around uploads, capability validation, webhook configuration, scheduled retention, and initial account creation.

### Verification results

* `npm ci`: passed
* Tests: **37 passed across 13 files**
* TypeScript typecheck: passed
* Production build: passed
* Migration sequence `0001`–`0005`: passed in an isolated SQLite test, including malformed legacy submission JSON
* Source tree remained clean
* No GitHub Actions workflow, commit status, or recent workflow run exists
* Production dependency audit reports one high-severity React Router advisory. It concerns RSC mode, which this application does not appear to use, so practical exposure is likely limited; it should still be tracked or upgraded. [Advisory](https://github.com/advisories/GHSA-qwww-vcr4-c8h2)

## Release blockers

| Priority | Finding                                                            | Impact                                                                    |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| P1       | Turnstile can be enabled without a usable secret                   | Administrators can save a policy that rejects every subsequent submission |
| P1       | Inline upload limits contradict the default request limit          | A configured 10 MB upload is rejected at roughly 50 KB                    |
| P1       | Large bodies are fully buffered in Worker memory                   | Public requests can exhaust the 128 MB Worker isolate limit               |
| P1       | Webhook signing secrets are never shown                            | Receivers cannot verify webhook signatures                                |
| P1       | Retention maintenance is coupled and capped at 100 records/day     | Failures or volume spikes can violate configured retention periods        |
| P1       | Initial-user registration has a race condition                     | Multiple administrator accounts can be created on a fresh deployment      |
| P2       | Direct upload consumes rate-limit capacity twice                   | A 5/minute limit permits only two complete direct-upload submissions      |
| P2       | Several policy combinations are accepted but impossible to satisfy | Forms can be configured into permanently invalid states                   |

### 1. Turnstile capability validation is incorrect

[`capabilities.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/form-config/capabilities.server.ts) considers Turnstile available when `FORMZERO_ENCRYPTION_KEY` exists. But an encryption key is not a Turnstile verification secret.

Meanwhile:

* [`schema.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/form-config/schema.ts) requires a site key, but not a credential or global secret.
* [`settings.security.tsx`](https://github.com/RobertCrash/formzero-ng/blob/main/app/routes/forms.$formId.settings.security.tsx) permits enabling Turnstile with a blank secret.
* [`verify-turnstile.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/submissions/verify-turnstile.server.ts) then fails every submission if neither credential nor `TURNSTILE_SECRET` exists.

Enabling Turnstile should require one of:

* An existing credential owned by the form
* A newly provided secret
* A confirmed global `TURNSTILE_SECRET`

### 2. Inline upload configuration is internally inconsistent

The defaults in [`defaults.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/form-config/defaults.ts) allow:

* Request body: 50 KB
* Individual file: 10 MB
* Total files: 25 MB

But [`parse-request.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/submissions/parse-request.server.ts) applies the 50 KB request limit to the entire multipart request before file validation. Enabling inline uploads in [`settings.uploads.tsx`](https://github.com/RobertCrash/formzero-ng/blob/main/app/routes/forms.$formId.settings.uploads.tsx) does not adjust or validate that limit.

The schema should require approximately:

```text
request.maxPayloadBytes >= upload.maxTotalBytes + multipart overhead
```

Alternatively, inline uploads should have conservative fixed limits and direct-to-R2 upload should be the normal path.

### 3. Upload processing can exceed Worker memory

The public request path currently buffers data repeatedly:

* Submission parsing accumulates chunks and copies them into another buffer.
* Direct file upload uses `request.arrayBuffer()`.
* Inline upload calls `file.arrayBuffer()`.
* The schema permits payloads/files approaching 100 MB.

A Worker isolate has a 128 MB memory limit, and Cloudflare explicitly recommends streaming rather than buffering large bodies. [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

This is both a reliability and abuse-resistance problem. Recommended changes:

* Stream uploads directly into R2 through a byte-limiting `TransformStream`.
* Reject oversized `Content-Length` immediately, while still enforcing an actual streamed-byte limit.
* Put a small explicit body limit on upload-session JSON.
* Lower inline-upload limits substantially.
* Require a signed, short-lived upload grant before accepting file bytes.

### 4. Webhook signing cannot be used correctly

[`settings.webhooks.tsx`](https://github.com/RobertCrash/formzero-ng/blob/main/app/routes/forms.$formId.settings.webhooks.tsx) generates and encrypts a secret, but creation and rotation return only success. The plaintext secret is never displayed.

[`process-webhook.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/delivery/process-webhook.server.ts) signs deliveries with that secret, leaving the receiver without the key needed to verify them.

Show the secret exactly once after creation or rotation, with copy/download support and an explicit “cannot be recovered later” message.

### 5. Scheduled retention is not sufficiently durable

[`run-scheduled-maintenance.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/retention/run-scheduled-maintenance.server.ts) runs maintenance operations sequentially. If delivery publishing fails, later privacy cleanup may never run.

Cleanup operations are also capped at 100 records per daily run, including file cleanup in [`cleanup-files.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/uploads/cleanup-files.server.ts) and expired-submission cleanup in [`cleanup-expired.server.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/retention/cleanup-expired.server.ts). More than 100 expirations per day creates a growing backlog.

Each maintenance category should fail independently, paginate until a time budget is reached, persist continuation state, and emit observable backlog metrics.

### 6. Initial administrator registration is raceable

[`api.auth.$.tsx`](https://github.com/RobertCrash/formzero-ng/blob/main/app/routes/api.auth.$.tsx) performs a user count followed by signup. Two concurrent initial registrations can both observe zero users and both succeed.

Use an atomic bootstrap lock, one-time setup token, pre-provisioned administrator, or singleton setup record enforced by a database constraint.

## Other correctness findings

* Direct upload session creation and final submission both invoke submission rate limiting. A 5/minute limit therefore allows only two complete direct-upload submissions before the third fails during finalization.
* Minimum-fill-time validation in [`validate-honeypot.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/submissions/validate-honeypot.ts) is bypassed when `_fz_started_at` is omitted. If enabled, the marker should be mandatory and valid.
* The schema permits required file fields when uploads are disabled, and permits more required file fields than `maxFiles`.
* Administrator-supplied JavaScript regular expressions are executed against public input in [`validate-fields.ts`](https://github.com/RobertCrash/formzero-ng/blob/main/app/lib/submissions/validate-fields.ts). Catastrophic patterns could consume the Worker CPU budget. Use RE2-compatible patterns or a safe restricted grammar.
* Date validation relies on `Date.parse`, which normalizes some impossible dates instead of rejecting them.
* Form deletion appears synchronous and potentially N+1 over submissions/files. Large deletions should become tombstoned background jobs.
* Delivery uses the current form policy when processing a job. This means changing recipients or templates can alter already-enqueued deliveries. Decide whether that is intended; otherwise snapshot delivery configuration at enqueue time.

## Architecture assessment

The overall architecture is good and worth retaining:

* A single Worker handles HTTP, queue consumption, and scheduled maintenance.
* React Router SSR, D1, R2, Queues, Turnstile, and Cloudflare rate-limit bindings fit the workload.
* Versioned form-policy JSON plus optimistic `config_revision` is a reasonable design for a single-administrator system.
* Zod-backed policy parsing provides a strong centralized boundary.
* D1 batching and an outbox provide atomic submission/job creation.
* Queue publishing through `waitUntil`, backed by a pending-job sweep, gives sensible recovery behavior.
* AES-GCM credentials, webhook HMACs, signed redirects, and explicit capability checks are good security primitives.
* The newest migrations preserve legacy notification behavior and quarantine malformed legacy JSON rather than discarding it.

The main architectural adjustment should be to move expensive or unbounded activity—uploads, deletion, retention, and export cleanup—toward streaming and durable, resumable jobs.
