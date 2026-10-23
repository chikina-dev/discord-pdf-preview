import { attachmentUrl, record, snowflake } from "../shared/task.ts";

export type DiscordAttachment = { id: string; filename: string; url?: string };
export type DiscordMessage = {
  id: string; attachments: DiscordAttachment[]; author: { id: string };
  message_reference?: { message_id?: string };
};
export type FailureKind = "transient" | "rate_limit" | "missing" | "permanent" | "size" | "ambiguous";
export class DiscordFailure extends Error {
  constructor(readonly kind: FailureKind, readonly status = 0, readonly retryAfter = 0,
    readonly global = false, readonly bucket?: string) { super(kind); }
}
function message(value: unknown): DiscordMessage {
  if (!record(value) || !snowflake(value.id) || !record(value.author) || !snowflake(value.author.id) || !Array.isArray(value.attachments)) {
    throw new Error("Invalid Discord message");
  }
  const attachments = value.attachments.map(file => {
    if (!record(file) || !snowflake(file.id) || typeof file.filename !== "string") throw new Error("Invalid attachment");
    return { id: file.id, filename: file.filename, ...(attachmentUrl(file.url) ? { url: file.url } : {}) };
  });
  return {
    id: value.id, author: { id: value.author.id }, attachments,
    ...(record(value.message_reference) && snowflake(value.message_reference.message_id)
      ? { message_reference: { message_id: value.message_reference.message_id } } : {}),
  };
}

export class Discord {
  constructor(private readonly token: string, private readonly request: typeof fetch, private readonly now: () => number,
    private readonly expiresAt: number) {}
  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const write = init.method === "POST" || init.method === "PATCH";
    if (this.now() >= this.expiresAt) throw new DiscordFailure("permanent");
    let response: Response;
    try {
      response = await this.request(`https://discord.com/api/v10${path}`, {
        ...init, headers: { Authorization: `Bot ${this.token}`, ...init.headers },
        redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, this.expiresAt - this.now()))),
      });
    } catch { throw new DiscordFailure(write ? "ambiguous" : "transient"); }
    let body: unknown;
    try { body = await response.json(); } catch {
      if (response.ok) throw new DiscordFailure(write ? "ambiguous" : "transient", response.status);
    }
    if (response.status === 429) {
      const seconds = record(body) && typeof body.retry_after === "number" ? body.retry_after : Number(response.headers.get("retry-after") ?? 5);
      throw new DiscordFailure("rate_limit", 429, Number.isFinite(seconds) ? Math.max(0.1, seconds) : 5,
        record(body) && body.global === true, response.headers.get("x-ratelimit-bucket") ?? undefined);
    }
    if (response.status >= 500) throw new DiscordFailure(write ? "ambiguous" : "transient", response.status);
    if (response.status === 404 || (record(body) && body.code === 10008)) throw new DiscordFailure("missing", response.status);
    if (response.status === 413 || (record(body) && body.code === 40005)) throw new DiscordFailure("size", response.status);
    if (!response.ok) throw new DiscordFailure("permanent", response.status);
    return body;
  }
  async get(channel: string, id: string) {
    return message(await this.api(`/channels/${channel}/messages/${id}`));
  }
  async findReply(channel: string, sourceId: string, filename: string) {
    const user = await this.api("/users/@me");
    if (!record(user) || !snowflake(user.id)) throw new DiscordFailure("transient");
    const values = await this.api(`/channels/${channel}/messages?limit=100`);
    if (!Array.isArray(values)) throw new DiscordFailure("transient");
    return values.map(message).find(m => m.author.id === user.id && m.message_reference?.message_id === sourceId &&
      m.attachments.some(a => a.filename === filename)) ?? null;
  }
  async upload(channel: string, sourceId: string, replyId: string | null, filename: string,
    png: Uint8Array, retained: Array<{ id: string; sourceIndex: number }>, sourceIndex: number) {
    const attachments = [...retained, { id: "0", sourceIndex, filename }]
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map(file => "filename" in file ? { id: 0, filename: file.filename } : { id: file.id });
    const payload = {
      attachments, allowed_mentions: { parse: [], replied_user: false },
      ...(!replyId ? {
        message_reference: { message_id: sourceId, fail_if_not_exists: true },
        nonce: `p${sourceId}`, enforce_nonce: true,
      } : {}),
    };
    const form = new FormData();
    form.set("payload_json", JSON.stringify(payload));
    form.set("files[0]", new Blob([new Uint8Array(png).buffer], { type: "image/png" }), filename);
    const value = await this.api(`/channels/${channel}/messages${replyId ? `/${replyId}` : ""}`, {
      method: replyId ? "PATCH" : "POST", body: form,
    });
    try { return message(value); } catch { throw new DiscordFailure("ambiguous"); }
  }
}
