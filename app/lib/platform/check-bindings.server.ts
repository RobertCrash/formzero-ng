/**
 * Runtime self-check for the resource bindings declared in wrangler.jsonc.
 *
 * Binding names are a contract. A renamed or wrongly typed binding leaves
 * `env.<NAME>` undefined or unusable, which used to read as "the operator did
 * not configure this feature" — a configuration typo indistinguishable from a
 * deliberate omission. Probing the method surface rather than truthiness also
 * catches a name bound to the wrong kind of resource.
 */

export type BindingCheck = {
  binding: string
  /** The wrangler.jsonc key that declares this binding. */
  configKey: string
  feature: string
  present: boolean
  usable: boolean
}

export type PlatformReport = {
  ok: boolean
  checks: BindingCheck[]
  problems: BindingCheck[]
}

type ProbeTarget = Record<string, unknown> | undefined | null

function probe(value: unknown, method: string) {
  const target = value as ProbeTarget
  const present = Boolean(target)
  return {
    present,
    usable: present && typeof target?.[method] === "function",
  }
}

const expected = [
  { binding: "DB", configKey: "d1_databases", feature: "Core storage", method: "prepare" },
  { binding: "UPLOADS", configKey: "r2_buckets", feature: "File uploads and exports", method: "get" },
  { binding: "DELIVERY_QUEUE", configKey: "queues.producers", feature: "Background delivery", method: "send" },
  { binding: "EMAIL", configKey: "send_email", feature: "Cloudflare email transport", method: "send" },
  { binding: "RATE_LIMIT_STRICT", configKey: "ratelimits", feature: "Rate limiting (strict)", method: "limit" },
  { binding: "RATE_LIMIT_STANDARD", configKey: "ratelimits", feature: "Rate limiting (standard)", method: "limit" },
  { binding: "RATE_LIMIT_RELAXED", configKey: "ratelimits", feature: "Rate limiting (relaxed)", method: "limit" },
] as const

export type ExpectedBinding = (typeof expected)[number]["binding"]

export function checkPlatformBindings(env: unknown): PlatformReport {
  const source = (env ?? {}) as Record<string, unknown>
  const checks = expected.map((entry) => ({
    binding: entry.binding,
    configKey: entry.configKey,
    feature: entry.feature,
    ...probe(source[entry.binding], entry.method),
  }))
  const problems = checks.filter((check) => !check.usable)
  return { ok: problems.length === 0, checks, problems }
}

/**
 * Thrown from a feature path when its binding is absent or the wrong type, so
 * the message names the configuration to fix instead of reporting a generic
 * unavailable capability.
 */
export class MisconfiguredBindingError extends Error {
  readonly binding: string
  readonly configKey: string

  constructor(binding: ExpectedBinding) {
    const entry = expected.find((candidate) => candidate.binding === binding)!
    super(
      `The ${binding} binding is missing or bound to the wrong resource type. ` +
        `Declare it as "${entry.configKey}" with binding name "${binding}" in ` +
        `wrangler.jsonc, then redeploy.`
    )
    this.name = "MisconfiguredBindingError"
    this.binding = binding
    this.configKey = entry.configKey
  }
}

/**
 * Guards a feature path. Types say these bindings are always present, so a
 * failure here means wrangler.jsonc and the code disagree — worth a named error
 * rather than a TypeError deep inside the feature.
 */
export function assertBinding<T>(
  value: T,
  binding: ExpectedBinding
): NonNullable<T> {
  const entry = expected.find((candidate) => candidate.binding === binding)!
  if (!probe(value, entry.method).usable) {
    throw new MisconfiguredBindingError(binding)
  }
  return value as NonNullable<T>
}

export function requireBinding<T>(
  env: unknown,
  binding: ExpectedBinding
): NonNullable<T> {
  const value = (env as Record<string, unknown> | undefined)?.[binding]
  return assertBinding(value, binding) as NonNullable<T>
}
