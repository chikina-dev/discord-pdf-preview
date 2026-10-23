import { attachmentUrl, LIFETIME_MS, log, outputName, type PreviewTask } from "../shared/task.ts";
import { Discord, DiscordFailure, type DiscordMessage } from "./discord.ts";
import { LeaseLost, State, type Job, type Operation } from "./state.ts";

export type Dependencies = {
  fetch: typeof fetch;
  render: (pdf: Uint8Array, longEdge: number) => Promise<Uint8Array>;
  now: () => number;
};
export type Outcome = { retrySeconds?: number };
export async function processTask(task: PreviewTask, db: D1Database, token: string, attempts: number, dep: Dependencies): Promise<Outcome> {
  const expiresAt = task.source.postedAt + LIFETIME_MS;
  if (dep.now() >= expiresAt) { log("expired", { messageId: task.source.messageId }); return {}; }
  const state = new State(db, task.source.messageId, crypto.randomUUID(), dep.now);
  await state.initialize(task);
  if (!await state.claim()) {
    const job = await state.job();
    if (job?.status === "active") log("preview-lease-unavailable", { messageId: task.source.messageId, waitMs: Math.max(0, job.lease_until - dep.now()) });
    return !job || job.status !== "active" ? {} : { retrySeconds: Math.max(1, Math.min(60, Math.ceil((job.lease_until - dep.now()) / 1000))) };
  }
  const discord = new Discord(token, dep.fetch, dep.now, expiresAt);
  const id = task.attachmentId;
  const schedule = async (seconds: number, kind: string, resetItem = true): Promise<Outcome> => {
    const delay = Math.max(1, Math.ceil(seconds));
    if (dep.now() + delay * 1000 >= expiresAt) { await state.stop("expired"); return {}; }
    if (resetItem) await state.patchItem(id, { status: "pending", next_attempt_at: dep.now() + delay * 1000, last_error_kind: kind });
    return { retrySeconds: delay };
  };
  const failed = async (kind: string) => {
    await state.patchItem(id, { status: "failed", last_error_kind: kind });
    await state.completeIfFinished();
    log("preview-failed", { messageId: task.source.messageId, attachmentId: id, kind });
    return {};
  };
  const confirm = async (operation: Pick<Operation, "operation_id" | "attachment_id" | "filename">, reply: DiscordMessage) => {
    const file = reply.attachments.find(file => file.filename === operation.filename);
    if (!file) throw new DiscordFailure("ambiguous");
    await state.commit(operation, reply.id, file.id);
    await state.completeIfFinished();
  };
  const reconcile = async (operation: Operation, job: Job) => {
    const reply = job.reply_message_id ? await discord.get(job.channel_id, job.reply_message_id)
      : await discord.findReply(job.channel_id, job.source_message_id, operation.filename);
    if (reply?.attachments.some(file => file.filename === operation.filename)) {
      await confirm(operation, reply);
      return true;
    }
    await state.stop("delivery_unknown");
    log("delivery-unknown", { messageId: task.source.messageId, attachmentId: operation.attachment_id });
    return false;
  };
  try {
    let job = await state.job();
    if (!job) throw new Error("Missing job");
    const cooldown = await state.cooldown(job.channel_id);
    if (cooldown > dep.now()) return await schedule((cooldown - dep.now()) / 1000, "cooldown", false);
    const pending = await state.operation();
    if (pending) {
      // Another item's send may have crashed. Resolve it before touching this item.
      if (!await reconcile(pending, job)) return {};
      job = await state.job();
      if (!job || job.status !== "active") return {};
    }
    let item = await state.item(id);
    if (!item || ["sent", "failed", "expired"].includes(item.status)) return {};
    if (item.next_attempt_at > dep.now()) return await schedule((item.next_attempt_at - dep.now()) / 1000, "waiting", false);
    if (item.status === "rendering") {
      const interruptions = item.interruptions + 1;
      await state.patchItem(id, { interruptions });
      if (interruptions >= 2) return await failed("render-interrupted");
    }
    let source: DiscordMessage | undefined;
    if (!job.reply_message_id) {
      try { source = await discord.get(job.channel_id, job.source_message_id); }
      catch (error) {
        if (error instanceof DiscordFailure && error.kind === "missing") { await state.stop("cancelled"); return {}; }
        throw error;
      }
    }
    const pdf = task.pdfs.find(pdf => pdf.id === id);
    if (!pdf) return await failed("missing-task-attachment");
    let url = source?.attachments.find(file => file.id === id)?.url ?? pdf.url;
    let response = await download(url, dep, expiresAt);
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel();
      if (status >= 500 || status === 429) throw new DiscordFailure("transient", status);
      // Signed CDN URLs can expire during a retry. Refresh through Discord.
      source = await discord.get(job.channel_id, job.source_message_id);
      const refreshed = source.attachments.find(file => file.id === id);
      if (!refreshed?.url) return await failed("source-attachment-gone");
      url = refreshed.url;
      response = await download(url, dep, expiresAt);
      if (!response.ok) {
        const code = response.status;
        await response.body?.cancel();
        if (code >= 500 || code === 429) throw new DiscordFailure("transient", code);
        return await failed("pdf-unavailable");
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await state.renew();
    await state.patchItem(id, { status: "rendering", next_attempt_at: 0 });
    let longEdge = item.target_long_edge;
    for (;;) {
      let png: Uint8Array;
      try { png = await dep.render(bytes, longEdge); }
      catch { return await failed("invalid-or-unsupported-pdf"); }
      if (dep.now() >= expiresAt) { await state.expire(); return {}; }
      await state.renew();
      const cooldown = await state.cooldown(job.channel_id);
      if (cooldown > dep.now()) return await schedule((cooldown - dep.now()) / 1000, "cooldown");
      if (!job.reply_message_id) {
        // Close the deletion race as far as a preflight GET can; POST also requires the source.
        try { await discord.get(job.channel_id, job.source_message_id); }
        catch (error) {
          if (error instanceof DiscordFailure && error.kind === "missing") { await state.stop("cancelled"); return {}; }
          throw error;
        }
      }
      const retained = (await state.items()).filter(file => file.discord_attachment_id !== null)
        .map(file => ({ id: file.discord_attachment_id!, sourceIndex: file.source_index }));
      const filename = outputName(pdf);
      await state.renew();
      const operationId = await state.begin(id, filename, job.reply_message_id ? "edit" : "create");
      let reply: DiscordMessage;
      try {
        // Last check is after the durable reservation. Never initiate a late write.
        if (dep.now() >= expiresAt) { await state.expire(); return {}; }
        reply = await discord.upload(job.channel_id, job.source_message_id, job.reply_message_id, filename, png, retained, item.source_index);
      } catch (error) {
        if (!(error instanceof DiscordFailure) || error.kind === "ambiguous") {
          // Leave 'sending' intact: the next delivery may only reconcile it.
          return await schedule(1, "send-result-unknown", false);
        }
        await state.reject(operationId);
        if (error.kind === "size" && longEdge > 1) {
          longEdge = Math.max(1, Math.floor(longEdge * 0.75));
          await state.patchItem(id, { status: "rendering", target_long_edge: longEdge });
          continue;
        }
        if (error.kind === "missing") { await state.stop("cancelled"); return {}; }
        throw error;
      }
      // A failure after Discord success must leave the operation in 'sending'.
      await confirm({ operation_id: operationId, attachment_id: id, filename }, reply);
      log("preview-sent", { messageId: task.source.messageId, attachmentId: id, longEdge, attempt: attempts });
      return {};
    }
  } catch (error) {
    if (dep.now() >= expiresAt) { await state.expire(); return {}; }
    if (error instanceof LeaseLost) return { retrySeconds: 5 };
    if (error instanceof DiscordFailure) {
      if (error.kind === "ambiguous" && await state.operation()) return await schedule(1, "send-result-unknown", false);
      if (error.kind === "rate_limit") {
        await state.rateLimit(task.source.channelId, dep.now() + error.retryAfter * 1000, error.global, error.bucket);
        return await schedule(error.retryAfter, "rate-limit", !await state.operation());
      }
      if (error.kind === "transient") return await schedule(backoff(attempts), "transient", !await state.operation());
      if (error.kind === "missing" && await state.operation()) { await state.stop("delivery_unknown"); return {}; }
      return await failed(error.kind);
    }
    // Database or infrastructure errors are retried without erasing a send marker.
    log("preview-interrupted", { messageId: task.source.messageId, attachmentId: id });
    throw error;
  } finally { await state.release(); }
}

function backoff(attempts: number) { return Math.min(60, 5 * 2 ** Math.min(4, Math.max(0, attempts - 1))); }
async function download(url: string, dep: Dependencies, expiresAt: number) {
  if (!attachmentUrl(url)) throw new DiscordFailure("permanent");
  if (dep.now() >= expiresAt) throw new DiscordFailure("permanent");
  try {
    return await dep.fetch(url, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, expiresAt - dep.now()))) });
  } catch { throw new DiscordFailure("transient"); }
}
