-- Migration 0012: allow nulling submission_files.object_key during form purge.
--
-- Purge deletes R2 objects then cleared the key with `SET object_key = NULL`,
-- but the column was NOT NULL. That left objects gone while database cleanup
-- could never finish. Export jobs already used a nullable object_key.

PRAGMA foreign_keys = OFF;

CREATE TABLE submission_files_new (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    submission_id TEXT,
    upload_session_id TEXT,
    field_name TEXT NOT NULL,
    object_key TEXT UNIQUE,
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

INSERT INTO submission_files_new (
    id, form_id, submission_id, upload_session_id, field_name, object_key,
    original_name, mime_type, size_bytes, checksum, status, created_at, delete_after
)
SELECT
    id, form_id, submission_id, upload_session_id, field_name, object_key,
    original_name, mime_type, size_bytes, checksum, status, created_at, delete_after
FROM submission_files;

DROP TABLE submission_files;
ALTER TABLE submission_files_new RENAME TO submission_files;

CREATE INDEX submission_files_submission_idx
ON submission_files(submission_id);

CREATE INDEX submission_files_expiry_idx
ON submission_files(status, delete_after);

PRAGMA foreign_keys = ON;
