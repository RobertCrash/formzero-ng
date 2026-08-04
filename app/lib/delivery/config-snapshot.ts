import type { FieldRule, FormPolicyV1, FormWithPolicy } from "../form-config/types"

/**
 * The delivery configuration a queued notification was created under.
 *
 * A submission is delivered asynchronously and retried for up to a couple of
 * hours, so reading the live policy at send time meant an edit to the recipient
 * list or the subject template silently rewrote deliveries that had already been
 * accepted under the previous configuration. Only the parts email rendering
 * actually consumes are stored, to keep the row small.
 */
export type DeliverySnapshot = {
  version: 1
  formName: string
  configRevision: number
  notifications: FormPolicyV1["notifications"]
  fields: FieldRule[]
}

export function buildDeliverySnapshot(form: FormWithPolicy): DeliverySnapshot {
  return {
    version: 1,
    formName: form.name,
    configRevision: form.configRevision,
    notifications: form.policy.notifications,
    fields: form.policy.fields,
  }
}

/**
 * Returns null for rows written before the column existed, or for a snapshot
 * this version cannot read, so the caller falls back to the live policy rather
 * than dropping the delivery.
 */
export function parseDeliverySnapshot(value: string | null): DeliverySnapshot | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as DeliverySnapshot
    if (parsed.version !== 1 || !parsed.notifications) return null
    return parsed
  } catch {
    return null
  }
}
