import { useState } from "react"
import { useFetcher, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.fields"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import type { FieldRule, FieldType } from "~/lib/form-config/types"
import { FIELD_TYPES } from "~/lib/form-config/types"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"

export async function action({ request, params, context }: Route.ActionArgs) {
  return savePolicyRequest({
    request,
    formId: params.formId,
    env: context.cloudflare.env,
  })
}

const emptyField = (): FieldRule => ({
  name: "",
  label: "",
  type: "string",
  required: false,
  trim: true,
})

export default function FieldSettings() {
  const { form } = useOutletContext<SettingsOutletContext>()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [fields, setFields] = useState<FieldRule[]>(
    () => structuredClone(form.policy.fields)
  )
  const [rejectUnknown, setRejectUnknown] = useState(
    form.policy.request.rejectUnknownFields
  )

  function update(index: number, patch: Partial<FieldRule>) {
    setFields((current) =>
      current.map((field, fieldIndex) =>
        fieldIndex === index ? { ...field, ...patch } : field
      )
    )
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= fields.length) return
    setFields((current) => {
      const copy = [...current]
      ;[copy[index], copy[target]] = [copy[target], copy[index]]
      return copy
    })
  }

  const policy = {
    ...form.policy,
    fields,
    request: {
      ...form.policy.request,
      rejectUnknownFields: rejectUnknown,
    },
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fields</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div
              key={`${index}-${field.name}`}
              className="grid gap-2 rounded-md border p-3 md:grid-cols-12"
            >
              <Input
                className="md:col-span-2"
                aria-label="Field name"
                placeholder="name"
                value={field.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <Input
                className="md:col-span-2"
                aria-label="Field label"
                placeholder="Label"
                value={field.label ?? ""}
                onChange={(event) => update(index, { label: event.target.value })}
              />
              <select
                className="rounded-md border bg-background px-3 text-sm md:col-span-2"
                value={field.type}
                onChange={(event) =>
                  update(index, { type: event.target.value as FieldType })
                }
              >
                {FIELD_TYPES.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
              <Input
                className="md:col-span-1"
                type="number"
                aria-label="Minimum length"
                placeholder="Min"
                value={field.minLength ?? ""}
                onChange={(event) =>
                  update(index, {
                    minLength: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
              />
              <Input
                className="md:col-span-1"
                type="number"
                aria-label="Maximum length"
                placeholder="Max"
                value={field.maxLength ?? ""}
                onChange={(event) =>
                  update(index, {
                    maxLength: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
              />
              <label className="flex items-center gap-2 text-sm md:col-span-1">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) =>
                    update(index, { required: event.target.checked })
                  }
                />
                Required
              </label>
              <div className="flex gap-1 md:col-span-3 md:justify-end">
                <Button variant="outline" size="sm" onClick={() => move(index, -1)}>
                  Up
                </Button>
                <Button variant="outline" size="sm" onClick={() => move(index, 1)}>
                  Down
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setFields((current) => [
                      ...current.slice(0, index + 1),
                      { ...field, name: `${field.name}_copy` },
                      ...current.slice(index + 1),
                    ])
                  }
                >
                  Duplicate
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                    setFields((current) =>
                      current.filter((_, fieldIndex) => fieldIndex !== index)
                    )
                  }
                >
                  Delete
                </Button>
              </div>
              {(field.type === "select" || field.type === "string-array") && (
                <Input
                  className="md:col-span-12"
                  aria-label="Options"
                  placeholder="Options, comma separated"
                  value={field.options?.join(", ") ?? ""}
                  onChange={(event) =>
                    update(index, {
                      options: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              )}
              <Input
                className="md:col-span-12"
                aria-label="Pattern"
                placeholder="Optional regular expression"
                value={field.pattern ?? ""}
                onChange={(event) =>
                  update(index, { pattern: event.target.value || undefined })
                }
              />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            type="button"
            onClick={() => setFields((current) => [...current, emptyField()])}
          >
            Add field
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rejectUnknown}
              onChange={(event) => setRejectUnknown(event.target.checked)}
            />
            Reject unknown fields
          </label>
        </div>
        <fetcher.Form method="post">
          <input type="hidden" name="revision" value={form.configRevision} />
          <input type="hidden" name="policy" value={JSON.stringify(policy)} />
          {fetcher.data?.error && (
            <p className="mb-2 text-sm text-destructive">{fetcher.data.error}</p>
          )}
          <Button disabled={fetcher.state !== "idle"}>Save fields</Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  )
}
