export async function deleteSubmissionWithFiles({
  db,
  bucket,
  formId,
  submissionId,
}: {
  db: D1Database
  bucket?: R2Bucket
  formId: string
  submissionId: string
}) {
  const submission = await db
    .prepare(`
      SELECT id
      FROM submissions
      WHERE id = ? AND form_id = ?
    `)
    .bind(submissionId, formId)
    .first()
  if (!submission) return { found: false, deleted: false }

  const now = Date.now()
  await db.batch([
    db
      .prepare(`
        UPDATE submissions
        SET status = 'pending_delete'
        WHERE id = ? AND form_id = ?
      `)
      .bind(submissionId, formId),
    db
      .prepare(`
        UPDATE submission_files
        SET status = 'pending_delete', delete_after = ?
        WHERE submission_id = ?
      `)
      .bind(now, submissionId),
  ])

  const files = await db
    .prepare(`
      SELECT id, object_key
      FROM submission_files
      WHERE submission_id = ?
    `)
    .bind(submissionId)
    .all<{ id: string; object_key: string }>()
  if (files.results.length > 0 && !bucket) {
    return { found: true, deleted: false }
  }

  for (const file of files.results) {
    try {
      await bucket!.delete(file.object_key)
      await db
        .prepare("UPDATE submission_files SET status = 'deleted' WHERE id = ?")
        .bind(file.id)
        .run()
    } catch (error) {
      console.error("Failed to delete R2 object:", file.object_key, error)
      return { found: true, deleted: false }
    }
  }

  await db.batch([
    db
      .prepare("DELETE FROM delivery_jobs WHERE submission_id = ?")
      .bind(submissionId),
    db
      .prepare("DELETE FROM submission_files WHERE submission_id = ?")
      .bind(submissionId),
    db
      .prepare("DELETE FROM submissions WHERE id = ? AND form_id = ?")
      .bind(submissionId, formId),
  ])
  return { found: true, deleted: true }
}

export async function deleteFormWithFiles({
  db,
  bucket,
  formId,
}: {
  db: D1Database
  bucket?: R2Bucket
  formId: string
}) {
  const submissions = await db
    .prepare("SELECT id FROM submissions WHERE form_id = ?")
    .bind(formId)
    .all<{ id: string }>()
  for (const submission of submissions.results) {
    const result = await deleteSubmissionWithFiles({
      db,
      bucket,
      formId,
      submissionId: submission.id,
    })
    if (!result.deleted) return { deleted: false }
  }
  const remainingFiles = await db
    .prepare(`
      SELECT id, object_key
      FROM submission_files
      WHERE form_id = ?
    `)
    .bind(formId)
    .all<{ id: string; object_key: string }>()
  if (remainingFiles.results.length > 0 && !bucket) {
    return { deleted: false }
  }
  for (const file of remainingFiles.results) {
    try {
      await bucket!.delete(file.object_key)
      await db
        .prepare("DELETE FROM submission_files WHERE id = ?")
        .bind(file.id)
        .run()
    } catch (error) {
      console.error("Failed to delete unattached R2 object:", file.object_key, error)
      return { deleted: false }
    }
  }
  const result = await db
    .prepare("DELETE FROM forms WHERE id = ?")
    .bind(formId)
    .run()
  return { deleted: result.meta.changes > 0 }
}
