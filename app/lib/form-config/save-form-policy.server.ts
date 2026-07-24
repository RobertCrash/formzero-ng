import { FormPolicyV1Schema } from "./schema"
import type { FormPolicyV1 } from "./types"

export class FormPolicyConflictError extends Error {
  constructor() {
    super("The form configuration was changed by another session.")
    this.name = "FormPolicyConflictError"
  }
}

export async function saveFormPolicy({
  db,
  formId,
  expectedRevision,
  policy,
}: {
  db: D1Database
  formId: string
  expectedRevision: number
  policy: FormPolicyV1
}) {
  const validated = FormPolicyV1Schema.parse(policy)
  const now = Date.now()
  const result = await db
    .prepare(`
      UPDATE forms
      SET
        config_json = json(?),
        config_schema_version = ?,
        config_revision = config_revision + 1,
        updated_at = ?
      WHERE id = ?
        AND config_revision = ?
    `)
    .bind(
      JSON.stringify(validated),
      validated.schemaVersion,
      now,
      formId,
      expectedRevision
    )
    .run()

  if (result.meta.changes === 0) {
    throw new FormPolicyConflictError()
  }

  return { policy: validated, revision: expectedRevision + 1 }
}
