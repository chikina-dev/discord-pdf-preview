import { LIFETIME_MS, type PreviewTask } from "../shared/task.ts";

export type Job = {
  source_message_id: string; channel_id: string; expires_at: number; reply_message_id: string | null;
  status: "active" | "complete" | "cancelled" | "expired" | "delivery_unknown";
  lease_token: string | null; lease_until: number;
};
export type Item = {
  source_message_id: string; attachment_id: string; filename: string; source_index: number;
  status: "pending" | "rendering" | "sending" | "sent" | "failed" | "expired";
  next_attempt_at: number; target_long_edge: number; interruptions: number;
  discord_attachment_id: string | null; last_error_kind: string | null;
};
export type Operation = {
  operation_id: string; source_message_id: string; attachment_id: string;
  kind: "create" | "edit"; status: string; started_at: number; filename: string;
};
export class LeaseLost extends Error {}

// Each mutating statement checks ownership, including every statement in a batch.
export class State {
  constructor(readonly db: D1Database, readonly jobId: string, readonly token: string, readonly now: () => number) {}
  private owned() {
    return "EXISTS (SELECT 1 FROM preview_jobs j WHERE j.source_message_id = ? AND j.lease_token = ? AND j.lease_until > ?)";
  }
  private ownerArgs() { return [this.jobId, this.token, this.now()]; }
  async initialize(task: PreviewTask) {
    await this.db.batch([
      this.db.prepare("INSERT INTO preview_jobs(source_message_id,channel_id,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING")
        .bind(this.jobId, task.source.channelId, task.source.postedAt + LIFETIME_MS),
      ...task.pdfs.map(pdf => this.db.prepare("INSERT INTO preview_items(source_message_id,attachment_id,filename,source_index) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(this.jobId, pdf.id, pdf.filename, pdf.sourceIndex)),
    ]);
  }
  async job() {
    return this.db.prepare("SELECT * FROM preview_jobs WHERE source_message_id=?").bind(this.jobId).first<Job>();
  }
  async item(id: string) {
    return this.db.prepare("SELECT * FROM preview_items WHERE source_message_id=? AND attachment_id=?").bind(this.jobId, id).first<Item>();
  }
  async items() {
    return (await this.db.prepare("SELECT * FROM preview_items WHERE source_message_id=? ORDER BY source_index").bind(this.jobId).all<Item>()).results;
  }
  async claim() {
    const now = this.now();
    return (await this.db.prepare("UPDATE preview_jobs SET lease_token=?,lease_until=? WHERE source_message_id=? AND status='active' AND expires_at>? AND lease_until<=?")
      .bind(this.token, now + 120_000, this.jobId, now, now).run()).meta.changes === 1;
  }
  async renew() {
    const now = this.now();
    const result = await this.db.prepare("UPDATE preview_jobs SET lease_until=? WHERE source_message_id=? AND lease_token=? AND lease_until>? AND expires_at>? AND status='active'")
      .bind(now + 120_000, this.jobId, this.token, now, now).run();
    if (result.meta.changes !== 1) throw new LeaseLost("Lease expired");
  }
  async release() {
    await this.db.prepare("UPDATE preview_jobs SET lease_token=NULL,lease_until=0 WHERE source_message_id=? AND lease_token=?")
      .bind(this.jobId, this.token).run();
  }
  async patchItem(id: string, patch: Partial<Pick<Item, "status" | "next_attempt_at" | "target_long_edge" | "interruptions" | "last_error_kind">>) {
    const entries = Object.entries(patch);
    const allowed = ["status", "next_attempt_at", "target_long_edge", "interruptions", "last_error_kind"];
    if (!entries.length || entries.some(([key]) => !allowed.includes(key))) throw new Error("Invalid item patch");
    const result = await this.db.prepare(`UPDATE preview_items SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE source_message_id=? AND attachment_id=? AND ${this.owned()}`)
      .bind(...entries.map(([, value]) => value), this.jobId, id, ...this.ownerArgs()).run();
    if (result.meta.changes !== 1) throw new LeaseLost("Item ownership lost");
  }
  async stop(status: Job["status"]) {
    const result = await this.db.prepare(`UPDATE preview_jobs SET status=? WHERE source_message_id=? AND ${this.owned()}`)
      .bind(status, this.jobId, ...this.ownerArgs()).run();
    if (result.meta.changes !== 1) throw new LeaseLost("Job ownership lost");
  }
  async expire() {
    // Expiration is monotonic and does not require a still-live lease.
    await this.db.prepare("UPDATE preview_jobs SET status='expired' WHERE source_message_id=? AND status='active' AND expires_at<=?")
      .bind(this.jobId, this.now()).run();
  }
  async completeIfFinished() {
    await this.db.prepare(`UPDATE preview_jobs SET status='complete' WHERE source_message_id=? AND status='active' AND ${this.owned()} AND NOT EXISTS (SELECT 1 FROM preview_items WHERE source_message_id=? AND status IN ('pending','rendering','sending'))`)
      .bind(this.jobId, ...this.ownerArgs(), this.jobId).run();
  }
  async operation() {
    return this.db.prepare("SELECT * FROM send_operations WHERE source_message_id=? AND status='sending'").bind(this.jobId).first<Operation>();
  }
  async begin(id: string, filename: string, kind: Operation["kind"]) {
    const operationId = crypto.randomUUID();
    const now = this.now();
    const result = await this.db.batch([
      this.db.prepare(`INSERT INTO send_operations(operation_id,source_message_id,attachment_id,kind,started_at,filename) SELECT ?,?,?,?,?,? WHERE ${this.owned()} AND EXISTS(SELECT 1 FROM preview_jobs WHERE source_message_id=? AND status='active' AND expires_at>?) AND NOT EXISTS(SELECT 1 FROM send_operations WHERE source_message_id=? AND status='sending')`)
        .bind(operationId, this.jobId, id, kind, now, filename, ...this.ownerArgs(), this.jobId, now, this.jobId),
      this.db.prepare(`UPDATE preview_items SET status='sending' WHERE source_message_id=? AND attachment_id=? AND ${this.owned()} AND EXISTS(SELECT 1 FROM send_operations WHERE operation_id=?)`)
        .bind(this.jobId, id, ...this.ownerArgs(), operationId),
    ]);
    if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) throw new LeaseLost("Send not reserved");
    return operationId;
  }
  async reject(operationId: string) {
    await this.db.prepare(`UPDATE send_operations SET status='rejected' WHERE operation_id=? AND ${this.owned()}`)
      .bind(operationId, ...this.ownerArgs()).run();
  }
  async commit(operation: Pick<Operation, "operation_id" | "attachment_id">, replyId: string, attachmentId: string) {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE preview_items SET status='sent',discord_attachment_id=?,last_error_kind=NULL WHERE source_message_id=? AND attachment_id=? AND ${this.owned()}`)
        .bind(attachmentId, this.jobId, operation.attachment_id, ...this.ownerArgs()),
      this.db.prepare(`UPDATE preview_jobs SET reply_message_id=? WHERE source_message_id=? AND ${this.owned()}`)
        .bind(replyId, this.jobId, ...this.ownerArgs()),
      this.db.prepare(`UPDATE send_operations SET status='confirmed' WHERE operation_id=? AND ${this.owned()}`)
        .bind(operation.operation_id, ...this.ownerArgs()),
    ]);
    if (results.some(result => result.meta.changes !== 1)) throw new LeaseLost("Commit ownership lost");
  }
  async cooldown(channelId: string) {
    const result = await this.db.prepare("SELECT MAX(until_at) AS until_at FROM discord_cooldowns WHERE scope IN ('global',?) OR scope IN (SELECT 'bucket:' || bucket FROM discord_routes WHERE channel_id=?)")
      .bind(`channel:${channelId}`, channelId).first<{ until_at: number | null }>();
    return result?.until_at ?? 0;
  }
  async rateLimit(channelId: string, until: number, global: boolean, bucket?: string) {
    const statements = [this.db.prepare("INSERT INTO discord_cooldowns(scope,until_at) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)")
      .bind(global ? "global" : bucket ? `bucket:${bucket}` : `channel:${channelId}`, until)];
    if (bucket) statements.push(this.db.prepare("INSERT INTO discord_routes(channel_id,bucket) VALUES(?,?) ON CONFLICT(channel_id,bucket) DO NOTHING").bind(channelId, bucket));
    await this.db.batch(statements);
  }
}

export async function cleanup(db: D1Database, now: number) {
  await db.batch([
    db.prepare("UPDATE preview_jobs SET status='expired' WHERE expires_at<=? AND status='active'").bind(now),
    db.prepare("DELETE FROM preview_jobs WHERE expires_at<? AND status<>'active'").bind(now - 86_400_000),
    db.prepare("DELETE FROM discord_cooldowns WHERE until_at<?").bind(now),
    db.prepare("DELETE FROM discord_routes WHERE 'bucket:' || bucket NOT IN (SELECT scope FROM discord_cooldowns)"),
  ]);
}
