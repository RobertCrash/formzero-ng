import { createRequestHandler } from "react-router";
import {
  processDeliveryBatch,
  type DeliveryQueueMessage,
} from "../app/lib/delivery/process-batch.server";
import type { AppEnv } from "../app/lib/env";
import { checkPlatformBindings } from "../app/lib/platform/check-bindings.server";
import { runScheduledMaintenance } from "../app/lib/retention/run-scheduled-maintenance.server";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: AppEnv;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
  async queue(batch, env) {
    await processDeliveryBatch(batch, env);
  },
  async scheduled(_controller, env, ctx) {
    // Daily cron is the cheapest place to make a misconfigured binding visible
    // in Workers Logs without bricking request handling.
    const report = checkPlatformBindings(env);
    if (!report.ok) {
      console.error(
        "FormZero platform bindings are misconfigured:",
        JSON.stringify(report.problems)
      );
    }
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<AppEnv, DeliveryQueueMessage>;
