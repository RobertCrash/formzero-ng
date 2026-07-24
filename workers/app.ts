import { createRequestHandler } from "react-router";
import {
  processDeliveryBatch,
  type DeliveryQueueMessage,
} from "../app/lib/delivery/process-batch.server";
import { runScheduledMaintenance } from "../app/lib/retention/run-scheduled-maintenance.server";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
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
    await processDeliveryBatch(
      batch,
      env as Env & {
        FORMZERO_ENCRYPTION_KEY?: string;
        FORMZERO_PUBLIC_URL?: string;
      }
    );
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runScheduledMaintenance(
        env as Env & {
          DELIVERY_QUEUE?: Queue<{ jobId: string }>;
          UPLOADS?: R2Bucket;
        }
      )
    );
  },
} satisfies ExportedHandler<Env, DeliveryQueueMessage>;
