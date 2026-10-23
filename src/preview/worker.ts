import { isTask, log } from "../shared/task.ts";
import { processTask } from "./process.ts";
import { renderFirstPage } from "./render.ts";
import { cleanup } from "./state.ts";

export default {
  async queue(batch: MessageBatch<unknown>, env: PreviewEnv) {
    for (const message of batch.messages) {
      if (!isTask(message.body)) { log("invalid-task"); message.ack(); continue; }
      try {
        const outcome = await processTask(message.body, env.DB, env.DISCORD_BOT_TOKEN, message.attempts, {
          fetch: (input, init) => fetch(input, init), render: renderFirstPage, now: Date.now,
        });
        log("preview-disposition", { messageId: message.body.source.messageId, attachmentId: message.body.attachmentId,
          retrySeconds: outcome.retrySeconds ?? null });
        outcome.retrySeconds === undefined ? message.ack() : message.retry({ delaySeconds: outcome.retrySeconds });
      } catch {
        log("consumer-interrupted", { messageId: message.body.source.messageId, attachmentId: message.body.attachmentId });
        message.retry({ delaySeconds: 5 });
      }
    }
  },
  async scheduled(_event: ScheduledController, env: PreviewEnv) {
    await cleanup(env.DB, Date.now());
  },
  fetch() { return new Response(null, { status: 404 }); },
} satisfies ExportedHandler<PreviewEnv>;
