import { createLegacyFormPolicy } from "./defaults"
import { migrateFormPolicy } from "./migrate-config"
import type { FormWithPolicy } from "./types"

type FormPolicyRow = {
  id: string
  name: string
  config_json: string
  config_schema_version: number
  config_revision: number
}

export async function loadFormWithPolicy(
  db: D1Database,
  formId: string
): Promise<FormWithPolicy | null> {
  const row = await db
    .prepare(`
      SELECT
        id,
        name,
        config_json,
        config_schema_version,
        config_revision
      FROM forms
      WHERE id = ? AND deleted_at IS NULL
    `)
    .bind(formId)
    .first<FormPolicyRow>()

  if (!row) return null

  let rawPolicy: unknown
  try {
    rawPolicy =
      row.config_json === "{}" ? createLegacyFormPolicy() : JSON.parse(row.config_json)
  } catch {
    throw new Error(`Form ${formId} has malformed policy JSON`)
  }

  return {
    id: row.id,
    name: row.name,
    configSchemaVersion: row.config_schema_version,
    configRevision: row.config_revision,
    policy: migrateFormPolicy(rawPolicy, row.config_schema_version),
  }
}
