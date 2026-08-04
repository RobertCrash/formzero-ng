-- Migration number: 0008
-- Make "this instance has exactly one administrator" a database invariant.
--
-- Registration used to count users and then sign up, so two requests arriving
-- together both saw zero and both succeeded. A single-row table whose primary
-- key is a constant turns the second attempt into a constraint violation
-- instead, which no amount of interleaving can get past.

CREATE TABLE instance_owner (
    id TEXT PRIMARY KEY CHECK (id = 'owner'),
    email TEXT,
    claimed_at INTEGER NOT NULL
);

-- An instance that already has an administrator is already claimed; recording
-- that keeps the invariant true for existing deployments rather than only new
-- ones.
INSERT INTO instance_owner (id, email, claimed_at)
SELECT
    'owner',
    (SELECT "email" FROM "user" ORDER BY "createdAt" LIMIT 1),
    unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM "user");
