-- Migration number: 0005
-- Submission policy, delivery, upload, and retention platform.

ALTER TABLE forms
ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json));

ALTER TABLE forms
ADD COLUMN config_schema_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE forms
ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;

UPDATE forms
SET config_json = json('{
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
    "captcha": { "enabled": false },
    "honeypot": {
      "enabled": false,
      "fieldName": "_fz_honeypot",
      "response": "accept-and-discard"
    },
    "rateLimit": { "enabled": false }
  },
  "privacy": {
    "ipMode": "full",
    "ipRetentionDays": 30,
    "storeUserAgent": true,
    "storeReferer": true,
    "geoPrecision": "country"
  },
  "notifications": {
    "enabled": false,
    "recipients": []
  },
  "uploads": {
    "enabled": false,
    "mode": "inline",
    "maxFiles": 5,
    "maxFileBytes": 10000000,
    "maxTotalBytes": 25000000,
    "allowedMimeTypes": [],
    "allowedExtensions": []
  },
  "retention": {
    "submissionsDays": null,
    "filesDays": null
  },
  "redirects": {
    "allowedOrigins": []
  }
}');

UPDATE forms
SET config_json = json_set(
    config_json,
    '$.notifications.enabled',
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM settings
        WHERE id = 'global'
          AND notification_email IS NOT NULL
          AND notification_email_password IS NOT NULL
          AND smtp_host IS NOT NULL
          AND smtp_port IS NOT NULL
      ) THEN json('true')
      ELSE json('false')
    END,
    '$.notifications.recipients',
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM settings
        WHERE id = 'global'
          AND notification_email IS NOT NULL
          AND notification_email_password IS NOT NULL
          AND smtp_host IS NOT NULL
          AND smtp_port IS NOT NULL
      ) THEN json_array((
        SELECT notification_email
        FROM settings
        WHERE id = 'global'
      ))
      ELSE json('[]')
    END
);

CREATE TABLE submissions_new (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
    config_revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN (
            'accepted',
            'spam',
            'pending_files',
            'pending_delete',
            'failed'
        )),
    data TEXT NOT NULL CHECK (json_valid(data)),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    source_ip TEXT,
    source_ip_hash TEXT,
    source_origin TEXT,
    country_code TEXT,
    cf_ray TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER,
    ip_delete_after INTEGER,
    delete_after INTEGER,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

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
    CASE
      WHEN json_valid(data) THEN 'accepted'
      ELSE 'failed'
    END,
    CASE
      WHEN json_valid(data) THEN json(data)
      ELSE json_object(
        '_legacy_raw',
        data,
        '_migration_error',
        'invalid_legacy_json'
      )
    END,
    CASE
      WHEN json_valid(data) THEN json('{}')
      ELSE json_object('migrationError', 'invalid_legacy_json')
    END,
    created_at
FROM submissions
;

DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;

CREATE INDEX idx_submissions_form_created
ON submissions(form_id, created_at DESC, id DESC);

CREATE INDEX idx_submissions_request_id
ON submissions(request_id);

CREATE INDEX idx_submissions_status
ON submissions(form_id, status, created_at DESC);

CREATE INDEX idx_submissions_ip_hash
ON submissions(form_id, source_ip_hash);

CREATE INDEX idx_submissions_retention
ON submissions(delete_after)
WHERE delete_after IS NOT NULL;

CREATE INDEX idx_submissions_ip_retention
ON submissions(ip_delete_after)
WHERE ip_delete_after IS NOT NULL;

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

CREATE TABLE form_webhooks (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    secret_id TEXT NOT NULL,
    event_types TEXT NOT NULL DEFAULT '["submission.created"]'
        CHECK (json_valid(event_types)),
    timeout_ms INTEGER NOT NULL DEFAULT 10000,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
    FOREIGN KEY (secret_id) REFERENCES form_secrets(id)
);

CREATE INDEX form_webhooks_form_idx
ON form_webhooks(form_id, enabled);

CREATE TABLE delivery_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('notification_email', 'webhook', 'export')),
    form_id TEXT NOT NULL,
    submission_id TEXT,
    target_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'published', 'processing', 'retry', 'completed', 'failed')),
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

CREATE TABLE delivery_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    response_status INTEGER,
    error TEXT,
    FOREIGN KEY (job_id) REFERENCES delivery_jobs(id) ON DELETE CASCADE
);

CREATE INDEX delivery_attempts_job_idx
ON delivery_attempts(job_id, attempt_number DESC);

CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'completed', 'attached', 'expired')),
    origin TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

CREATE INDEX upload_sessions_expiry_idx
ON upload_sessions(status, expires_at);

CREATE TABLE submission_files (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    submission_id TEXT,
    upload_session_id TEXT,
    field_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    checksum TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('temporary', 'completed', 'attached', 'pending_delete', 'deleted', 'failed')),
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

CREATE TABLE upload_file_claims (
    file_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES submission_files(id) ON DELETE CASCADE,
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);

CREATE TABLE export_jobs (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
    object_key TEXT,
    row_count INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    expires_at INTEGER,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

CREATE INDEX export_jobs_form_idx
ON export_jobs(form_id, created_at DESC);

ALTER TABLE settings ADD COLUMN smtp_from_address TEXT;
ALTER TABLE settings ADD COLUMN smtp_from_name TEXT;
ALTER TABLE settings ADD COLUMN smtp_secret_id TEXT;
