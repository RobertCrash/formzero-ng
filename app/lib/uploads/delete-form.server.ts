/**
 * Form deletion in two halves: a tombstone written during the request, and a
 * batched purge driven by scheduled maintenance.
 *
 * The purge is the only thing that needs to be incremental, because everything
 * except the R2 objects disappears through `ON DELETE CASCADE` the moment the
 * `forms` row goes. Object keys are read in pages and handed to R2 in bulk, so
 * the cost is one R2 call and one D1 statement per page rather than two per file.
 */

/** R2 accepts up to 1000 keys per delete; a smaller page bounds the retry cost. */
const FILE_PAGE_SIZE = 200

export type FormDeletionRequest =
  | { found: false }
  | { found: true; alreadyRequested: boolean; deletedAt: number }

export async function requestFormDeletion({
  db,
  formId,
  now = Date.now(),
}: {
  db: D1Database
  formId: string
  now?: number
}): Promise<FormDeletionRequest> {
  const form = await db
    .prepare("SELECT id, deleted_at FROM forms WHERE id = ?")
    .bind(formId)
    .first<{ id: string; deleted_at: number | null }>()
  if (!form) return { found: false }
  if (form.deleted_at !== null) {
    return { found: true, alreadyRequested: true, deletedAt: form.deleted_at }
  }

  await db.batch([
    db
      .prepare(`
        UPDATE forms
        SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `)
      .bind(now, now, formId),
    // Files are marked without a delete_after so the expiry sweep leaves them
    // alone: the purge below owns them, and two sweeps racing over the same keys
    // would leave rows marked 'failed' for objects that were deleted fine.
    db
      .prepare(`
        UPDATE submission_files
        SET status = 'pending_delete'
        WHERE form_id = ? AND status <> 'deleted'
      `)
      .bind(formId),
    // Otherwise the queue keeps delivering notifications and webhooks for a form
    // the operator has already deleted.
    db
      .prepare(`
        UPDATE delivery_jobs
        SET status = 'failed', last_error = 'Form deleted', updated_at = ?
        WHERE form_id = ?
          AND status IN ('pending', 'published', 'processing', 'retry')
      `)
      .bind(now, formId),
  ])

  return { found: true, alreadyRequested: false, deletedAt: now }
}

export async function countFormsPendingDeletion(db: D1Database) {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM forms WHERE deleted_at IS NOT NULL")
    .first<{ total: number }>()
  return row?.total ?? 0
}

async function purgeObjects({
  db,
  bucket,
  table,
  formId,
  deadline,
}: {
  db: D1Database
  bucket: R2Bucket
  table: "submission_files" | "export_jobs"
  formId: string
  deadline: number
}) {
  let removed = 0

  while (Date.now() < deadline) {
    const page = await db
      .prepare(`
        SELECT id, object_key
        FROM ${table}
        WHERE form_id = ? AND object_key IS NOT NULL
        LIMIT ?
      `)
      .bind(formId, FILE_PAGE_SIZE)
      .all<{ id: string; object_key: string }>()
    if (page.results.length === 0) break

    await bucket.delete(page.results.map((row) => row.object_key))
    const placeholders = page.results.map(() => "?").join(", ")
    await db
      .prepare(`
        UPDATE ${table}
        SET object_key = NULL
        WHERE id IN (${placeholders})
      `)
      .bind(...page.results.map((row) => row.id))
      .run()
    removed += page.results.length
  }

  return removed
}

/**
 * Removes the stored objects of tombstoned forms, dropping each form row once
 * its bucket contents are gone.
 */
export async function purgeDeletedForms({
  db,
  bucket,
  deadline = Date.now() + 10_000,
  limit = 5,
}: {
  db: D1Database
  bucket: R2Bucket
  deadline?: number
  limit?: number
}) {
  const forms = await db
    .prepare(`
      SELECT id
      FROM forms
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at
      LIMIT ?
    `)
    .bind(limit)
    .all<{ id: string }>()

  let objectsRemoved = 0
  let formsRemoved = 0

  for (const form of forms.results) {
    if (Date.now() >= deadline) break

    objectsRemoved += await purgeObjects({
      db,
      bucket,
      table: "submission_files",
      formId: form.id,
      deadline,
    })
    objectsRemoved += await purgeObjects({
      db,
      bucket,
      table: "export_jobs",
      formId: form.id,
      deadline,
    })

    const remaining = await db
      .prepare(`
        SELECT COUNT(*) AS total
        FROM submission_files
        WHERE form_id = ? AND object_key IS NOT NULL
      `)
      .bind(form.id)
      .first<{ total: number }>()
    // Anything left means the deadline cut the page short; the next run resumes.
    if ((remaining?.total ?? 0) > 0) continue

    // Submissions, files, delivery jobs, webhooks, secrets, upload sessions,
    // settings and exports all cascade from this one statement.
    await db.prepare("DELETE FROM forms WHERE id = ?").bind(form.id).run()
    formsRemoved++
  }

  return {
    objectsRemoved,
    formsRemoved,
    backlog: await countFormsPendingDeletion(db),
  }
}
