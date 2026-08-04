/**
 * Fails on any high or critical dependency advisory that has not been reviewed.
 *
 * `npm audit` on its own is noise: it reports the same known findings on every
 * run, so nobody reads it and a genuinely new one arrives unnoticed. Each
 * accepted advisory is registered in known-advisories.json with a reason and a
 * review date, and this check fails when something unregistered appears, when a
 * registered entry passes its review date, or when a registered entry no longer
 * shows up — that last case means it was fixed and the entry should go.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

type Advisory = {
  package: string
  severity: string
  reason: string
  reviewBy: string
}

type AuditReport = {
  vulnerabilities?: Record<
    string,
    {
      via?: Array<
        | string
        | { url?: string; title?: string; severity?: string; range?: string }
      >
    }
  >
}

const known = JSON.parse(
  readFileSync(new URL("known-advisories.json", import.meta.url), "utf8")
) as Record<string, Advisory>

function runAudit(): AuditReport {
  // npm exports its own configuration as npm_config_* when it runs a script, and
  // the nested npm rejects some of those flags outright. Dropping them keeps the
  // audit working whether it is invoked directly or through `npm run`.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_"))
  )
  let output: string
  try {
    output = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", env })
  } catch (error) {
    // npm exits non-zero whenever it finds anything, so the report arrives on
    // stdout of the failed call rather than as an error condition of its own.
    const stdout = (error as { stdout?: string }).stdout
    if (!stdout) throw error
    output = stdout
  }
  const report = JSON.parse(output) as AuditReport
  if (!report.vulnerabilities) {
    throw new Error(`npm audit produced no vulnerability report: ${output.slice(0, 500)}`)
  }
  return report
}

const report = runAudit()
const found = new Map<string, { package: string; severity: string; title: string }>()

for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via === "string" || !via.url) continue
    const severity = via.severity ?? "unknown"
    if (severity !== "high" && severity !== "critical") continue
    const id = via.url.split("/").pop()!
    found.set(id, { package: name, severity, title: via.title ?? id })
  }
}

const failures: string[] = []
const today = new Date().toISOString().slice(0, 10)

for (const [id, advisory] of found) {
  const entry = known[id]
  if (!entry) {
    failures.push(
      `${advisory.severity} advisory ${id} in ${advisory.package} is not ` +
        `reviewed: ${advisory.title}. Upgrade the dependency, or record why it ` +
        "does not apply in scripts/known-advisories.json."
    )
    continue
  }
  if (entry.reviewBy <= today) {
    failures.push(
      `${id} (${entry.package}) was due for review on ${entry.reviewBy}. ` +
        "Check whether a fixed version is now reachable and update or extend the entry."
    )
  }
}

for (const id of Object.keys(known)) {
  if (!found.has(id)) {
    failures.push(
      `${id} is registered as an accepted advisory but npm audit no longer ` +
        "reports it. Remove the entry from scripts/known-advisories.json."
    )
  }
}

if (failures.length > 0) {
  console.error("Dependency advisories need attention:")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

const reviewed = Object.keys(known).length
console.log(
  `No unreviewed high or critical advisories (${reviewed} accepted, next review ${
    Object.values(known)
      .map((entry) => entry.reviewBy)
      .sort()[0] ?? "n/a"
  })`
)
