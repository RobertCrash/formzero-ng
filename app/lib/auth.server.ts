import { betterAuth } from "better-auth"
import { D1Dialect } from 'kysely-d1';

export function getAuth({ database }: { database: D1Database }) {
    return betterAuth({
        database: {
           type: "sqlite",
           dialect: new D1Dialect({ database }), 
        },
        emailAndPassword: {
            enabled: true
        }
    })
}

export async function getUserCount({ database }: { database: D1Database }): Promise<number> {
    const result = await database
        .prepare('SELECT COUNT(*) as count FROM "user"')
        .first<{ count: number }>();

    if (!result) {
        throw new Error("Failed to retrieve user count");
    }

    return result.count;
}

/**
 * Reserves the sole administrator slot, or reports that it is already taken.
 *
 * Counting users and then signing up is two statements, so two simultaneous
 * registrations both read zero and both succeed. `instance_owner` has a single
 * possible primary key, so exactly one INSERT can win however the requests
 * interleave.
 */
export async function claimInstanceOwner({
    database,
    email,
}: {
    database: D1Database
    email: string | null
}): Promise<boolean> {
    try {
        const result = await database
            .prepare(`
                INSERT INTO instance_owner (id, email, claimed_at)
                VALUES ('owner', ?, ?)
                ON CONFLICT (id) DO NOTHING
            `)
            .bind(email, Date.now())
            .run();
        return result.meta.changes === 1;
    } catch {
        // A driver that surfaces the conflict as an error rather than zero rows
        // still means the same thing: someone else holds the slot.
        return false;
    }
}

/** Releases the slot when the sign-up it was reserved for did not complete. */
export async function releaseInstanceOwnerClaim({
    database,
}: {
    database: D1Database
}) {
    await database
        .prepare(`
            DELETE FROM instance_owner
            WHERE id = 'owner'
              AND NOT EXISTS (SELECT 1 FROM "user")
        `)
        .run();
}
