# FormZero-NG Final Code Review and Revised Design Proposal

**Repository:** `RobertCrash/formzero-ng`
**Reviewed branch:** `main`
**Reviewed commit:** `a4ddde255457d1e6ddf55b5f24b51809d18501f3`
**Status:** Final review and proposal revision

---

## 1. Executive conclusion

`formzero-ng` is currently an exact code-level duplicate of the upstream FormZero repository at commit `a4ddde255457d1e6ddf55b5f24b51809d18501f3`. The latest commit in both repositories is the same upstream merge commit, so no fork-specific architectural changes need to be reconciled yet.

The existing design proposal remains fundamentally correct:

* Versioned per-form submission policies.
* D1 as the relational system of record.
* JSON stored in selected D1 `TEXT` columns.
* R2 for file bodies.
* Queues for reliable delivery.
* Turnstile, honeypot, origin restrictions, and rate limiting.
* Normalized tables for operational entities.

Those foundations are already described in the previous proposal.

The proposal should, however, be revised in four material areas:

1. Add a complete backend-generated submission context model, including IP address, request timestamp, request ID, origin, Cloudflare Ray ID, country, network information, and security-processing results.
2. Define precisely which information belongs in ordinary columns and which belongs in D1 JSON columns.
3. Move dashboard statistics, pagination, and selected field filtering into D1 instead of loading every submission into the Worker.
4. Address existing security and correctness issues before adding new features.

---

# 2. Final codebase review

## 2.1 Critical: unauthenticated SMTP credential exposure

The global notification settings loader executes:

```sql
SELECT * FROM settings WHERE id = 'global'
```

and returns the complete row without calling `requireAuth()`. The route is registered as a top-level route, not beneath an authenticated parent.

The settings table contains the SMTP password as an ordinary plaintext column.

This means an unauthenticated request can potentially receive:

* SMTP account address.
* SMTP password.
* SMTP host.
* SMTP port.
* Other global notification settings.

### Required immediate correction

The loader must authenticate before reading any settings:

```ts
export async function loader({ context, request }: Route.LoaderArgs) {
  const database = context.cloudflare.env.DB

  await requireAuth(request, database)

  const settings = await database
    .prepare(`
      SELECT
        id,
        notification_email,
        smtp_host,
        smtp_port,
        smtp_secure,
        updated_at,
        notification_email_password IS NOT NULL AS has_password
      FROM settings
      WHERE id = 'global'
    `)
    .first()

  return data({ settings: settings ?? null })
}
```

The SMTP password must never be returned to the browser after it has been saved.

Longer term, the SMTP password should be moved to:

* A Worker secret for one global transport; or
* The encrypted secret store proposed for Turnstile and webhook secrets.

This issue should be corrected before deploying the current fork publicly.

---

## 2.2 High: unrestricted public submission processing

The public submission route currently:

* Returns `Access-Control-Allow-Origin: *`.
* Accepts arbitrary JSON keys.
* Applies no field validation.
* Applies no payload-size limit.
* Applies no CAPTCHA.
* Applies no rate limit.
* Applies no honeypot processing.
* Accepts an unrestricted redirect URL.

The integration page actively generates the unrestricted `?redirect=` parameter and describes it as a client-selected destination rather than a saved, validated setting.

This validates the proposal’s decision to make redirect URLs and allowed origins part of backend-controlled form policy.

---

## 2.3 High: multipart requests do not provide real file support

Multipart data is parsed using:

```ts
const formData = await request.formData()
submissionData = Object.fromEntries(formData)
```

and then JSON-stringified into D1.

This has two problems:

* `File` values are not stored as file bodies.
* Repeated fields collapse because `Object.fromEntries()` keeps only one value for each key.

Until the R2 implementation exists, FormZero should either:

* Reject multipart requests containing `File` values; or
* Explicitly advertise multipart as text-only.

The revised design retains R2 as the correct file-body store.

---

## 2.4 High: notification transport settings are inconsistent

The settings schema stores `smtp_secure`, and the settings action always saves it as `1`.

However, the email transport type does not include `smtp_secure`, and the Nodemailer transport is created without the `secure` option.

Consequently, the stored secure-mode setting is currently unused.

The global transport model should become:

```ts
interface SmtpTransportConfig {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromAddress: string
  fromName?: string
}
```

The per-form recipient configuration remains separate.

---

## 2.5 Medium: the dashboard does not scale with submission count

The submissions loader reads every submission for a form, parses every JSON payload, and calculates all statistics and chart buckets in Worker memory.

The frontend then discovers columns by scanning the loaded submission objects.

This causes several problems:

* No server-side pagination.
* Increasing Worker memory use.
* Increasing D1 rows read.
* Slow page rendering for large forms.
* Client-side CSV creation requires all submissions.
* Field sorting happens only within the loaded browser dataset.

The revised design moves:

* Counts to aggregate SQL.
* Chart buckets to SQL.
* Submission listing to cursor pagination.
* Dynamic field filters to D1 JSON queries.
* Large CSV exports to a server-side export route or background job.

---

## 2.6 Medium: JSON is stored but not database-validated

The current schema stores submission data as `TEXT` with a comment indicating that it contains JSON, but it does not have a `json_valid()` constraint.

The application currently uses `JSON.stringify()`, so normal submissions are valid. However, data imported through migrations, administrative scripts, or future code paths could still contain malformed JSON.

D1 supports JSON functions and operators over JSON stored in `TEXT`, including `json()`, `json_valid()`, `json_extract()`, `->`, `->>`, `json_each()`, and JSON mutation functions. Objects and arrays remain stored as text values.

The revised schema therefore adds database-level JSON validation.

---

## 2.7 Medium: manual deletion will need redesign after R2

The current submission delete route immediately removes the D1 row.

That is sufficient while submissions contain only D1 data. Once R2 files exist, deleting the D1 row first could orphan R2 objects.

The R2-enabled implementation must instead:

1. Mark the submission as `pending_delete`.
2. Delete associated R2 objects.
3. Remove file metadata.
4. Remove delivery records.
5. Remove the submission row.
6. Retry through scheduled maintenance if R2 deletion fails.

The same rule applies when deleting an entire form.

---

## 2.8 Medium: no automated test foundation

The package scripts contain no test command, and the dependency lists contain no test runner.

Before refactoring the submission route, add:

* Vitest.
* Cloudflare Workers test-pool support.
* Unit tests for policy and validation functions.
* Integration tests against local D1 and R2.
* Security regression tests for the notification loader and redirects.

---

# 3. Revised storage strategy

## 3.1 Storage rule

Use an ordinary relational column when a value is:

* Universal across submissions.
* Frequently filtered or sorted.
* Used for retention or operational state.
* Used in joins.
* Covered by a foreign key.
* Used to locate or delete external resources.

Use a JSON `TEXT` column when a value is:

* Form-specific.
* Structurally flexible.
* Provider-specific.
* Optional.
* Usually read as a group.
* Occasionally queried by path.
* Not part of lifecycle or delivery state.

D1’s JSON support reduces application-side parsing and filtering, but it does not turn every domain entity into a good JSON-document candidate. D1 stores JSON in `TEXT` and supports path extraction, array expansion, validation, and mutation directly in SQL.

## 3.2 Revised storage allocation

| Information                    | Storage                                 |
| ------------------------------ | --------------------------------------- |
| Form policy                    | `forms.config_json`                     |
| Submitted field values         | `submissions.data`                      |
| Flexible request context       | `submissions.metadata_json`             |
| Submission ID, form ID, status | Ordinary columns                        |
| Backend timestamp              | Ordinary column                         |
| IP address and IP hash         | Ordinary columns                        |
| Origin and country code        | Ordinary columns                        |
| Cloudflare Ray ID              | Ordinary column                         |
| Retention timestamps           | Ordinary columns                        |
| File metadata                  | `submission_files` rows                 |
| File bodies                    | R2                                      |
| Webhook URL and status         | `form_webhooks` rows                    |
| Webhook event list             | JSON column in webhook row              |
| Delivery state and attempts    | Ordinary relational rows                |
| Secrets                        | Encrypted secret rows or Worker secrets |

---

# 4. Revised submission schema

The submission table should combine relational operational fields with two JSON documents.

```sql
CREATE TABLE submissions_v2 (
  id TEXT PRIMARY KEY,

  form_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,

  config_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (
      status IN (
        'accepted',
        'spam',
        'pending_files',
        'pending_delete',
        'failed'
      )
    ),

  data TEXT NOT NULL
    CHECK (json_valid(data)),

  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json)),

  source_ip TEXT,
  source_ip_hash TEXT,

  source_origin TEXT,
  country_code TEXT,
  cf_ray TEXT,

  created_at INTEGER NOT NULL,
  processed_at INTEGER,

  ip_delete_after INTEGER,
  delete_after INTEGER,

  FOREIGN KEY (form_id)
    REFERENCES forms(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_submissions_form_created
ON submissions_v2(form_id, created_at DESC, id DESC);

CREATE INDEX idx_submissions_request_id
ON submissions_v2(request_id);

CREATE INDEX idx_submissions_status
ON submissions_v2(form_id, status, created_at DESC);

CREATE INDEX idx_submissions_ip_hash
ON submissions_v2(form_id, source_ip_hash);

CREATE INDEX idx_submissions_retention
ON submissions_v2(delete_after)
WHERE delete_after IS NOT NULL;

CREATE INDEX idx_submissions_ip_retention
ON submissions_v2(ip_delete_after)
WHERE ip_delete_after IS NOT NULL;
```

### Why IP remains an ordinary column

For the stated requirement, the raw backend-observed IP address should be stored in `source_ip`.

It should not be buried exclusively inside `metadata_json` because it may be required for:

* Abuse investigation.
* Submission filtering.
* IP-specific deletion or redaction.
* Rate-limit correlation.
* Retention processing.

Cloudflare recommends using `CF-Connecting-IP` rather than `X-Forwarded-For` when identifying the original visitor IP in ordinary requests reaching Cloudflare.

Because an IP address is personal data under EU data-protection guidance, its collection and retention should be visible and configurable.

Recommended form-level policy:

```ts
privacy: {
  ipMode: "full" | "hashed" | "none"
  ipRetentionDays: number | null
  storeUserAgent: boolean
  geoPrecision: "none" | "country" | "region"
}
```

For the requested deployment:

```ts
ipMode: "full"
```

A keyed HMAC should also be stored in `source_ip_hash`. Do not use an unkeyed SHA hash because the IPv4 space is enumerable.

---

# 5. Backend-generated submission information

## 5.1 Timestamp semantics

The current endpoint already generates `createdAt` on the backend using `Date.now()`.

This should be retained but moved to the beginning of request processing:

```ts
const receivedAt = Date.now()
```

That makes the timestamp represent when FormZero began handling the request, rather than when parsing and form lookup had already completed.

Store:

* `created_at`: backend receive timestamp.
* `processed_at`: timestamp after the D1 batch succeeds.
* `processingDurationMs`: flexible processing metric in metadata.

Client-supplied timestamps must never replace the backend timestamp.

## 5.2 Required backend context

Every accepted submission should determine the following at the Worker:

### Stable relational fields

```ts
interface SubmissionCoreContext {
  requestId: string
  createdAt: number
  processedAt: number | null

  sourceIp: string | null
  sourceIpHash: string | null

  origin: string | null
  countryCode: string | null
  cfRay: string | null
}
```

### Flexible JSON metadata

```ts
interface SubmissionMetadataV1 {
  schemaVersion: 1

  request: {
    method: "POST"
    contentType: string | null
    contentLength: number | null
    userAgent: string | null
    referer: string | null
    acceptLanguage: string | null
  }

  cloudflare: {
    colo?: string
    continent?: string
    regionCode?: string
    timezone?: string
    asn?: number
    asOrganization?: string
    httpProtocol?: string
    tlsVersion?: string
  }

  security: {
    originAccepted: boolean

    captcha?: {
      provider: "turnstile"
      verified: boolean
      hostname?: string
      action?: string
      errorCodes?: string[]
    }

    honeypot?: {
      enabled: boolean
      triggered: boolean
      minimumTimePassed?: boolean
    }

    rateLimit?: {
      enabled: boolean
      profile?: "strict" | "standard" | "relaxed"
    }
  }

  payload: {
    encoding:
      | "json"
      | "urlencoded"
      | "multipart"

    payloadBytes?: number
    fieldCount: number
    fileCount: number
    totalFileBytes: number
  }

  processing: {
    processingDurationMs: number
  }
}
```

Cloudflare exposes request information such as colo, country, city, continent, region, timezone, ASN-related information, HTTP protocol, and TLS version through `request.cf`.

The default metadata policy should store:

* Country.
* Continent.
* Region code where configured.
* Colo.
* ASN.
* HTTP protocol.
* TLS version.

It should not store city, postal code, latitude, or longitude by default. Those are unnecessary for ordinary form handling and increase privacy impact.

## 5.3 Metadata extraction

```ts
async function buildSubmissionContext(
  request: Request,
  env: Env,
  receivedAt: number
) {
  const requestId = crypto.randomUUID()
  const cf = request.cf

  const sourceIp =
    request.headers.get("CF-Connecting-IP")

  const sourceIpHash = sourceIp
    ? await createIpHmac(sourceIp, env.IP_HASH_SECRET)
    : null

  const contentLengthHeader =
    request.headers.get("Content-Length")

  return {
    core: {
      requestId,
      createdAt: receivedAt,
      sourceIp,
      sourceIpHash,
      origin: normalizeOriginOrNull(
        request.headers.get("Origin")
      ),
      countryCode:
        cf?.country ??
        request.headers.get("CF-IPCountry"),
      cfRay: request.headers.get("CF-Ray"),
    },

    metadata: {
      schemaVersion: 1,

      request: {
        method: "POST",
        contentType:
          request.headers.get("Content-Type"),
        contentLength:
          contentLengthHeader === null
            ? null
            : Number(contentLengthHeader),
        userAgent:
          request.headers.get("User-Agent"),
        referer:
          request.headers.get("Referer"),
        acceptLanguage:
          request.headers.get("Accept-Language"),
      },

      cloudflare: {
        colo: cf?.colo,
        continent: cf?.continent,
        regionCode: cf?.regionCode,
        timezone: cf?.timezone,
        asn: cf?.asn,
        asOrganization: cf?.asOrganization,
        httpProtocol: cf?.httpProtocol,
        tlsVersion: cf?.tlsVersion,
      },
    },
  }
}
```

In local development, `request.cf` may be absent, so every Cloudflare-specific property must remain optional.

Never store:

* Turnstile response tokens.
* SMTP passwords.
* Webhook signing secrets.
* Authorization or cookie headers.
* Complete arbitrary request-header collections.
* R2 temporary credentials.

---

# 6. Revised D1 JSON implementation

## 6.1 Validate and canonicalize JSON at insertion

Use both application validation and D1 JSON validation:

```ts
const serializedData = JSON.stringify(validatedFields)
const serializedMetadata = JSON.stringify(metadata)

const insertSubmission = env.DB.prepare(`
  INSERT INTO submissions (
    id,
    form_id,
    request_id,
    config_revision,
    status,
    data,
    metadata_json,
    source_ip,
    source_ip_hash,
    source_origin,
    country_code,
    cf_ray,
    created_at,
    processed_at,
    ip_delete_after,
    delete_after
  )
  VALUES (
    ?, ?, ?, ?, ?,
    json(?),
    json(?),
    ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`).bind(
  submissionId,
  form.id,
  requestId,
  form.configRevision,
  "accepted",
  serializedData,
  serializedMetadata,
  sourceIp,
  sourceIpHash,
  origin,
  countryCode,
  cfRay,
  createdAt,
  processedAt,
  ipDeleteAfter,
  deleteAfter
)
```

D1’s `json()` function validates JSON and returns a minified representation. `json_valid()` can enforce validity at the schema level.

## 6.2 Query selected submission fields in D1

Example email projection:

```sql
SELECT
  id,
  created_at,
  data ->> '$.email' AS email
FROM submissions
WHERE form_id = ?
ORDER BY created_at DESC
LIMIT ?;
```

Example dynamic field filter:

```sql
SELECT
  id,
  data,
  metadata_json,
  created_at
FROM submissions
WHERE form_id = ?
  AND json_extract(data, ?) = ?
ORDER BY created_at DESC, id DESC
LIMIT ?;
```

The JSON path must be generated from a validated configured field name and passed as a bound value.

Example array membership:

```sql
SELECT s.id, s.data
FROM submissions AS s
WHERE s.form_id = ?
  AND EXISTS (
    SELECT 1
    FROM json_each(s.data, '$.interests') AS item
    WHERE item.value = ?
  );
```

D1 supports `json_each()` for expanding JSON objects and arrays into queryable rows.

## 6.3 Keep submitted data immutable

After a submission is accepted, its `data` document should normally remain immutable.

Use JSON mutation functions such as `json_set()` or `json_patch()` only for:

* Configuration editing.
* Optional non-critical metadata enrichment.
* Explicit administrative data correction.

Do not use JSON updates for:

* Delivery job states.
* File deletion states.
* Retry counters.
* Retention timestamps.
* Locks.
* Foreign-key relationships.

Those remain ordinary relational fields.

## 6.4 Generated columns

D1 supports generated columns based on extracted JSON values and allows indexes on those generated columns.

They should not be added for arbitrary form fields in the first version because:

* Every form may use different field names.
* One generated column definition applies to the whole submissions table.
* Per-form schema changes would become database migrations.
* Most installations will not need indexes on every custom field.

If a universal JSON property becomes performance-critical, it can be promoted later.

Example:

```sql
ALTER TABLE submissions
ADD COLUMN user_agent_generated
AS (
  json_extract(
    metadata_json,
    '$.request.userAgent'
  )
);
```

Because generated columns added to existing tables are virtual, a stored generated column would require rebuilding the table.

For universally queried information such as IP, status, country, timestamp, and origin, ordinary columns remain the better choice.

---

# 7. Revised form configuration storage

```sql
ALTER TABLE forms
ADD COLUMN config_json TEXT NOT NULL
DEFAULT '{}';

ALTER TABLE forms
ADD COLUMN config_schema_version INTEGER NOT NULL
DEFAULT 1;

ALTER TABLE forms
ADD COLUMN config_revision INTEGER NOT NULL
DEFAULT 1;
```

The final table definition should enforce:

```sql
CHECK (json_valid(config_json))
```

Configuration is a good JSON candidate because:

* It is versioned.
* It has optional nested sections.
* Most of it is read together when processing a submission.
* Its shape will evolve.
* It does not require relational joins for every property.

Configuration queries may use D1 JSON directly:

```sql
SELECT id, name
FROM forms
WHERE config_json ->> '$.uploads.enabled' = 1;
```

However, `config_schema_version`, `config_revision`, form ID, form name, and timestamps should remain ordinary columns.

---

# 8. Revised dashboard queries

## 8.1 Aggregate statistics

Replace application-side filtering with:

```sql
SELECT
  COUNT(*) AS total,

  SUM(
    CASE WHEN created_at >= ?
    THEN 1 ELSE 0 END
  ) AS this_week,

  SUM(
    CASE
      WHEN created_at >= ?
       AND created_at < ?
      THEN 1 ELSE 0
    END
  ) AS previous_week,

  SUM(
    CASE WHEN created_at >= ?
    THEN 1 ELSE 0 END
  ) AS this_month,

  SUM(
    CASE
      WHEN created_at >= ?
       AND created_at < ?
      THEN 1 ELSE 0
    END
  ) AS previous_month
FROM submissions
WHERE form_id = ?
  AND status = 'accepted';
```

## 8.2 Daily chart

```sql
SELECT
  date(
    created_at / 1000,
    'unixepoch'
  ) AS day,
  COUNT(*) AS count
FROM submissions
WHERE form_id = ?
  AND status = 'accepted'
  AND created_at >= ?
GROUP BY day
ORDER BY day;
```

The application only needs to fill missing dates in the returned 30-day range.

## 8.3 Cursor pagination

```sql
SELECT
  id,
  request_id,
  data,
  metadata_json,
  source_ip,
  source_origin,
  country_code,
  created_at,
  status
FROM submissions
WHERE form_id = ?
  AND (
    created_at < ?
    OR (
      created_at = ?
      AND id < ?
    )
  )
ORDER BY created_at DESC, id DESC
LIMIT ?;
```

For the first page, omit the cursor predicate.

## 8.4 Dashboard columns

Columns should primarily come from the form’s configured field policy rather than scanning every stored submission.

Legacy submissions with no field policy can use:

```sql
SELECT DISTINCT field.key
FROM submissions AS submission,
     json_each(submission.data) AS field
WHERE submission.form_id = ?;
```

## 8.5 CSV export

Small exports may be streamed from an authenticated route.

Large exports should:

1. Create an export job.
2. Process records in pages.
3. Write the CSV to R2.
4. Provide a short-lived authenticated download.

---

# 9. Revised D1 transaction and outbox design

Submission creation should use a D1 batch containing:

* Submission insert.
* File metadata inserts.
* Email delivery-job insert.
* Webhook delivery-job inserts.

D1 executes batched statements as a transaction and rolls back the sequence if a statement fails.

```ts
await env.DB.batch([
  insertSubmission,
  ...fileStatements,
  ...deliveryJobStatements,
])
```

After the batch commits:

```ts
ctx.waitUntil(
  publishPendingDeliveryJobs(
    env,
    submissionId
  )
)
```

A scheduled outbox sweeper republishes jobs that remain in `pending` state.

Queue messages should contain only:

```ts
{
  jobId: string
}
```

They should not contain the submission payload or IP address.

---

# 10. Revised R2 integration

The existing R2 design remains valid:

* R2 stores file bodies.
* D1 stores file metadata.
* The bucket remains private.
* R2 object keys are random.
* Original filenames are metadata only.
* Downloads pass through an authenticated Worker route.
* Inline uploads have conservative limits.
* Direct upload sessions support larger files.
* Scheduled cleanup removes incomplete or orphaned uploads.

Additional deletion requirement:

```text
submission delete request
        ↓
mark pending_delete in D1
        ↓
delete R2 files
        ↓
delete file metadata
        ↓
delete delivery records
        ↓
delete submission
```

A form must not be physically removed until all of its R2 objects have either been deleted or recorded for retry.

---

# 11. Revised form policy additions

Add a `privacy` and `metadata` section:

```ts
interface FormPolicyV1 {
  schemaVersion: 1

  fields: FieldRule[]

  request: {
    maxPayloadBytes: number
    rejectUnknownFields: boolean
    allowedContentTypes: string[]
  }

  security: {
    allowedOrigins: string[]
    allowMissingOrigin: boolean
    captcha: CaptchaPolicy
    honeypot: HoneypotPolicy
    rateLimit: RateLimitPolicy
  }

  privacy: {
    ipMode: "full" | "hashed" | "none"
    ipRetentionDays: number | null

    storeUserAgent: boolean
    storeReferer: boolean

    geoPrecision:
      | "none"
      | "country"
      | "region"
  }

  notifications: {
    enabled: boolean
    recipients: string[]
    replyToField?: string
    subjectTemplate?: string
  }

  uploads: UploadPolicy
  retention: RetentionPolicy
  redirects: RedirectPolicy
}
```

Recommended defaults:

```json
{
  "privacy": {
    "ipMode": "full",
    "ipRetentionDays": 30,
    "storeUserAgent": true,
    "storeReferer": true,
    "geoPrecision": "country"
  }
}
```

Raw IP retention can be shorter than submission retention.

The scheduled handler may redact only the IP:

```sql
UPDATE submissions
SET source_ip = NULL
WHERE ip_delete_after IS NOT NULL
  AND ip_delete_after <= ?
  AND source_ip IS NOT NULL;
```

The keyed IP hash may be retained longer for abuse correlation if this is documented in the privacy policy.

---

# 12. Migration strategy

## 12.1 Emergency migration-independent patch

Before schema work:

1. Authenticate the notification settings loader.
2. Stop returning SMTP passwords.
3. Correct `smtp_secure`.
4. Validate or disable arbitrary redirects.
5. Reject multipart file values until R2 support exists.

## 12.2 Form policy migration

Existing forms cannot immediately default to `rejectUnknownFields: true` with no configured fields, because that would break all current integrations.

Create a legacy-compatible initial policy:

```json
{
  "schemaVersion": 1,
  "fields": [],
  "request": {
    "maxPayloadBytes": 50000,
    "rejectUnknownFields": false,
    "allowedContentTypes": [
      "application/json",
      "application/x-www-form-urlencoded"
    ]
  },
  "security": {
    "allowedOrigins": [],
    "allowMissingOrigin": true,
    "captcha": {
      "enabled": false
    },
    "honeypot": {
      "enabled": false,
      "fieldName": "_fz_honeypot",
      "response": "accept-and-discard"
    },
    "rateLimit": {
      "enabled": false
    }
  }
}
```

The dashboard should display:

```text
Legacy unrestricted policy
Configure fields and security before production use.
```

New forms should use secure defaults.

## 12.3 Submission-table migration

Because the existing table lacks JSON constraints, rebuild it:

```sql
CREATE TABLE submissions_new (
  -- revised schema
);
```

Copy existing rows:

```sql
INSERT INTO submissions_new (
  id,
  form_id,
  request_id,
  config_revision,
  status,
  data,
  metadata_json,
  created_at
)
SELECT
  id,
  form_id,
  'legacy-' || id,
  0,
  'accepted',
  json(data),
  json('{}'),
  created_at
FROM submissions
WHERE json_valid(data);
```

Before migration, run:

```sql
SELECT id
FROM submissions
WHERE NOT json_valid(data);
```

The migration should stop if malformed legacy rows exist so they can be repaired explicitly.

---

# 13. Revised implementation order

## P0 — immediate security corrections

* Protect notification settings loader.
* Never return stored passwords.
* Correct SMTP secure-mode handling.
* Restrict redirect destinations.
* Reject unsupported multipart files.
* Add security regression tests.

## P1 — policy, metadata, and D1 JSON foundation

* Add Zod.
* Add form policy columns.
* Add revised submission schema.
* Capture backend request context.
* Store IP address and keyed IP hash.
* Store flexible metadata JSON.
* Validate JSON with D1.
* Refactor submission route into modules.
* Add structured errors.
* Add cursor pagination and D1 aggregate queries.

## P2 — abuse controls

* Dynamic CORS.
* Origin enforcement.
* Honeypot.
* Turnstile.
* Rate-limit profiles.
* Security metadata.
* IP redaction schedule.

## P3 — durable integrations

* Per-form notification recipients.
* Encrypted secret storage.
* Delivery jobs.
* Cloudflare Queue.
* Webhook signing.
* Retries and dead-letter handling.
* Delivery history.

## P4 — R2 files

* Private R2 bucket.
* Inline multipart uploads.
* Upload sessions.
* Authenticated downloads.
* R2-aware submission and form deletion.
* Orphan cleanup.

## P5 — lifecycle and operations

* Submission retention.
* File retention.
* IP-specific retention.
* Export jobs.
* Storage monitoring.
* Failed-job and failed-cleanup recovery.

---

# 14. Final architecture

```text
backend-generated request context
        ↓
versioned form policy
        ↓
origin and rate-limit checks
        ↓
request parsing and honeypot
        ↓
Turnstile verification
        ↓
field and file validation
        ↓
D1 batch
  ├── relational submission context
  ├── submitted data JSON
  ├── flexible metadata JSON
  ├── file metadata
  └── delivery jobs
        ↓
R2 private file storage
        ↓
Cloudflare Queue
  ├── email
  └── webhooks
        ↓
scheduled maintenance
  ├── outbox recovery
  ├── IP redaction
  ├── submission retention
  ├── R2 cleanup
  └── deletion recovery
```

The central storage principle is:

> Use D1 JSON for flexible documents, not for lifecycle state.

Submitted fields, form policy, and optional request context benefit from D1 JSON functions. IP addresses, timestamps, statuses, retention values, R2 object references, job states, and foreign-key relationships remain ordinary relational data.
