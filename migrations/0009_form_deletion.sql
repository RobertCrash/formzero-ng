-- Migration 0009: tombstone forms instead of deleting them inline.
--
-- Deleting a form used to walk every submission and every file one request at a
-- time, so a form with a few thousand attachments could not finish inside a
-- request's CPU budget: the response reported "pending" and the next attempt
-- started the same walk again. A form is now tombstoned in a single write, and
-- the scheduled purge removes the R2 objects in batches before dropping the row,
-- at which point every child table cascades.

ALTER TABLE forms ADD COLUMN deleted_at INTEGER;

-- Partial: only tombstoned forms are ever scanned through this index, so it
-- stays small no matter how many live forms exist.
CREATE INDEX forms_deleted_idx ON forms(deleted_at) WHERE deleted_at IS NOT NULL;
