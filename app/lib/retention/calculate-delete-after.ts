const DAY_MS = 86_400_000

export function calculateDeleteAfter(
  createdAt: number,
  retentionDays: number | null
) {
  return retentionDays === null ? null : createdAt + retentionDays * DAY_MS
}
