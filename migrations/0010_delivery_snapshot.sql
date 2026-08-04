-- Migration 0010: snapshot the delivery configuration on the job row.
--
-- Email delivery read the form's current policy at processing time, so editing
-- recipients or the subject template changed where already-queued submissions
-- were sent — including retries of deliveries that had failed hours earlier.
-- Existing rows keep a NULL snapshot and fall back to the live policy.

ALTER TABLE delivery_jobs ADD COLUMN config_snapshot TEXT;
