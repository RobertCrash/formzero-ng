import type { Route } from "./+types/forms.$formId.submissions.$submissionId"
import { data } from "react-router"
import { requireAuth } from "~/lib/require-auth.server"
import { deleteSubmissionWithFiles } from "~/lib/uploads/delete-submission.server"

export async function action({ request, params, context }: Route.ActionArgs) {
  const database = context.cloudflare.env.DB

  await requireAuth(request, database)

  if (request.method !== "DELETE") {
    return data(
      { success: false, error: "Method not allowed" },
      { status: 405 }
    )
  }

  const { formId, submissionId } = params

  try {
    const result = await deleteSubmissionWithFiles({
      db: database,
      bucket: context.cloudflare.env.UPLOADS,
      formId,
      submissionId,
    })

    if (!result.found) {
      return data(
        { success: false, error: "Submission not found" },
        { status: 404 }
      )
    }
    if (!result.deleted) {
      return data(
        {
          success: false,
          error: "Deletion is pending because one or more files could not be removed.",
        },
        { status: 202 }
      )
    }

    return data({ success: true }, { status: 200 })
  } catch (error) {
    console.error("Error deleting submission:", error)
    return data(
      { success: false, error: "Failed to delete submission" },
      { status: 500 }
    )
  }
}
