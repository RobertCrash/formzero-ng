import { countDeadLetteredDeliveries } from "../delivery/dead-letters.server"
import { publishPendingDeliveryJobs } from "../delivery/publish-jobs.server"
import {
  cleanupExpiredUploads,
  cleanupOrphanedTemporaryObjects,
  countExpiredUploads,
} from "../uploads/cleanup-files.server"
import { purgeDeletedForms } from "../uploads/delete-form.server"
import { deleteSubmissionWithFiles } from "../uploads/delete-submission.server"
import {
  countExpiredSubmissions,
  deleteExpiredSubmissions,
  redactExpiredIps,
} from "./cleanup-expired.server"
import {
  loadMaintenanceState,
  saveMaintenanceState,
  type MaintenanceCategory,
} from "./maintenance-state.server"

type MaintenanceEnv = {
  DB: D1Database
  UPLOADS: R2Bucket
  DELIVERY_QUEUE: Queue<{ jobId: string }>
}

/**
 * Cron invocations get 30 seconds of CPU. Stopping at 20 leaves room for the
 * state writes and for the run to end cleanly rather than being cut off.
 */
const DEFAULT_BUDGET_MS = 20_000

/** Per-category work cap, so no single category can consume the whole budget. */
const BATCH_LIMIT = 100

const LOCK_TIMEOUT_MS = 15 * 60 * 1_000

type CategoryOutcome = {
  processed: number
  /** Items still outstanding, for detecting a backlog that never drains. */
  backlog: number
  /** Continuation point to resume from, when the category has one. */
  cursor?: string | null
}

type CategoryContext = {
  env: MaintenanceEnv
  now: number
  deadline: number
  cursor: string | null
}

type Category = {
  name: MaintenanceCategory
  run: (context: CategoryContext) => Promise<CategoryOutcome>
}

const categories: Category[] = [
  {
    // Jobs whose worker died mid-flight stay 'processing' forever otherwise, so
    // this runs first: it is cheap and it feeds the publish step below.
    name: "delivery_locks",
    async run({ env, now }) {
      const result = await env.DB
        .prepare(`
          UPDATE delivery_jobs
          SET
            status = 'retry',
            available_at = ?,
            locked_at = NULL,
            last_error = 'Processing lock expired',
            updated_at = ?
          WHERE status = 'processing'
            AND locked_at < ?
        `)
        .bind(now, now, now - LOCK_TIMEOUT_MS)
        .run()
      return { processed: result.meta.changes, backlog: 0 }
    },
  },
  {
    name: "delivery_publish",
    async run({ env }) {
      const published = await publishPendingDeliveryJobs({
        db: env.DB,
        queue: env.DELIVERY_QUEUE,
      })
      const row = await env.DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM delivery_jobs
          WHERE status IN ('pending', 'retry')
        `)
        .first<{ total: number }>()
      return { processed: published, backlog: row?.total ?? 0 }
    },
  },
  {
    name: "ip_redaction",
    async run({ env, now }) {
      // A single UPDATE, so there is nothing left over to page through.
      return { processed: await redactExpiredIps(env.DB, now), backlog: 0 }
    },
  },
  {
    // Ahead of the per-row categories: a tombstoned form is cleared in pages of
    // object keys, so the same budget removes far more data here.
    name: "deleted_forms",
    async run({ env, deadline }) {
      const result = await purgeDeletedForms({
        db: env.DB,
        bucket: env.UPLOADS,
        deadline,
      })
      return { processed: result.formsRemoved, backlog: result.backlog }
    },
  },
  {
    name: "expired_files",
    async run({ env, now }) {
      const processed = await cleanupExpiredUploads({
        db: env.DB,
        bucket: env.UPLOADS,
        now,
        limit: BATCH_LIMIT,
      })
      return { processed, backlog: await countExpiredUploads(env.DB, now) }
    },
  },
  {
    name: "orphaned_objects",
    async run({ env, deadline, cursor }) {
      const result = await cleanupOrphanedTemporaryObjects({
        bucket: env.UPLOADS,
        cursor,
        deadline,
      })
      return {
        processed: result.deleted,
        // R2 list gives no total, so an unfinished sweep is the only signal.
        backlog: result.truncated ? 1 : 0,
        cursor: result.cursor,
      }
    },
  },
  {
    name: "pending_deletes",
    async run({ env, deadline }) {
      const pending = await env.DB
        .prepare(`
          SELECT id, form_id
          FROM submissions
          WHERE status = 'pending_delete'
          LIMIT ?
        `)
        .bind(BATCH_LIMIT)
        .all<{ id: string; form_id: string }>()
      let processed = 0
      for (const submission of pending.results) {
        if (Date.now() >= deadline) break
        await deleteSubmissionWithFiles({
          db: env.DB,
          bucket: env.UPLOADS,
          formId: submission.form_id,
          submissionId: submission.id,
        })
        processed++
      }
      const row = await env.DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM submissions
          WHERE status = 'pending_delete'
        `)
        .first<{ total: number }>()
      return { processed, backlog: row?.total ?? 0 }
    },
  },
  {
    name: "expired_submissions",
    async run({ env, now, deadline }) {
      const processed = await deleteExpiredSubmissions(env.DB, env.UPLOADS, now, {
        limit: BATCH_LIMIT,
        deadline,
      })
      return { processed, backlog: await countExpiredSubmissions(env.DB, now) }
    },
  },
  {
    name: "expired_exports",
    async run({ env, now, deadline }) {
      const exports = await env.DB
        .prepare(`
          SELECT id, object_key
          FROM export_jobs
          WHERE expires_at IS NOT NULL
            AND expires_at <= ?
            AND object_key IS NOT NULL
          LIMIT ?
        `)
        .bind(now, BATCH_LIMIT)
        .all<{ id: string; object_key: string }>()
      let processed = 0
      for (const job of exports.results) {
        if (Date.now() >= deadline) break
        try {
          await env.UPLOADS.delete(job.object_key)
          await env.DB
            .prepare(`
              UPDATE export_jobs
              SET status = 'expired', object_key = NULL
              WHERE id = ?
            `)
            .bind(job.id)
            .run()
          processed++
        } catch (error) {
          // One unreachable object must not strand the rest of the page.
          console.error("Failed to remove expired export:", job.id, error)
        }
      }
      const row = await env.DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM export_jobs
          WHERE expires_at IS NOT NULL
            AND expires_at <= ?
            AND object_key IS NOT NULL
        `)
        .bind(now)
        .first<{ total: number }>()
      return { processed, backlog: row?.total ?? 0 }
    },
  },
]

export type MaintenanceReport = {
  ranFor: number
  /** Deliveries the queue gave up on, awaiting a manual retry. */
  deadLetters: number
  categories: Array<{
    name: MaintenanceCategory
    status: "completed" | "skipped" | "failed"
    processed: number
    backlog: number
    error?: string
  }>
}

/**
 * Runs every retention category under one time budget, isolating failures.
 *
 * Previously all categories ran sequentially with no try/catch, so a single R2
 * or D1 error skipped everything after it — and because each was capped at 100
 * rows with no record of the remainder, a backlog larger than the cap could
 * never be worked down and nothing reported that it existed.
 */
export async function runScheduledMaintenance(
  env: MaintenanceEnv,
  options: { now?: number; budgetMs?: number } = {}
): Promise<MaintenanceReport> {
  const startedAt = Date.now()
  const now = options.now ?? startedAt
  const deadline = startedAt + (options.budgetMs ?? DEFAULT_BUDGET_MS)
  const state = await loadMaintenanceState(env.DB)
  const report: MaintenanceReport["categories"] = []

  for (const category of categories) {
    if (Date.now() >= deadline) {
      // Left for the next run rather than started and cut off mid-write.
      report.push({
        name: category.name,
        status: "skipped",
        processed: 0,
        backlog: state.get(category.name)?.backlog ?? 0,
      })
      continue
    }

    try {
      const outcome = await category.run({
        env,
        now,
        deadline,
        cursor: state.get(category.name)?.cursor ?? null,
      })
      report.push({ name: category.name, status: "completed", ...outcome })
      await saveMaintenanceState(env.DB, category.name, {
        cursor: outcome.cursor,
        backlog: outcome.backlog,
        processed: outcome.processed,
        lastError: null,
        now,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Maintenance category ${category.name} failed:`, error)
      report.push({
        name: category.name,
        status: "failed",
        processed: 0,
        backlog: state.get(category.name)?.backlog ?? 0,
        error: message,
      })
      try {
        await saveMaintenanceState(env.DB, category.name, {
          cursor: state.get(category.name)?.cursor ?? null,
          backlog: state.get(category.name)?.backlog ?? 0,
          processed: 0,
          lastError: message,
          now,
        })
      } catch (stateError) {
        console.error("Failed to record maintenance failure:", stateError)
      }
    }
  }

  // Reported rather than repaired: a dead letter needs a human to fix the cause
  // and replay it, so the cron's job is to make sure nobody has to go looking.
  const deadLetters = await countDeadLetteredDeliveries(env.DB)
  if (deadLetters > 0) {
    console.error(
      "Deliveries awaiting manual retry:",
      JSON.stringify({ deadLetters })
    )
  }

  const result: MaintenanceReport = {
    ranFor: Date.now() - startedAt,
    deadLetters,
    categories: report,
  }

  // One structured line per run, so a growing backlog is visible in Workers
  // Logs without querying the database.
  const outstanding = report.filter((entry) => entry.backlog > 0)
  if (outstanding.length > 0 || report.some((entry) => entry.status === "failed")) {
    console.error("Maintenance run incomplete:", JSON.stringify(result))
  } else {
    console.log("Maintenance run complete:", JSON.stringify(result))
  }

  return result
}
