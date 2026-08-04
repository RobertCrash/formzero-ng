-- Migration 0011: record dead-lettered deliveries.
--
-- formzero-deliveries-dlq was configured but had no consumer, so a delivery that
-- exhausted its retries left the queue silently: the job row stayed in whatever
-- state its last attempt wrote, and nothing distinguished "failed once" from
-- "given up on". The DLQ consumer now stamps this column, which drives the
-- dashboard badge and the backlog line in the maintenance log.

ALTER TABLE delivery_jobs ADD COLUMN dead_lettered_at INTEGER;
