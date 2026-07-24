import type { Route } from "./+types/api.forms.$formId.submissions";
import { data } from "react-router";
import { loadFormWithPolicy } from "~/lib/form-config/load-form-policy.server";
import { applyRateLimit } from "~/lib/submissions/apply-rate-limit.server";
import { buildSubmissionContext } from "~/lib/submissions/build-context.server";
import { createSubmissionWithJobs } from "~/lib/submissions/create-submission.server";
import { SubmissionError } from "~/lib/submissions/errors";
import { extractInternalFields } from "~/lib/submissions/normalize-fields";
import { parseSubmissionRequest } from "~/lib/submissions/parse-request.server";
import {
  submissionFailure,
  submissionSuccess,
} from "~/lib/submissions/response.server";
import {
  resolveCorsHeaders,
  validateOrigin,
} from "~/lib/submissions/validate-origin";
import { validateHoneypot } from "~/lib/submissions/validate-honeypot";
import { validateAndNormalizeFields } from "~/lib/submissions/validate-fields";
import { verifyTurnstile } from "~/lib/submissions/verify-turnstile.server";
import { uploadInlineFiles } from "~/lib/uploads/inline-upload.server";
import { prepareDirectUploads } from "~/lib/uploads/complete-upload.server";
import { publishDeliveryJobs } from "~/lib/delivery/publish-jobs.server";

type SubmissionEnv = Env & {
  UPLOADS?: R2Bucket;
  DELIVERY_QUEUE?: Queue<{ jobId: string }>;
  TURNSTILE_SECRET?: string;
  FORMZERO_ENCRYPTION_KEY?: string;
  IP_HASH_SECRET?: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const form = await loadFormWithPolicy(
    context.cloudflare.env.DB,
    params.formId
  );
  const headers = form
    ? resolveCorsHeaders(request, form.policy.security)
    : new Headers({ Vary: "Origin" });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: form ? 204 : 404,
      headers,
    });
  }

  return data(
    {
      success: false,
      error: { code: "method_not_allowed", message: "Method not allowed" },
    },
    { status: 405, headers }
  );
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const receivedAt = Date.now();
  const fallbackRequestId = crypto.randomUUID();
  const env = context.cloudflare.env as SubmissionEnv;
  let cors = new Headers({ Vary: "Origin" });
  let form: Awaited<ReturnType<typeof loadFormWithPolicy>> = null;
  let requestId = fallbackRequestId;

  try {
    form = await loadFormWithPolicy(env.DB, params.formId);
    if (!form) {
      throw new SubmissionError("form_not_found", "Form not found.");
    }

    cors = resolveCorsHeaders(request, form.policy.security);
    const submissionContext = await buildSubmissionContext({
      request,
      env,
      policy: form.policy,
      receivedAt,
    });
    requestId = submissionContext.core.requestId;
    const origin = validateOrigin(request, form.policy.security);
    submissionContext.core.origin = origin;

    const rateLimit = await applyRateLimit({
      formId: form.id,
      sourceIpHash: submissionContext.rateLimitIpHash,
      config: form.policy.security.rateLimit,
      env,
    });
    const parsed = await parseSubmissionRequest({ request, policy: form.policy });
    const { fields: rawFields, internal } = extractInternalFields(
      parsed,
      form.policy.security.honeypot.fieldName,
      form.policy.security.honeypot.startedAtFieldName
    );
    const honeypot = validateHoneypot({
      internal,
      config: form.policy.security.honeypot,
      receivedAt,
    });

    if (honeypot.discard) {
      return submissionSuccess({
        request,
        requestId: submissionContext.core.requestId,
        cors,
        redirects: form.policy.redirects,
      });
    }

    const captcha = await verifyTurnstile({
      token: internal.turnstileToken,
      request,
      config: form.policy.security.captcha,
      env,
      sourceIp: submissionContext.observedIp,
    });
    const directUploads = await prepareDirectUploads({
      db: env.DB,
      bucket: env.UPLOADS,
      form,
      tokens: internal.uploadTokens,
    });
    const attachedFileCounts = directUploads.files.reduce<Record<string, number>>(
      (counts, file) => {
        counts[file.fieldName] = (counts[file.fieldName] ?? 0) + 1;
        return counts;
      },
      {}
    );
    let fields;
    let uploaded;
    try {
      fields = validateAndNormalizeFields({
        values: rawFields,
        files: parsed.files,
        attachedFileCounts,
        rules: form.policy.fields,
        rejectUnknownFields: form.policy.request.rejectUnknownFields,
      });
      uploaded = await uploadInlineFiles({
        bucket: env.UPLOADS,
        form,
        filesByField: parsed.files,
      });
    } catch (error) {
      await directUploads.cleanup();
      throw error;
    }
    const preparedFiles = [...uploaded.files, ...directUploads.files];

    const processingDurationMs = Date.now() - receivedAt;
    const metadata = {
      ...submissionContext.metadata,
      security: {
        originAccepted: true,
        captcha: captcha ?? undefined,
        honeypot: {
          enabled: form.policy.security.honeypot.enabled,
          triggered: honeypot.triggered,
          minimumTimePassed: honeypot.minimumTimePassed,
        },
        rateLimit,
      },
      payload: {
        encoding: parsed.encoding,
        payloadBytes: parsed.payloadBytes,
        fieldCount: Object.keys(fields).length,
        fileCount: preparedFiles.length,
        totalFileBytes: uploaded.totalBytes + directUploads.totalBytes,
      },
      processing: { processingDurationMs },
    };

    let submission;
    try {
      submission = await createSubmissionWithJobs({
        db: env.DB,
        form,
        fields,
        files: preparedFiles,
        submissionContext: submissionContext.core,
        metadata,
      });
    } catch (error) {
      await uploaded.cleanup();
      await directUploads.cleanup();
      throw error;
    }
    await directUploads.finalize();

    context.cloudflare.ctx.waitUntil(
      publishDeliveryJobs({
        db: env.DB,
        queue: env.DELIVERY_QUEUE,
        jobs: submission.deliveryJobs,
      })
    );

    return submissionSuccess({
      request,
      submissionId: submission.id,
      requestId: submission.requestId,
      cors,
      redirects: form.policy.redirects,
    });
  } catch (error) {
    console.error("Error processing form submission:", error);
    return submissionFailure({
      request,
      error,
      requestId,
      cors,
      redirects: form?.policy.redirects,
    });
  }
}
