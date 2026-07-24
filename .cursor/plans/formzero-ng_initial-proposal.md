# FormZero Submission Policies and Integrations

## Design and Implementation Proposal

**Repository:** `BohdanPetryshyn/formzero`
**Target platform:** Cloudflare Workers, D1, R2, Queues, Turnstile
**Proposal date:** July 23, 2026
**Status:** Proposed

---

## 1. Executive summary

FormZero currently provides a deliberately simple form backend: a public submission endpoint accepts JSON, URL-encoded, and multipart requests, stores the resulting object in D1, and optionally triggers an SMTP notification. Its public endpoint currently accepts every origin, performs no field-level validation, and treats multipart form data like ordinary JSON-compatible data.

This proposal introduces a **versioned per-form submission policy** and a modular processing pipeline supporting:

* Required and allowed fields.
* Field types and validation limits.
* Maximum request and file sizes.
* Origin restrictions and safe redirects.
* Cloudflare Turnstile.
* Honeypot handling.
* Rate limiting.
* Per-form notification recipients.
* Signed webhooks with retries.
* File uploads backed by Cloudflare R2.
* Submission and file retention.
* Dashboard configuration for all supported features.

The design builds on the previously recommended architecture while refining it for the actual repository structure and Cloudflare runtime.

The recommended storage division is:

```text
D1
├── form policies
├── submission data
├── file metadata
├── webhook definitions
├── delivery jobs and attempts
└── retention metadata

R2
└── uploaded file bodies

Cloudflare Queues
└── email and webhook delivery jobs

Cloudflare Rate Limiting
└── fast coarse request throttling

Cloudflare Turnstile
└── challenge verification
```

The existing single Worker remains the application entry point. Its current `fetch` handler should be extended with `queue` and `scheduled` handlers rather than splitting FormZero into several independently deployed applications. The current Worker only exposes `fetch`.

---

## 2. Goals

### 2.1 Functional goals

The implementation must allow every form to define:

* Which fields are accepted.
* Which fields are required.
* How each field is validated.
* Which websites may submit.
* Whether CAPTCHA and honeypot protection are enabled.
* Which rate-limit profile applies.
* Which email addresses receive notifications.
* Which webhooks receive events.
* Whether files are accepted and under which restrictions.
* How long submissions and files are retained.
* Which success and error redirects are permitted.

### 2.2 Architectural goals

The implementation should:

* Keep FormZero self-hostable and Cloudflare-native.
* Preserve plain HTML form submissions.
* Preserve JSON API submissions.
* Avoid placing all logic inside the current submission route.
* Store binary files outside D1.
* Keep secrets out of ordinary form configuration JSON.
* Make background delivery durable and observable.
* Permit deployments without every optional Cloudflare binding.
* Support future configuration schema migrations.


### 2.3 Non-goals for the initial implementation

The first implementation does not need to include:

* Arbitrary nested JSON schemas.
* Antivirus or malware scanning.
* User-defined JavaScript validation.
* Conditional fields.
* Multi-step form submissions.
* A public R2 bucket (reconsider this).
* Arbitrary custom rate-limit windows.

These can be added after the policy and processing foundations are stable.

* **A full visual form builder is not planned (or other form builder capabilities)**

---

## 3. Existing repository baseline

FormZero currently uses:

* Cloudflare Workers and D1.
* React Router v7 for dashboard and API routes.
* Better Auth.
* Tailwind CSS and shadcn/ui.
* Nodemailer for SMTP notifications.

The public submission route is:

```text
POST /api/forms/:formId/submissions
```

Its current responsibilities are:

1. Resolve the form.
2. Parse the request.
3. Store arbitrary submission JSON.
4. Read global email settings.
5. Send a notification through `ctx.waitUntil()`.
6. Return JSON or redirect.

The per-form settings page currently loads only `id` and `name`, updates only the form name, and contains the delete-form controls.

The current `Form` type similarly contains only:

```ts
export type Form = {
  id: string
  name: string
}
```

SMTP settings are global, including the SMTP password, and the notification sender and recipient are currently the same global email address.

A repository issue also confirms demand for per-form recipients rather than one master address for all forms.

---

# 4. Target architecture

## 4.1 Runtime components

```text
                         ┌──────────────────────┐
Static site / browser ──▶│ Cloudflare Worker    │
                         │ React Router          │
                         └──────────┬───────────┘
                                    │
                       synchronous submission
                                    │
               ┌────────────────────▼────────────────────┐
               │ Submission processing pipeline          │
               │                                          │
               │ origin → rate limit → parse → honeypot   │
               │ → CAPTCHA → field validation → files     │
               │ → D1 transaction → queue jobs            │
               └────────────┬───────────────┬─────────────┘
                            │               │
                   metadata and JSON     file bodies
                            │               │
                         ┌──▼──┐         ┌──▼──┐
                         │ D1  │         │ R2  │
                         └──┬──┘         └─────┘
                            │
                      delivery job IDs
                            │
                         ┌──▼───────────────┐
                         │ Cloudflare Queue │
                         └──┬───────────────┘
                            │
                   email and webhook worker
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
                SMTP             webhook URLs
```

## 4.2 Cloudflare resource responsibilities

### D1

D1 remains the system of record for:

* Forms.
* Configuration.
* Submissions.
* Uploaded-file metadata.
* Webhook definitions.
* Delivery state.
* Retention timestamps.
* Audit and operational metadata.

D1 `batch()` can execute multiple statements transactionally; a failed statement rolls back the sequence. This makes it suitable for atomically creating a submission and its delivery jobs.

### R2

R2 stores the actual file bodies.

D1 stores only:

* Object key.
* Original filename.
* MIME type.
* Size.
* Checksum where available.
* Submission relationship.
* Retention timestamp.

R2 supports ordinary object uploads, multipart uploads, temporary presigned access, and lifecycle handling for incomplete multipart uploads.

### Cloudflare Queues

Queues deliver:

* Notification email jobs.
* Webhook jobs.
* Optional future export or processing jobs.

Queues support configurable retries, delayed retry, and dead-letter queues. Failed messages are otherwise eventually discarded, so a dead-letter queue should be configured.

### Rate Limiting API

The Worker Rate Limiting API provides a low-latency first layer of protection.

However, its counters are local to Cloudflare locations, permissive, and eventually consistent. It must not be treated as exact global quota accounting.

The recommended implementation is:

* Cloudflare Rate Limiting binding for fast per-IP/form protection.
* Optional Durable Object later for strict global per-form limits.

---

# 5. Core design decisions

## 5.1 Versioned form policy

Each form receives a JSON policy stored in D1.

Use two separate version numbers:

```ts
configSchemaVersion: number
configRevision: number
```

* `configSchemaVersion` identifies the JSON format.
* `configRevision` increments whenever the administrator changes the configuration.

Every submission stores the revision under which it was accepted.

This makes validation behavior auditable without copying the complete form configuration into every submission.

## 5.2 Fields are the allowlist

Do not maintain separate arrays for:

```text
allowedFields
requiredFields
fieldTypes
fieldLimits
```

Instead, define each allowed field once:

```ts
{
  name: "email",
  label: "Email",
  type: "email",
  required: true,
  maxLength: 254
}
```

A field exists in the policy if and only if it is allowed.

This prevents contradictions such as a field being required but not allowed.

## 5.3 Store fields as an ordered array

The earlier design used a record keyed by field name. For the stored representation, an array is preferable:

```ts
fields: FieldRule[]
```

Advantages:

* The dashboard can preserve field ordering.
* Integration examples can use the configured order.
* Email output can use human-readable labels.
* The application can derive a lookup map during validation.

Field names must still be unique.

## 5.4 Hybrid JSON and normalized tables

Store synchronous submission policy in `forms.config_json`.

Use normalized tables for stateful entities:

* Webhooks.
* Uploaded files.
* Delivery jobs.
* Delivery attempts.
* Upload sessions.
* Encrypted secrets.

This avoids putting mutable delivery state or secrets inside configuration JSON.

## 5.5 Optional Cloudflare capabilities

The base application should continue running with only D1.

Bindings can be optional at runtime:

```ts
interface Env {
  DB: D1Database
  UPLOADS?: R2Bucket
  DELIVERY_QUEUE?: Queue<DeliveryQueueMessage>
  SUBMISSION_RATE_LIMITER?: RateLimit
  TURNSTILE_SECRET?: string
  FORMZERO_ENCRYPTION_KEY?: string
}
```

The dashboard should expose a capability status:

```text
R2 uploads             Configured
Background delivery    Configured
Rate limiting          Configured
Turnstile secret       Missing
Retention cron         Configured
```

A feature may not be enabled for a form unless its required binding exists.

---

# 6. Form policy model

```ts
export interface FormPolicyV1 {
  schemaVersion: 1

  fields: FieldRule[]

  request: {
    maxPayloadBytes: number
    rejectUnknownFields: boolean
    allowedContentTypes: Array<
      | "application/json"
      | "application/x-www-form-urlencoded"
      | "multipart/form-data"
    >
  }

  security: {
    allowedOrigins: string[]
    allowMissingOrigin: boolean

    captcha:
      | {
          enabled: false
        }
      | {
          enabled: true
          provider: "turnstile"
          siteKey: string
          credentialId: string
          expectedAction?: string
        }

    honeypot: {
      enabled: boolean
      fieldName: string
      startedAtFieldName?: string
      minimumFillTimeMs?: number
      response: "reject" | "accept-and-discard"
    }

    rateLimit:
      | {
          enabled: false
        }
      | {
          enabled: true
          profile: "strict" | "standard" | "relaxed"
          key: "ip" | "ip-and-form"
        }
  }

  notifications: {
    enabled: boolean
    recipients: string[]
    replyToField?: string
    subjectTemplate?: string
  }

  uploads: {
    enabled: boolean
    mode: "inline" | "direct"
    maxFiles: number
    maxFileBytes: number
    maxTotalBytes: number
    allowedMimeTypes: string[]
    allowedExtensions: string[]
  }

  retention: {
    submissionsDays: number | null
    filesDays: number | null
  }

  redirects: {
    successUrl?: string
    errorUrl?: string
    allowedOrigins: string[]
  }
}

export interface FieldRule {
  name: string
  label?: string

  type:
    | "string"
    | "email"
    | "url"
    | "tel"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "select"
    | "string-array"
    | "file"
    | "files"

  required: boolean
  trim?: boolean

  minLength?: number
  maxLength?: number

  minimum?: number
  maximum?: number

  pattern?: string
  options?: string[]
}
```

## 6.1 Reserved internal fields

Reserve the `_fz_` namespace:

```text
_fz_honeypot
_fz_started_at
_fz_upload_tokens
_fz_idempotency
_fz_redirect
```

Also recognize and remove:

```text
cf-turnstile-response
```

Internal fields are processed by FormZero and never stored as ordinary submission fields.

---

# 7. Database design

## 7.1 Forms

```sql
ALTER TABLE forms
ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE forms
ADD COLUMN config_schema_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE forms
ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
```

Configuration saves should use optimistic concurrency:

```sql
UPDATE forms
SET
  config_json = ?,
  config_schema_version = ?,
  config_revision = config_revision + 1,
  updated_at = ?
WHERE id = ?
  AND config_revision = ?;
```

If no row changes, the dashboard reports that another session modified the configuration.

## 7.2 Submissions

```sql
ALTER TABLE submissions
ADD COLUMN config_revision INTEGER;

ALTER TABLE submissions
ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted';

ALTER TABLE submissions
ADD COLUMN source_origin TEXT;

ALTER TABLE submissions
ADD COLUMN source_ip_hash TEXT;

ALTER TABLE submissions
ADD COLUMN user_agent TEXT;

ALTER TABLE submissions
ADD COLUMN delete_after INTEGER;
```

Recommended statuses:

```text
accepted
spam
pending_files
processing
failed
```

Raw IP addresses should not be retained by default. Use a keyed hash when operational correlation is required.

## 7.3 Encrypted secrets

```sql
CREATE TABLE form_secrets (
  id TEXT PRIMARY KEY,
  form_id TEXT,
  purpose TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

CREATE INDEX form_secrets_form_idx
ON form_secrets(form_id, purpose);
```

Secrets include:

* Turnstile secret credentials.
* Webhook signing secrets.
* Future provider API keys.

Encrypt values using AES-GCM with a Worker secret:

```text
FORMZERO_ENCRYPTION_KEY
```

The existing SMTP password should eventually be migrated from its ordinary settings column into the same secret mechanism.

## 7.4 Webhooks

```sql
CREATE TABLE form_webhooks (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_id TEXT NOT NULL,
  event_types TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
  FOREIGN KEY (secret_id) REFERENCES form_secrets(id)
);

CREATE INDEX form_webhooks_form_idx
ON form_webhooks(form_id, enabled);
```

`event_types` can initially contain:

```json
["submission.created"]
```

## 7.5 Delivery jobs

Use one table for email and webhook delivery.

```sql
CREATE TABLE delivery_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  locked_at INTEGER,
  completed_at INTEGER,
  response_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);

CREATE INDEX delivery_jobs_pending_idx
ON delivery_jobs(status, available_at);
```

Kinds:

```text
notification_email
webhook
```

Queue messages should contain only the job ID:

```ts
type DeliveryQueueMessage = {
  jobId: string
}
```

This avoids copying submission PII into the queue payload.

## 7.6 Upload sessions

```sql
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

CREATE INDEX upload_sessions_expiry_idx
ON upload_sessions(status, expires_at);
```

Statuses:

```text
pending
completed
attached
expired
```

## 7.7 File metadata

```sql
CREATE TABLE submission_files (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  submission_id TEXT,
  upload_session_id TEXT,
  field_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delete_after INTEGER,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id)
);

CREATE INDEX submission_files_submission_idx
ON submission_files(submission_id);

CREATE INDEX submission_files_expiry_idx
ON submission_files(status, delete_after);
```

---

# 8. Backend module structure

Refactor the current route into domain-focused modules:

```text
app/
  lib/
    form-config/
      defaults.ts
      schema.ts
      types.ts
      migrate-config.ts
      load-form-policy.server.ts
      save-form-policy.server.ts

    submissions/
      errors.ts
      parse-request.server.ts
      normalize-fields.ts
      validate-fields.ts
      validate-origin.ts
      validate-redirect.ts
      validate-honeypot.ts
      verify-turnstile.server.ts
      apply-rate-limit.server.ts
      create-submission.server.ts
      response.server.ts

    uploads/
      validate-file.ts
      object-key.ts
      inline-upload.server.ts
      create-upload-session.server.ts
      complete-upload.server.ts
      download-file.server.ts
      cleanup-files.server.ts

    delivery/
      create-jobs.server.ts
      publish-jobs.server.ts
      process-job.server.ts
      process-email.server.ts
      process-webhook.server.ts
      webhook-signature.ts

    secrets/
      encrypt.server.ts
      decrypt.server.ts
      secret-store.server.ts

    retention/
      cleanup-expired.server.ts
      calculate-delete-after.ts
```

The route should orchestrate these modules but contain little business logic.

---

# 9. Submission processing pipeline

## 9.1 Processing order

```text
1. Resolve form and validated policy
2. Resolve dynamic CORS headers
3. Validate request method and content type
4. Check declared request size
5. Validate Origin
6. Apply coarse rate limit
7. Parse body with an actual size limit
8. Extract reserved internal fields
9. Check honeypot and minimum fill time
10. Verify Turnstile
11. Validate and normalize fields
12. Validate or attach uploaded files
13. Create submission and delivery jobs in D1
14. Publish delivery job IDs
15. Return JSON or safe redirect
```

Expensive work such as CAPTCHA verification and file processing occurs only after the cheapest rejection checks.

## 9.2 Route outline

```ts
export async function action({
  request,
  params,
  context,
}: Route.ActionArgs) {
  const env = context.cloudflare.env

  const form = await loadFormWithPolicy(env.DB, params.formId)

  if (!form) {
    return submissionError(request, {
      status: 404,
      code: "form_not_found",
    })
  }

  const cors = resolveCors(request, form.policy.security.allowedOrigins)

  try {
    validateContentType(request, form.policy.request)
    validateDeclaredBodySize(request, form.policy.request.maxPayloadBytes)
    validateOrigin(request, form.policy.security)

    await applyRateLimit({
      request,
      formId: form.id,
      config: form.policy.security.rateLimit,
      env,
    })

    const parsed = await parseSubmissionRequest({
      request,
      requestPolicy: form.policy.request,
      uploadPolicy: form.policy.uploads,
    })

    const internal = extractInternalFields(parsed)

    const honeypot = validateHoneypot({
      internal,
      config: form.policy.security.honeypot,
    })

    if (honeypot.discard) {
      return submissionSuccess(request, { cors })
    }

    await verifyTurnstile({
      token: internal.turnstileToken,
      request,
      config: form.policy.security.captcha,
      env,
    })

    const fields = validateAndNormalizeFields({
      values: parsed.fields,
      rules: form.policy.fields,
      rejectUnknownFields: form.policy.request.rejectUnknownFields,
    })

    const files = await prepareSubmissionFiles({
      parsedFiles: parsed.files,
      uploadTokens: internal.uploadTokens,
      form,
      env,
    })

    const submission = await createSubmissionWithJobs({
      db: env.DB,
      form,
      fields,
      files,
      request,
    })

    context.cloudflare.ctx.waitUntil(
      publishPendingDeliveryJobs(env, submission.id)
    )

    return submissionSuccess(request, {
      cors,
      submissionId: submission.id,
      redirectPolicy: form.policy.redirects,
    })
  } catch (error) {
    return mapSubmissionError(request, error, cors)
  }
}
```

---

# 10. Parsing and field validation

## 10.1 Repeated form values

The current use of `Object.fromEntries(formData)` loses repeated values because duplicate field names collapse into one property.

The new parser should use `formData.getAll(name)` for:

* Checkbox groups.
* Multi-select fields.
* `string-array`.
* Multiple-file fields.

## 10.2 Normalization rules

Examples:

* `string`: optionally trim.
* `email`: trim, normalize case only where appropriate, validate syntax.
* `number`: parse only complete valid numeric strings.
* `boolean`: support configured values such as `true`, `false`, `1`, `0`, `on`.
* `date`: require an ISO date.
* `datetime`: require a valid ISO timestamp.
* `select`: require one configured option.
* `string-array`: validate every value and apply an item count limit.
* `file`: require zero or one file.
* `files`: enforce configured count.

## 10.3 Error response

```json
{
  "success": false,
  "error": {
    "code": "validation_failed",
    "message": "The submission contains invalid fields.",
    "fields": {
      "email": "Enter a valid email address.",
      "message": "Must not exceed 5000 characters."
    },
    "requestId": "req_..."
  }
}
```

Recommended status codes:

| Status | Meaning                                    |
| -----: | ------------------------------------------ |
|    400 | Malformed request                          |
|    403 | Origin or CAPTCHA rejected                 |
|    404 | Form not found                             |
|    413 | Payload or file too large                  |
|    415 | Unsupported content type                   |
|    422 | Field validation failed                    |
|    429 | Rate limit exceeded                        |
|    500 | Internal processing failure                |
|    503 | Required configured capability unavailable |

For ordinary HTML forms, redirect to the configured error URL with only:

```text
?error=validation_failed&request_id=req_...
```

Do not put submitted field values or detailed internal errors in the redirect URL.

---

# 11. Origin and redirect security

## 11.1 Dynamic CORS

Replace:

```http
Access-Control-Allow-Origin: *
```

with the exact matching allowed origin.

```ts
function resolveCors(
  request: Request,
  allowedOrigins: string[]
): Headers {
  const headers = new Headers({
    Vary: "Origin",
  })

  const origin = request.headers.get("Origin")

  if (origin && allowedOrigins.includes(normalizeOrigin(origin))) {
    headers.set("Access-Control-Allow-Origin", origin)
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")
    headers.set("Access-Control-Allow-Headers", "Content-Type, Accept")
    headers.set("Access-Control-Max-Age", "86400")
  }

  return headers
}
```

Origin restrictions are an abuse-control mechanism, not authentication. Non-browser clients can manipulate or omit the header.

## 11.2 Missing origins

The policy must explicitly define whether missing `Origin` is accepted:

```ts
allowMissingOrigin: false
```

Possible reasons to permit missing origins:

* Server-to-server integrations.
* Legacy HTML clients.
* Command-line submissions.

The dashboard should show a warning when enabled.

## 11.3 Safe redirects

Success and error redirect URLs must:

* Use `https`, except optionally localhost in development.
* Match a configured allowed redirect origin.
* Reject protocol-relative URLs.
* Reject `javascript:`, `data:`, and similar schemes.

The current unrestricted redirect query parameter should be removed or treated only as a requested redirect that must pass policy validation.

---

# 12. CAPTCHA and honeypot

## 12.1 Turnstile

Turnstile requires server-side verification. Tokens are single-use and expire after five minutes, so the client-side widget alone is insufficient.

Implementation requirements:

* Read `cf-turnstile-response`.
* Reject missing tokens when enabled.
* Call Siteverify.
* Include an idempotency UUID.
* Optionally include the client IP.
* Verify `hostname`.
* Verify configured `action`.
* Remove the token before storing the submission.
* Fail closed if verification is unavailable.

## 12.2 Credential model

Initial recommended model:

* Site key stored in form policy.
* Secret stored in `form_secrets`.
* Secret encrypted using the instance encryption key.
* Policy references `credentialId`.

A simpler deployment may use one global `TURNSTILE_SECRET`, but the data model should not prevent multiple credentials later.

## 12.3 Honeypot

Recommended defaults:

```json
{
  "enabled": true,
  "fieldName": "_fz_honeypot",
  "startedAtFieldName": "_fz_started_at",
  "minimumFillTimeMs": 1500,
  "response": "accept-and-discard"
}
```

With `accept-and-discard`, FormZero returns a normal success response but does not create a real submission or delivery jobs.

This hides detection behavior from simple bots.

---

# 13. Rate limiting

## 13.1 Preset profiles

The Cloudflare Rate Limiting binding defines limits statically in Wrangler configuration rather than dynamically for every request.

Use three profiles:

```text
strict
standard
relaxed
```

Example bindings:

```jsonc
{
  "ratelimits": [
    {
      "name": "RATE_LIMIT_STRICT",
      "namespace_id": "1001",
      "simple": {
        "limit": 5,
        "period": 60
      }
    },
    {
      "name": "RATE_LIMIT_STANDARD",
      "namespace_id": "1002",
      "simple": {
        "limit": 15,
        "period": 60
      }
    },
    {
      "name": "RATE_LIMIT_RELAXED",
      "namespace_id": "1003",
      "simple": {
        "limit": 60,
        "period": 60
      }
    }
  ]
}
```

The key should be:

```text
<formId>:<hashedClientIp>
```

## 13.2 Global protection

Also apply a form-wide key:

```text
form:<formId>
```

This provides coarse protection against distributed attacks.

Because Cloudflare’s binding is location-scoped and permissive, a later strict mode can use a Durable Object for globally serialized counters.

---

# 14. Notification architecture

## 14.1 Separate transport from recipients

Keep SMTP transport global:

```text
SMTP host
SMTP port
SMTP username
SMTP password
SMTP secure mode
From address
From display name
```

Store form-specific behavior in the form policy:

```json
{
  "enabled": true,
  "recipients": [
    "events@example.com",
    "backup@example.com"
  ],
  "replyToField": "email",
  "subjectTemplate": "New {{form.name}} submission"
}
```

The existing email renderer can be retained and refactored to:

* Use configured field labels.
* Include file metadata and authenticated download links.
* Set `replyTo` from a validated email field.
* Send to per-form recipients.
* Escape all submitted values.
* Avoid attaching uploaded files by default.

## 14.2 Queue processing

The HTTP request creates an email delivery job.

The Queue consumer:

1. Claims the job.
2. Loads the submission and form policy.
3. Sends the message.
4. Marks the job complete.
5. Records failures and retries.

---

# 15. Webhook architecture

## 15.1 Payload

```json
{
  "id": "evt_...",
  "type": "submission.created",
  "createdAt": "2026-07-23T11:30:00.000Z",
  "form": {
    "id": "contact",
    "name": "Contact"
  },
  "submission": {
    "id": "sub_...",
    "createdAt": "2026-07-23T11:30:00.000Z",
    "data": {
      "name": "Example",
      "email": "example@example.com"
    },
    "files": [
      {
        "id": "file_...",
        "field": "attachment",
        "name": "document.pdf",
        "mimeType": "application/pdf",
        "size": 124530
      }
    ]
  }
}
```

Do not include direct public R2 URLs.

## 15.2 Signing

Sign the exact transmitted bytes with HMAC-SHA256:

```text
FormZero-Signature: t=<unix-timestamp>,v1=<signature>
FormZero-Event: submission.created
FormZero-Delivery: <job-id>
```

Signature input:

```text
<timestamp>.<raw-body>
```

Receivers should reject old timestamps to reduce replay risk.

## 15.3 Delivery security

Webhook configuration must:

* Require HTTPS outside development.
* Reject localhost.
* Reject private and link-local address destinations.
* Disable automatic redirect following or revalidate every redirect target.
* Use a configurable timeout.
* Cap response body reads.
* Never expose SMTP or Turnstile secrets.

## 15.4 Retries and idempotency

Queues may redeliver messages during retries, including successful messages from the same batch unless they were explicitly acknowledged. Consumers must therefore be idempotent.

Use the delivery job ID as the idempotency identifier.

Suggested retry progression:

```text
immediate
1 minute
5 minutes
30 minutes
2 hours
dead-letter queue
```

The dashboard should allow manual retry of failed deliveries.

---

# 16. R2 file-upload design

## 16.1 Storage layout

Use random, non-user-controlled keys:

```text
forms/<formId>/<year>/<month>/<fileId>
```

Temporary direct uploads:

```text
_tmp/<formId>/<uploadSessionId>/<fileId>
```

Do not place the original filename in the R2 key.

The original filename remains metadata in D1.

## 16.2 Private bucket

The R2 bucket must not be public.

Dashboard downloads use an authenticated Worker route:

```text
GET /forms/:formId/submissions/:submissionId/files/:fileId
```

The route must:

1. Require dashboard authentication.
2. Confirm the file belongs to the requested form and submission.
3. Read the object from R2.
4. Return `Content-Disposition: attachment`.
5. Return `X-Content-Type-Options: nosniff`.
6. Avoid caching private files publicly.

## 16.3 Inline multipart mode

Inline mode preserves ordinary HTML forms:

```html
<form
  method="post"
  enctype="multipart/form-data"
  action="https://forms.example.com/api/forms/contact/submissions"
>
```

Recommended initial limits:

```text
Maximum file:       10 MB
Maximum total:      25 MB
Maximum file count: 5
```

These application limits should remain far below the Worker account request-body limit and the Worker memory limit. Cloudflare currently documents a 100 MB inbound request-body limit for Free and Pro accounts and 128 MB Worker memory.

Validation includes:

* File count.
* Per-file size.
* Total size.
* Configured MIME allowlist.
* Configured extension allowlist.
* Filename sanitization.
* Field association.
* Optional magic-byte checks for common formats.

Uploaded objects should initially use a temporary status. They are marked attached only after the D1 submission transaction succeeds.

Because D1 and R2 cannot participate in one transaction, a scheduled cleanup removes orphan objects.

## 16.4 Direct upload mode

Direct mode is recommended for larger files and JavaScript integrations.

Flow:

```text
1. Browser requests upload session
2. FormZero validates form, origin, limits and rate limit
3. FormZero returns short-lived upload authorization
4. Browser uploads file data
5. FormZero completes upload and records metadata
6. Browser submits ordinary fields plus upload tokens
7. FormZero atomically attaches completed uploads
```

Routes:

```text
POST /api/forms/:formId/uploads
PUT  /api/forms/:formId/uploads/:sessionId/files/:fileId
POST /api/forms/:formId/uploads/:sessionId/complete
```

For very large files, expose R2 multipart upload operations. R2 supports up to 10,000 parts, with parts generally between 5 MiB and 5 GiB, and supports temporary presigned upload access.

Direct uploads should be optional. Plain HTML integration remains supported through inline mode.

## 16.5 Upload cleanup

Clean up:

* Expired upload sessions.
* Unattached temporary files.
* Failed multipart uploads.
* Submission files past retention.

R2 automatically aborts incomplete multipart uploads after a default period, but FormZero should still expire its corresponding D1 upload-session rows.

---

# 17. Durable delivery and the outbox pattern

Sending a Queue message after inserting a submission creates a failure window:

```text
D1 insert succeeds
Queue send fails
```

To prevent lost email and webhook jobs:

1. Insert the submission.
2. Insert file metadata.
3. Insert delivery jobs.
4. Execute these statements in one D1 batch.
5. Commit.
6. Publish job IDs to the Queue.
7. Run a scheduled sweeper for pending jobs not yet published.

D1 batches are transactional, making the submission and its delivery-job records atomic.

If Queue publishing succeeds but marking the job as published fails, the job may be delivered twice. The Queue consumer therefore claims work using a conditional update:

```sql
UPDATE delivery_jobs
SET
  status = 'processing',
  locked_at = ?,
  updated_at = ?
WHERE id = ?
  AND status IN ('pending', 'retry');
```

If the update changes no rows, the duplicate message is acknowledged without another delivery.

---

# 18. Retention

## 18.1 Explicit expiry timestamps

At submission creation:

```ts
const deleteAfter =
  retentionDays === null
    ? null
    : createdAt + retentionDays * 86_400_000
```

Store explicit timestamps on:

* Submission.
* Attached file.
* Temporary upload session.

Changing a form’s retention setting affects new submissions by default.

Applying a new rule to existing data requires a separate explicit dashboard action.

## 18.2 Scheduled handler

Extend the Worker:

```ts
export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    })
  },

  async queue(batch, env, ctx) {
    await processDeliveryBatch(batch, env, ctx)
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledMaintenance(env))
  },
} satisfies ExportedHandler<Env, DeliveryQueueMessage>
```

Maintenance jobs:

* Publish unqueued delivery jobs.
* Unlock abandoned processing jobs.
* Delete expired temporary uploads.
* Delete expired R2 objects.
* Delete expired submissions.
* Record cleanup failures for retry.

Delete R2 objects before deleting their metadata. If R2 deletion fails, retain the D1 record for retry.

---

# 19. Dashboard design

## 19.1 Route structure

Change the current settings route into a settings layout:

```text
/forms/:formId/settings
/forms/:formId/settings/general
/forms/:formId/settings/fields
/forms/:formId/settings/security
/forms/:formId/settings/notifications
/forms/:formId/settings/webhooks
/forms/:formId/settings/uploads
/forms/:formId/settings/retention
/forms/:formId/settings/advanced
```

React Router configuration:

```ts
route("settings", "routes/forms.$formId.settings.tsx", [
  index("routes/forms.$formId.settings.general.tsx"),
  route("fields", "routes/forms.$formId.settings.fields.tsx"),
  route("security", "routes/forms.$formId.settings.security.tsx"),
  route(
    "notifications",
    "routes/forms.$formId.settings.notifications.tsx"
  ),
  route("webhooks", "routes/forms.$formId.settings.webhooks.tsx"),
  route("uploads", "routes/forms.$formId.settings.uploads.tsx"),
  route("retention", "routes/forms.$formId.settings.retention.tsx"),
  route("advanced", "routes/forms.$formId.settings.advanced.tsx"),
])
```

## 19.2 General

Controls:

* Form name.
* Form ID display.
* Success URL.
* Error URL.
* Allowed redirect origins.
* Delete form.

## 19.3 Fields

Use an ordered field table:

| Field   | Type      | Required | Constraints      |      |
| ------- | --------- | -------: | ---------------- | ---- |
| Name    | Text      |      Yes | 2–100 characters | Edit |
| Email   | Email     |      Yes | Maximum 254      | Edit |
| Message | Long text |      Yes | Maximum 5000     | Edit |

Actions:

* Add field.
* Edit field.
* Reorder.
* Duplicate.
* Delete.
* Reject unknown fields toggle.

Validation must prevent:

* Duplicate field names.
* `_fz_` names.
* Invalid combinations of type and constraints.
* Required fields with unusable limits.
* Invalid regular expressions.

## 19.4 Security

Controls:

* Allowed origins.
* Allow missing Origin warning.
* CAPTCHA enablement.
* Turnstile site key.
* Turnstile credential status.
* Expected action.
* Honeypot field.
* Minimum completion time.
* Rate-limit profile.

## 19.5 Notifications

Controls:

* Enabled.
* Recipient chips.
* Reply-to field dropdown.
* Subject template.
* Test email.

The reply-to dropdown should include only fields whose type is `email`.

## 19.6 Webhooks

Each webhook card shows:

* URL.
* Events.
* Enabled state.
* Secret status.
* Last delivery.
* Last HTTP status.
* Test action.
* Rotate secret.
* Delivery history.
* Manual retry.

## 19.7 Uploads

Controls:

* Enable uploads.
* Inline or direct mode.
* File field selection.
* Maximum files.
* Per-file limit.
* Total limit.
* MIME presets.
* Extension allowlist.
* Retention.
* Current R2 capability status.

## 19.8 Retention

Options:

* Keep forever.
* 30 days.
* 90 days.
* 180 days.
* 365 days.
* Custom days.

Separate:

* Submission retention.
* File retention.
* Temporary upload expiry.

Applying a shorter period to existing records requires confirmation showing the number of affected submissions and files.

## 19.9 Advanced JSON

The advanced editor exposes the policy JSON.

Requirements:

* Validate through the same runtime schema as the server.
* Format JSON.
* Display schema version.
* Show a diff before saving.
* Reject secret values.
* Preserve optimistic concurrency revision.

---

# 20. Integration-page improvements

The existing integration page should generate examples from the current policy.

## Plain HTML example

Include:

* Configured fields.
* `required`.
* `maxlength`.
* `min`.
* `max`.
* `accept`.
* `multiple`.
* `enctype="multipart/form-data"` where required.
* Honeypot markup.
* Turnstile script and widget.
* Form action.
* Success behavior.

## JavaScript example

Generate:

* JSON request example.
* Structured error handling.
* Turnstile token handling.
* Direct-upload flow where enabled.
* Allowed origin reminder.

## Public safe configuration endpoint

Optionally add:

```text
GET /api/forms/:formId/public-config
```

It may return only non-sensitive information:

```json
{
  "formId": "contact",
  "fields": [],
  "captcha": {
    "enabled": true,
    "provider": "turnstile",
    "siteKey": "..."
  },
  "uploads": {
    "enabled": true,
    "mode": "direct",
    "maxFiles": 3,
    "maxFileBytes": 10000000
  }
}
```

Never include secrets, recipients, webhook URLs, or internal retention metadata.

---

# 21. Wrangler configuration

A complete deployment can add:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "formzero",
  "main": "./workers/app.ts",
  "compatibility_date": "2026-07-23",
  "compatibility_flags": ["nodejs_compat"],

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "formzero",
      "database_id": "<DATABASE_ID>"
    }
  ],

  "r2_buckets": [
    {
      "binding": "UPLOADS",
      "bucket_name": "formzero-uploads"
    }
  ],

  "queues": {
    "producers": [
      {
        "binding": "DELIVERY_QUEUE",
        "queue": "formzero-deliveries"
      }
    ],
    "consumers": [
      {
        "queue": "formzero-deliveries",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "formzero-deliveries-dlq"
      }
    ]
  },

  "ratelimits": [
    {
      "name": "RATE_LIMIT_STRICT",
      "namespace_id": "1001",
      "simple": {
        "limit": 5,
        "period": 60
      }
    },
    {
      "name": "RATE_LIMIT_STANDARD",
      "namespace_id": "1002",
      "simple": {
        "limit": 15,
        "period": 60
      }
    },
    {
      "name": "RATE_LIMIT_RELAXED",
      "namespace_id": "1003",
      "simple": {
        "limit": 60,
        "period": 60
      }
    }
  ],

  "triggers": {
    "crons": ["17 3 * * *"]
  },

  "observability": {
    "enabled": true
  }
}
```

Cloudflare Queues producer and consumer bindings are configured through the Worker’s Wrangler configuration.

Secrets are configured separately:

```bash
wrangler secret put FORMZERO_ENCRYPTION_KEY
wrangler secret put TURNSTILE_SECRET
```

---

# 22. Configuration validation

Add a runtime schema library, preferably Zod.

The same schema validates:

* Dashboard input.
* Advanced JSON.
* Data loaded from D1.
* Default policies.
* Public configuration output.
* Policy migrations.

```ts
export const FormPolicyV1Schema = z.object({
  schemaVersion: z.literal(1),
  fields: z.array(FieldRuleSchema).max(100),
  request: RequestPolicySchema,
  security: SecurityPolicySchema,
  notifications: NotificationPolicySchema,
  uploads: UploadPolicySchema,
  retention: RetentionPolicySchema,
  redirects: RedirectPolicySchema,
}).superRefine(validateCrossFieldRules)
```

Cross-field validation includes:

* Unique field names.
* Valid notification reply-to field.
* File rules only for file fields.
* Multipart content type when inline files are enabled.
* R2 capability when uploads are enabled.
* Turnstile credential when CAPTCHA is enabled.
* Redirect origins matching configured URLs.

---

# 23. Testing strategy

## 23.1 Unit tests

Test:

* Policy parsing and defaults.
* Policy schema migrations.
* Every field type.
* Unknown fields.
* Repeated values.
* Payload-size enforcement.
* Origin normalization.
* Redirect validation.
* Honeypot modes.
* Turnstile response mapping.
* File constraint validation.
* Webhook signatures.
* Retention calculations.
* Encryption and decryption.

## 23.2 Integration tests

Test the Worker with:

* D1.
* Mock Turnstile.
* Mock SMTP.
* Mock webhook receiver.
* R2 uploads.
* Queue duplicate delivery.
* Queue retry and failure.
* Cron cleanup.

## 23.3 Security tests

Include:

* Open redirect attempts.
* MIME and extension mismatch.
* Path traversal filenames.
* Duplicate form fields.
* Reserved `_fz_` fields.
* Oversized JSON bodies.
* Oversized multipart bodies.
* Missing and forged origins.
* Replayed Turnstile tokens.
* Webhook SSRF targets.
* Webhook redirect to private address.
* Queue duplicate processing.
* Unauthenticated file downloads.

---

# 24. Implementation phases

## Phase 1 — policy foundation and synchronous validation

Implement:

* Form policy types and Zod schemas.
* D1 form policy migration.
* Configuration revision handling.
* Field builder.
* Required and allowed fields.
* Types and constraints.
* Payload limits.
* Dynamic CORS.
* Origin restrictions.
* Safe redirects.
* Structured errors.
* Route refactor.

**Result:** A secure validated submission endpoint without new storage or queue resources.

## Phase 2 — abuse protection

Implement:

* Turnstile.
* Honeypot.
* Rate-limit profiles.
* Spam analytics/status.
* Capability detection.

**Result:** Public forms have layered spam and abuse controls.

## Phase 3 — notification and webhook delivery

Implement:

* Per-form recipients.
* SMTP transport separation.
* Webhook definitions.
* Secret encryption.
* Delivery jobs.
* Cloudflare Queue consumer.
* Queue retry and DLQ.
* Delivery history.
* Outbox sweeper.

**Result:** Durable and observable delivery.

## Phase 4 — R2 uploads

Implement:

* R2 binding.
* File metadata tables.
* Inline multipart uploads.
* Authenticated download route.
* Temporary object cleanup.
* Direct upload sessions.
* Optional multipart upload flow.

**Result:** Private file attachments without storing binary data in D1.

## Phase 5 — retention and operational controls

Implement:

* Scheduled maintenance handler.
* Submission retention.
* File retention.
* Existing-data retention application.
* Failed-job recovery.
* Storage and delivery status dashboards.

**Result:** Complete lifecycle management.

---

# 25. Recommended first production release

The first production milestone should contain:

```text
Versioned form policy
Field validation
Request-size limits
Origin restrictions
Safe redirects
Honeypot
Turnstile
Rate-limit profiles
Per-form email recipients
R2 inline uploads with conservative limits
Retention timestamps
```

Webhooks and direct multipart uploads can follow after the delivery-job and upload-session foundations are stable.

The most important implementation rule is:

> The public route orchestrates a pipeline; it does not implement every feature directly.

The intended final structure is:

```text
versioned form policy
        ↓
request and abuse-control pipeline
        ↓
field and file validation
        ↓
D1 submission transaction
        ↓
R2 private object storage
        ↓
durable delivery jobs
        ↓
Queue-based email and webhook processing
        ↓
scheduled retention and recovery
```

This architecture preserves FormZero’s small self-hosted character while making it suitable for real public forms, independent projects, file attachments, and reliable integrations.
