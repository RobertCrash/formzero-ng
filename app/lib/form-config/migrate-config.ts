import { FormPolicyV1Schema } from "./schema"
import type { FormPolicyV1 } from "./types"

export function migrateFormPolicy(
  value: unknown,
  schemaVersion: number
): FormPolicyV1 {
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported form policy schema version: ${schemaVersion}`)
  }

  return FormPolicyV1Schema.parse(value)
}
