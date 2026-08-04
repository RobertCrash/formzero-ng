export type MaintenanceCategory =
  | "delivery_locks"
  | "delivery_publish"
  | "ip_redaction"
  | "expired_files"
  | "orphaned_objects"
  | "pending_deletes"
  | "expired_submissions"
  | "expired_exports"
  | "deleted_forms"

export type MaintenanceStateRow = {
  category: MaintenanceCategory
  cursor: string | null
  backlog: number
  processed: number
  last_run_at: number | null
  last_error: string | null
}

export async function loadMaintenanceState(db: D1Database) {
  const rows = await db
    .prepare(`
      SELECT category, cursor, backlog, processed, last_run_at, last_error
      FROM maintenance_state
    `)
    .all<MaintenanceStateRow>()
  return new Map(rows.results.map((row) => [row.category, row]))
}

export async function saveMaintenanceState(
  db: D1Database,
  category: MaintenanceCategory,
  state: {
    cursor?: string | null
    backlog: number
    processed: number
    lastError: string | null
    now: number
  }
) {
  await db
    .prepare(`
      INSERT INTO maintenance_state (
        category, cursor, backlog, processed, last_run_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (category) DO UPDATE SET
        cursor = excluded.cursor,
        backlog = excluded.backlog,
        processed = excluded.processed,
        last_run_at = excluded.last_run_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `)
    .bind(
      category,
      state.cursor ?? null,
      state.backlog,
      state.processed,
      state.now,
      state.lastError,
      state.now
    )
    .run()
}
