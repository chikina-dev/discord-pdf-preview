import { DurableObject } from "cloudflare:workers";
import { LIFETIME_MS, log, record, type PreviewTask } from "../shared/task.ts";
import { previewTasks } from "./events.ts";
import { closePolicy, gatewayUrl, parsePayload, Protocol, randomFraction, type Payload, type Session } from "./protocol.ts";

type Stored = { session: Session | null; identifyAfter: number; fatal: boolean; reconnectAt: number; fingerprint?: string };

export class Gateway extends DurableObject<GatewayEnv> {
  private socket: WebSocket | null = null;
  private generation = 0;
  private connecting = false;
  private flushing = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private failureCount = 0;
  private stored: Stored = { session: null, identifyAfter: 0, fatal: false, reconnectAt: 0 };

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS gateway_state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,expires_at INTEGER NOT NULL)");
      const saved = ctx.storage.sql.exec<{ data: string }>("SELECT data FROM gateway_state WHERE id=1").toArray()[0];
      if (saved) this.stored = JSON.parse(saved.data);
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
        `${env.DISCORD_BOT_TOKEN}:${env.GATEWAY_INTENTS}:${env.GATEWAY_REVISION}`,
      )))).map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (this.stored.fingerprint !== fingerprint) {
        this.stored = { session: null, identifyAfter: this.stored.identifyAfter, fatal: false, reconnectAt: 0, fingerprint };
        this.persist();
      }
    });
  }
  private persist(state = this.stored) {
    this.ctx.storage.sql.exec("INSERT INTO gateway_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(state));
  }
  async status() {
    return { connected: this.socket?.readyState === 1, connecting: this.connecting, fatal: this.stored.fatal,
      pending: this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox").one().count };
  }
  async ensureConnected() {
    if (this.env.GATEWAY_ENABLED !== "true") { this.stopSocket(); return; }
    await this.planAlarm();
    // Outbox work is independent of connection I/O and never blocks Heartbeat handling.
    this.ctx.waitUntil(this.flush());
    if (this.stored.fatal || this.socket || this.connecting || Date.now() < this.stored.reconnectAt) return;
    this.connecting = true;
    const generation = ++this.generation;
    try {
      let address = this.stored.session?.url;
      if (!this.stored.session) {
        if (Date.now() < this.stored.identifyAfter) return;
        const response = await fetch("https://discord.com/api/v10/gateway/bot", {
          headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) { this.stored.fatal = true; this.persist(); }
          const wait = response.status === 429 ? Number(response.headers.get("retry-after") ?? 60) * 1000 : 5000;
          this.stored.identifyAfter = Math.max(this.stored.identifyAfter, Date.now() + (Number.isFinite(wait) ? Math.max(1000, wait) : 60_000));
          this.persist();
          await response.body?.cancel();
          throw new Error(`Gateway discovery rejected ${Math.max(1000, wait)}`);
        }
        const body: unknown = await response.json();
        if (!record(body) || !record(body.session_start_limit) || typeof body.url !== "string" ||
          typeof body.session_start_limit.remaining !== "number" || typeof body.session_start_limit.reset_after !== "number") {
          throw new Error("Invalid Gateway discovery");
        }
        const now = Date.now();
        if (body.session_start_limit.remaining <= 0) {
          this.stored.identifyAfter = now + body.session_start_limit.reset_after;
          this.persist(); return;
        }
        // Persist a reservation before Identify so a restart cannot immediately repeat it.
        this.stored.identifyAfter = body.session_start_limit.remaining === 1 ? now + body.session_start_limit.reset_after : now + 5000;
        this.persist();
        address = body.url;
      }
      const url = gatewayUrl(address);
      if (!url) { this.stored.session = null; this.persist(); throw new Error("Invalid Gateway URL"); }
      const response = await fetch(url, { headers: { Upgrade: "websocket" }, signal: AbortSignal.timeout(15_000) });
      if (generation !== this.generation) { response.webSocket?.close(1000); return; }
      if (response.status !== 101 || !response.webSocket) { await response.body?.cancel(); throw new Error("Gateway upgrade failed"); }
      const socket = response.webSocket;
      this.socket = socket;
      const protocol = new Protocol();
      socket.accept();
      this.helloTimer = setTimeout(() => this.ctx.waitUntil(this.reconnect(generation, false)), 15_000);
      socket.addEventListener("message", event => {
        if (generation !== this.generation || typeof event.data !== "string") return;
        try {
          const payload = parsePayload(event.data);
          for (const command of protocol.consume(payload)) {
            if (command.type === "hello") {
              clearTimeout(this.helloTimer);
              this.failureCount = 0;
              this.authenticate(socket);
              this.heartbeat(socket, protocol, command.interval, generation, true);
            } else if (command.type === "heartbeat") {
              socket.send(JSON.stringify({ op: 1, d: this.stored.session?.sequence ?? null }));
            } else if (command.type === "reconnect") {
              this.ctx.waitUntil(this.reconnect(generation, command.invalidate, command.delay));
            } else {
              this.dispatch(command.payload);
            }
          }
        } catch {
          log("gateway-event-error");
          this.ctx.waitUntil(this.reconnect(generation, false));
        }
      });
      socket.addEventListener("close", event => {
        if (generation !== this.generation) return;
        const policy = closePolicy(event.code);
        if (policy.fatal) { this.stored.fatal = true; this.persist(); log("gateway-fatal", { code: event.code }); }
        this.ctx.waitUntil(this.reconnect(generation, policy.invalidate));
      });
      socket.addEventListener("error", () => { this.ctx.waitUntil(this.reconnect(generation, false)); });
      log("gateway-connected");
    } catch {
      log("gateway-connect-failed");
      if (generation === this.generation) await this.reconnect(generation, false);
    } finally { this.connecting = false; await this.planAlarm(); }
  }
  private authenticate(socket: WebSocket) {
    const session = this.stored.session;
    if (session) {
      socket.send(JSON.stringify({ op: 6, d: { token: this.env.DISCORD_BOT_TOKEN, session_id: session.id, seq: session.sequence } }));
    } else {
      socket.send(JSON.stringify({ op: 2, d: {
        token: this.env.DISCORD_BOT_TOKEN, intents: Number(this.env.GATEWAY_INTENTS),
        properties: { os: "linux", browser: "discord-pdf-preview", device: "discord-pdf-preview" },
        shard: [0, 1], compress: false,
      } }));
    }
  }
  private heartbeat(socket: WebSocket, protocol: Protocol, interval: number, generation: number, first: boolean) {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      try {
        if (!protocol.heartbeat()) { this.ctx.waitUntil(this.reconnect(generation, false)); return; }
        socket.send(JSON.stringify({ op: 1, d: this.stored.session?.sequence ?? null }));
        this.heartbeat(socket, protocol, interval, generation, false);
      } catch { this.ctx.waitUntil(this.reconnect(generation, false)); }
    }, first ? Math.floor(randomFraction() * interval) : interval);
  }
  private dispatch(payload: Payload) {
    // No await here: outbox writes and the resume cursor commit in the same SQLite transaction.
    const next = structuredClone(this.stored);
    this.ctx.storage.transactionSync(() => {
      if (payload.t === "READY" && record(payload.d) && typeof payload.d.session_id === "string" &&
        typeof payload.d.resume_gateway_url === "string" && typeof payload.s === "number") {
        if (!gatewayUrl(payload.d.resume_gateway_url)) throw new Error("Invalid resume URL");
        next.session = { id: payload.d.session_id, url: payload.d.resume_gateway_url, sequence: payload.s };
        this.failureCount = 0;
      }
      if (payload.t === "MESSAGE_CREATE") {
        for (const task of previewTasks(payload.d, Date.now())) {
          this.ctx.storage.sql.exec("INSERT INTO outbox(id,body,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
            `${task.source.messageId}:${task.attachmentId}`, JSON.stringify(task), task.source.postedAt + LIFETIME_MS);
        }
      }
      if (next.session && typeof payload.s === "number") next.session.sequence = payload.s;
      this.persist(next);
    });
    this.stored = next;
    if (payload.t === "READY" && record(payload.d)) {
      log("gateway-ready", { guildCount: Array.isArray(payload.d.guilds) ? payload.d.guilds.length : 0 });
    } else if (payload.t === "RESUMED") { log("gateway-resumed"); }
    this.ctx.waitUntil(this.flush());
  }
  private stopSocket() {
    ++this.generation;
    clearTimeout(this.heartbeatTimer); clearTimeout(this.helloTimer);
    const socket = this.socket; this.socket = null;
    // A normal 1000/1001 close invalidates Discord's resumable session.
    try { socket?.close(4000, "reconnecting"); } catch { /* already closed */ }
  }
  private async reconnect(generation: number, invalidate: boolean, delay?: number) {
    if (generation !== this.generation) return;
    this.stopSocket();
    if (invalidate) this.stored.session = null;
    this.failureCount++;
    this.stored.reconnectAt = Date.now() + (delay ?? Math.min(30_000, 1000 * 2 ** Math.min(5, this.failureCount))) + Math.floor(randomFraction() * 500);
    this.persist();
    await this.planAlarm();
  }
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      this.ctx.storage.sql.exec("DELETE FROM outbox WHERE expires_at<=?", Date.now());
      for (let i = 0; i < 100; i++) {
        const row = this.ctx.storage.sql.exec<{ id: string; body: string }>("SELECT id,body FROM outbox ORDER BY expires_at,id LIMIT 1").toArray()[0];
        if (!row) return;
        const task: PreviewTask = JSON.parse(row.body);
        if (task.source.postedAt + LIFETIME_MS > Date.now()) await this.env.PREVIEWS.send(task);
        this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id=?", row.id);
      }
    } catch { log("gateway-outbox-retry"); }
    finally { this.flushing = false; await this.planAlarm(); }
  }
  private async planAlarm() {
    if (this.env.GATEWAY_ENABLED !== "true") { await this.ctx.storage.deleteAlarm(); return; }
    const pending = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n;
    const reconnectAt = this.socket || this.stored.fatal ? Infinity : Math.max(Date.now() + 1000, this.stored.reconnectAt, this.stored.session ? 0 : this.stored.identifyAfter);
    const due = Math.min(reconnectAt, pending ? Date.now() + 5000 : Infinity);
    if (Number.isFinite(due)) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || due < current || current <= Date.now()) await this.ctx.storage.setAlarm(due);
    } else { await this.ctx.storage.deleteAlarm(); }
  }
  async alarm() { await this.ensureConnected(); }
}
