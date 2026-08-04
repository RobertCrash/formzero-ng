import { NavLink, Outlet, useLoaderData } from "react-router"
import type { Route } from "./+types/forms.$formId.settings"
import { loadFormSettingsContext } from "~/lib/form-config/settings.server"
import { cn } from "~/lib/utils"

const sections = [
  ["general", "General"],
  ["fields", "Fields"],
  ["security", "Security"],
  ["notifications", "Notifications"],
  ["webhooks", "Webhooks"],
  ["uploads", "Uploads"],
  ["retention", "Retention"],
  ["advanced", "Advanced"],
] as const

export async function loader({ request, params, context }: Route.LoaderArgs) {
  return loadFormSettingsContext({
    request,
    formId: params.formId,
    env: context.cloudflare.env,
  })
}

export type SettingsOutletContext = Awaited<ReturnType<typeof loader>>

export default function FormSettingsLayout() {
  const data = useLoaderData<typeof loader>()

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Form settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure submission validation, security, delivery, uploads, and
          lifecycle for {data.form.name}.
        </p>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-b" aria-label="Settings">
        {sections.map(([path, label]) => (
          <NavLink
            key={path}
            to={path === "general" ? "." : path}
            end={path === "general"}
            className={({ isActive }) =>
              cn(
                "whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground",
                isActive && "border-foreground text-foreground"
              )
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {!data.platform.ok && (
        <div className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">
            Platform bindings are misconfigured
          </p>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {data.platform.problems.map((problem) => (
              <li key={problem.binding}>
                <code>{problem.binding}</code> is{" "}
                {problem.present ? "bound to the wrong resource type" : "missing"} —{" "}
                {problem.feature} is unavailable. Declare it under{" "}
                <code>{problem.configKey}</code> in <code>wrangler.jsonc</code> with
                exactly that binding name, then redeploy.
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded border p-2">
          Email transport: {data.capabilities.emailTransport ? "Configured" : "Not configured"}
        </div>
        <div className="rounded border p-2">
          Credential encryption: {data.capabilities.credentialEncryption ? "Configured" : "Missing"}
        </div>
        <div className="rounded border p-2">
          Files: {data.operations.file_count} ({data.operations.stored_bytes} bytes)
        </div>
        <div className="rounded border p-2">
          Pending delivery: {data.operations.pending_deliveries}
        </div>
        <div className="rounded border p-2">
          Failed delivery: {data.operations.failed_deliveries}
        </div>
      </div>
      <Outlet context={data} />
    </div>
  )
}
