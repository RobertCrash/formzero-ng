import { decryptSecret } from "./decrypt.server"
import { encryptSecret } from "./encrypt.server"

export async function putSecret({
  db,
  encryptionKey,
  formId,
  purpose,
  value,
  secretId = crypto.randomUUID(),
}: {
  db: D1Database
  encryptionKey: string
  formId: string | null
  purpose: string
  value: string
  secretId?: string
}) {
  const existing = await db
    .prepare(`
      SELECT form_id, purpose
      FROM form_secrets
      WHERE id = ?
    `)
    .bind(secretId)
    .first<{ form_id: string | null; purpose: string }>()
  if (
    existing &&
    (existing.form_id !== formId || existing.purpose !== purpose)
  ) {
    throw new Error("Secret ownership or purpose does not match.")
  }

  const encryptedValue = await encryptSecret(value, encryptionKey)
  const now = Date.now()

  await db
    .prepare(`
      INSERT INTO form_secrets (
        id, form_id, purpose, encrypted_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        updated_at = excluded.updated_at
    `)
    .bind(secretId, formId, purpose, encryptedValue, now, now)
    .run()

  return secretId
}

export async function getSecret({
  db,
  encryptionKey,
  secretId,
}: {
  db: D1Database
  encryptionKey: string
  secretId: string
}) {
  const row = await db
    .prepare("SELECT encrypted_value FROM form_secrets WHERE id = ?")
    .bind(secretId)
    .first<{ encrypted_value: string }>()
  if (!row) return null
  return decryptSecret(row.encrypted_value, encryptionKey)
}

export async function deleteSecret(db: D1Database, secretId: string) {
  await db.prepare("DELETE FROM form_secrets WHERE id = ?").bind(secretId).run()
}
