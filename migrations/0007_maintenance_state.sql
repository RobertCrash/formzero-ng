-- Migration number: 0007
-- Let scheduled maintenance resume where the previous run stopped.
--
-- Every category used to run to a fixed 100-row cap with no record of whether
-- anything was left over, so a backlog larger than the cap could never be
-- worked down and nothing reported that it existed. One row per category holds
-- the continuation point, the measured backlog, and the last failure — which is
-- also what makes per-category isolation observable rather than silent.

CREATE TABLE maintenance_state (
    category TEXT PRIMARY KEY,
    -- Opaque continuation point, currently an R2 list cursor. NULL restarts.
    cursor TEXT,
    -- Items still outstanding after the last run, for alerting on growth.
    backlog INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
);
