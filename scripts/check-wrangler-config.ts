/**
 * Asserts that wrangler.jsonc declares exactly the binding names the Worker
 * reads, and that no account-specific database_id is committed.
 *
 * Binding names are a contract: a renamed binding leaves `env.<NAME>`
 * undefined at runtime, which is a silent outage rather than a build failure.
 */
import { readFileSync } from "node:fs"
import { parse, type ParseError } from "jsonc-parser"

type WranglerConfig = {
  d1_databases?: Array<{ binding?: string; database_id?: string }>
  r2_buckets?: Array<{ binding?: string }>
  queues?: {
    producers?: Array<{ binding?: string }>
    consumers?: Array<{ queue?: string; dead_letter_queue?: string }>
  }
  ratelimits?: Array<{ name?: string }>
  send_email?: Array<{ name?: string }>
}

const configPath = new URL("../wrangler.jsonc", import.meta.url)
const errors: ParseError[] = []
const config = parse(
  readFileSync(configPath, "utf8"),
  errors
) as WranglerConfig
if (errors.length > 0) {
  console.error("wrangler.jsonc is not parseable:", errors)
  process.exit(1)
}

const failures: string[] = []

function expectBindings(label: string, expected: string[], actual: string[]) {
  const missing = expected.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  if (missing.length > 0) {
    failures.push(`${label}: missing binding ${missing.join(", ")}`)
  }
  if (unexpected.length > 0) {
    failures.push(`${label}: unexpected binding ${unexpected.join(", ")}`)
  }
}

expectBindings(
  "d1_databases",
  ["DB"],
  (config.d1_databases ?? []).map((entry) => entry.binding ?? "")
)
expectBindings(
  "r2_buckets",
  ["UPLOADS"],
  (config.r2_buckets ?? []).map((entry) => entry.binding ?? "")
)
// Only the producer carries a binding; the consumer entry deliberately has none.
expectBindings(
  "queues.producers",
  ["DELIVERY_QUEUE"],
  (config.queues?.producers ?? []).map((entry) => entry.binding ?? "")
)
expectBindings(
  "ratelimits",
  ["RATE_LIMIT_STRICT", "RATE_LIMIT_STANDARD", "RATE_LIMIT_RELAXED"],
  (config.ratelimits ?? []).map((entry) => entry.name ?? "")
)
expectBindings(
  "send_email",
  ["EMAIL"],
  (config.send_email ?? []).map((entry) => entry.name ?? "")
)

// A dead-letter queue without a consumer swallows failed deliveries: messages
// accumulate there and expire unread, so nothing records the give-up.
const consumers = config.queues?.consumers ?? []
const consumedQueues = consumers.map((entry) => entry.queue ?? "")
for (const entry of consumers) {
  if (entry.dead_letter_queue && !consumedQueues.includes(entry.dead_letter_queue)) {
    failures.push(
      `queues.consumers: ${entry.dead_letter_queue} is used as a dead-letter ` +
        "queue but has no consumer of its own"
    )
  }
}

for (const database of config.d1_databases ?? []) {
  if (database.database_id) {
    failures.push(
      "d1_databases: database_id must not be committed. Wrangler links the " +
        "provisioned database by name, and a committed ID points forks at " +
        "someone else's account."
    )
  }
}

for (const entry of config.send_email ?? []) {
  const withRemote = entry as { remote?: boolean }
  if (withRemote.remote) {
    failures.push(
      'send_email: "remote": true must not be committed. It routes local ' +
        "wrangler dev sends through the real Email Service."
    )
  }
}

if (failures.length > 0) {
  console.error("wrangler.jsonc failed its binding contract:")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log("wrangler.jsonc binding contract OK")
