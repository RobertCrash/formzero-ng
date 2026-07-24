import type { FieldRule } from "~/lib/form-config/types"

export type Submission = {
  id: string
  form_id: string
  request_id: string
  config_revision: number
  status: "accepted" | "spam" | "pending_files" | "pending_delete" | "failed"
  data: Record<string, any>
  metadata_json: Record<string, any>
  source_ip: string | null
  source_ip_hash: string | null
  source_origin: string | null
  country_code: string | null
  cf_ray: string | null
  user_agent: string | null
  created_at: number
  processed_at: number | null
  ip_delete_after: number | null
  delete_after: number | null
}

export type SubmissionEmailData = {
  id: string
  formId: string
  formName: string
  data: Record<string, any>
  createdAt: number
  recipients?: string[]
  replyTo?: string
  subject?: string
  fields?: FieldRule[]
  files?: Array<{
    id: string
    name: string
    mimeType: string
    sizeBytes: number
    downloadUrl: string
  }>
}
