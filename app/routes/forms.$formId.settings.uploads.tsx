import { useState } from "react"
import { useFetcher, useOutletContext } from "react-router"
import type { Route } from "./+types/forms.$formId.settings.uploads"
import type { SettingsOutletContext } from "./forms.$formId.settings"
import { savePolicyRequest } from "~/lib/form-config/settings.server"
import type { FormPolicyV1 } from "~/lib/form-config/types"
import {
  INLINE_MAX_TOTAL_BYTES,
  inlineRequestFloorBytes,
} from "~/lib/form-config/upload-limits"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"

export async function action({ request, params, context }: Route.ActionArgs) {
  return savePolicyRequest({
    request,
    formId: params.formId,
    env: context.cloudflare.env,
  })
}

export default function UploadSettings() {
  const { form } = useOutletContext<SettingsOutletContext>()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [uploads, setUploads] = useState(() => structuredClone(form.policy.uploads))
  const [mimeTypes, setMimeTypes] = useState(
    uploads.allowedMimeTypes.join("\n")
  )
  const [extensions, setExtensions] = useState(
    uploads.allowedExtensions.join(", ")
  )
  const isInline = uploads.enabled && uploads.mode === "inline"
  const requestFloor = inlineRequestFloorBytes(uploads)
  // The request limit caps the whole multipart body, so inline uploads are only
  // reachable if it clears the upload set. Raise it here rather than rejecting a
  // save the operator would have to fix on a different settings page.
  const maxPayloadBytes = isInline
    ? Math.max(form.policy.request.maxPayloadBytes, requestFloor)
    : form.policy.request.maxPayloadBytes
  const policy: FormPolicyV1 = {
    ...form.policy,
    request: {
      ...form.policy.request,
      maxPayloadBytes,
      allowedContentTypes: isInline
        ? [
            ...new Set([
              ...form.policy.request.allowedContentTypes,
              "multipart/form-data" as const,
            ]),
          ]
        : form.policy.request.allowedContentTypes,
    },
    uploads: {
      ...uploads,
      allowedMimeTypes: mimeTypes
        .split(/[\n,]/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
      allowedExtensions: extensions
        .split(/[\n,]/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    },
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>File uploads</CardTitle>
      </CardHeader>
      <CardContent>
        <fetcher.Form method="post" className="space-y-5">
          <input type="hidden" name="revision" value={form.configRevision} />
          <input type="hidden" name="policy" value={JSON.stringify(policy)} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={uploads.enabled}
              onChange={(event) =>
                setUploads((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
            />
            Enable uploads
          </label>
          <div className="space-y-2">
            <Label htmlFor="upload-mode">Upload mode</Label>
            <select
              id="upload-mode"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={uploads.mode}
              onChange={(event) =>
                setUploads((current) => ({
                  ...current,
                  mode: event.target.value as "inline" | "direct",
                }))
              }
            >
              <option value="inline">Inline multipart (plain HTML)</option>
              <option value="direct">Direct upload session (JavaScript)</option>
            </select>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label htmlFor="max-files">Maximum files</Label>
              <Input
                id="max-files"
                type="number"
                value={uploads.maxFiles}
                onChange={(event) =>
                  setUploads((current) => ({
                    ...current,
                    maxFiles: Number(event.target.value),
                  }))
                }
              />
            </div>
            <div>
              <Label htmlFor="max-file-bytes">Bytes per file</Label>
              <Input
                id="max-file-bytes"
                type="number"
                value={uploads.maxFileBytes}
                onChange={(event) =>
                  setUploads((current) => ({
                    ...current,
                    maxFileBytes: Number(event.target.value),
                  }))
                }
              />
            </div>
            <div>
              <Label htmlFor="max-total-bytes">Total bytes</Label>
              <Input
                id="max-total-bytes"
                type="number"
                value={uploads.maxTotalBytes}
                onChange={(event) =>
                  setUploads((current) => ({
                    ...current,
                    maxTotalBytes: Number(event.target.value),
                  }))
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mime-types">Allowed MIME types</Label>
            <textarea
              id="mime-types"
              className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
              value={mimeTypes}
              onChange={(event) => setMimeTypes(event.target.value)}
              placeholder="application/pdf&#10;image/png"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="extensions">Allowed extensions</Label>
            <Input
              id="extensions"
              value={extensions}
              onChange={(event) => setExtensions(event.target.value)}
              placeholder=".pdf, .png"
            />
          </div>
          {isInline && (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <p>
                Request limit:{" "}
                <span className="font-medium">
                  {maxPayloadBytes.toLocaleString()} bytes
                </span>
              </p>
              <p className="text-muted-foreground">
                Inline uploads share the submission request, so saving raises the
                request limit to cover {uploads.maxFiles} files totalling{" "}
                {uploads.maxTotalBytes.toLocaleString()} bytes plus multipart
                overhead.
              </p>
              {uploads.maxTotalBytes > INLINE_MAX_TOTAL_BYTES && (
                <p className="text-destructive">
                  Inline mode accepts at most{" "}
                  {INLINE_MAX_TOTAL_BYTES.toLocaleString()} bytes in total.
                  Switch to direct upload mode for larger files.
                </p>
              )}
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            File fields:{" "}
            {form.policy.fields
              .filter((field) => field.type === "file" || field.type === "files")
              .map((field) => field.label ?? field.name)
              .join(", ") || "None configured"}
          </p>
          {fetcher.data?.error && (
            <p className="text-sm text-destructive">{fetcher.data.error}</p>
          )}
          <Button disabled={fetcher.state !== "idle"}>Save uploads</Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  )
}
