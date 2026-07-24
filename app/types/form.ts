import type { FormPolicyV1 } from "~/lib/form-config/types"

export type Form = {
  id: string
  name: string
  config_json?: string
  config_schema_version?: number
  config_revision?: number
  policy?: FormPolicyV1
}
