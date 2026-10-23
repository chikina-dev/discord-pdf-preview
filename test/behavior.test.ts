import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { previewTasks } from "../src/gateway/events.ts";
import { Protocol, closePolicy, gatewayUrl, parsePayload } from "../src/gateway/protocol.ts";
import { LIFETIME_MS, isTask, outputName, type PreviewTask } from "../src/shared/task.ts";
import { processTask } from "../src/preview/process.ts";
import { State, cleanup } from "../src/preview/state.ts";

const start = Date.parse("2026-10-23T00:00:00Z");
function task(count = 1, attachmentId = "201"): PreviewTask {
  return { version: 1, source: { messageId: "100", channelId: "200", postedAt: start }, attachmentId,
    pdfs: Array.from({ length: count }, (_, i) => ({ id: String(201 + i), filename: "same.pdf", sourceIndex: i,
      size: 100, url: `https://cdn.discordapp.com/attachments/200/${201 + i}/same.pdf?ex=123` })) };
}

// Exercise the real production SQL using SQLite, rather than mocking state transitions.
class SqliteD1 {
  sqlite = new DatabaseSync(":memory:");
  failCommit = false;
  constructor() { this.sqlite.exec(readFileSync("migrations/0001_preview.sql", "utf8")); }
  prepare(sql: string) {
    const sqlite = this.sqlite;
    function statement(values: unknown[] = []) {
      return {
        sql,
        bind(...args: unknown[]) { return statement(args); },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
      };
    }
    return statement();
  }
  async batch(statements: ReturnType<SqliteD1["prepare"]>[]) {
    if (this.failCommit && statements.some(s => s.sql.includes("status='sent'"))) { this.failCommit = false; throw new Error("injected DB failure"); }
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  get db() { return this as unknown as D1Database; }
}

function harness(count = 1) {
  const store = new SqliteD1();
  let now = start + 1000;
  let reply: { id: string; author: { id: string }; attachments: { id: string; filename: string }[]; message_reference: { message_id: string } } | null = null;
  let uploads = 0, renders = 0, sourceReads = 0;
  const payloads: Record<string, unknown>[] = [];
  const edges: number[] = [];
  const failures: { cdn?: number; write?: "lost-success" | "lost-failure" | "rate" | "size"; deleteOnRead?: number; afterSuccessDb?: boolean } = {};
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "cdn.discordapp.com") {
      if (failures.cdn) { const code = failures.cdn; delete failures.cdn; return new Response("cdn error", { status: code }); }
      return new Response("test pdf");
    }
    assert.equal(url.hostname, "discord.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bot test-token");
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "999" });
    if (url.searchParams.has("limit")) return Response.json(reply ? [reply] : []);
    if (init?.method === "POST" || init?.method === "PATCH") {
      uploads++;
      const form = init.body as FormData;
      const payload = JSON.parse(String(form.get("payload_json")));
      payloads.push(payload);
      assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
      if (failures.write === "rate") { delete failures.write; return Response.json({ retry_after: 2, global: true }, { status: 429 }); }
      if (failures.write === "size") { delete failures.write; return Response.json({ code: 40005 }, { status: 413 }); }
      if (failures.write === "lost-failure") { delete failures.write; throw new Error("connection lost"); }
      if (!reply) {
        assert.equal(init.method, "POST");
        assert.equal(payload.message_reference.fail_if_not_exists, true);
        assert.equal(payload.enforce_nonce, true);
        reply = { id: "500", author: { id: "999" }, attachments: [], message_reference: { message_id: "100" } };
      } else { assert.equal(init.method, "PATCH"); }
      reply.attachments = payload.attachments.map((file: { id: string | number; filename?: string }) => file.id === 0
        ? { id: String(600 + uploads), filename: file.filename! }
        : reply!.attachments.find(a => a.id === file.id)!);
      assert.ok(reply.attachments.every(Boolean), "Existing attachments must be retained");
      if (failures.afterSuccessDb) { failures.afterSuccessDb = false; store.failCommit = true; }
      if (failures.write === "lost-success") { delete failures.write; throw new Error("response lost after success"); }
      return Response.json(reply);
    }
    if (url.pathname.endsWith("/messages/500")) return reply ? Response.json(reply) : new Response("{}", { status: 404 });
    if (url.pathname.endsWith("/messages/100")) {
      sourceReads++;
      if (failures.deleteOnRead && sourceReads >= failures.deleteOnRead) return Response.json({ code: 10008 }, { status: 404 });
      return Response.json({ id: "100", author: { id: "300" }, attachments: task(count).pdfs });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const dep = {
    fetch: fetcher as typeof fetch, now: () => now,
    render: async (_bytes: Uint8Array, edge: number) => { renders++; edges.push(edge); return new Uint8Array([137, 80, 78, 71]); },
  };
  const run = (id = "201", attempts = 1) => processTask(task(count, id), store.db, "test-token", attempts, dep);
  const state = () => new State(store.db, "100", "observer", dep.now);
  return { store, failures, dep, run, state, payloads, edges, tick: (ms: number) => { now += ms; },
    get uploads() { return uploads; }, get renders() { return renders; }, get reply() { return reply; } };
}

test("filter Gateway messages, accept PDFs without a bot-specific size limit", () => {
  const t = task(2);
  const message = { id: "100", channel_id: "200", author: { id: "300" }, timestamp: new Date(start).toISOString(), attachments: t.pdfs };
  assert.equal(previewTasks(message, start + 1).length, 2);
  assert.equal(previewTasks({ ...message, author: { bot: true } }, start + 1).length, 0);
  assert.equal(previewTasks({ ...message, webhook_id: "7" }, start + 1).length, 0);
  assert.equal(previewTasks(message, start + LIFETIME_MS).length, 0);
  assert.equal(previewTasks({ ...message, attachments: [{ ...t.pdfs[0], size: 500_000_000 }] }, start + 1).length, 1);
  assert.equal(previewTasks({ ...message, attachments: [{ ...t.pdfs[0], url: "https://evil.example/a.pdf" }] }, start + 1).length, 0);
  assert.ok(isTask(t));
  assert.notEqual(outputName(t.pdfs[0]), outputName(t.pdfs[1]));
});

test("Gateway detects missed ACK, handles Invalid Session and fatal close codes", () => {
  const protocol = new Protocol();
  assert.deepEqual(protocol.consume({ op: 10, d: { heartbeat_interval: 40_000 } }), [{ type: "hello", interval: 40_000 }]);
  assert.equal(protocol.heartbeat(), true);
  assert.equal(protocol.heartbeat(), false);
  protocol.consume({ op: 11, d: null });
  assert.equal(protocol.heartbeat(), true);
  const invalid = protocol.consume({ op: 9, d: false })[0];
  assert.equal(invalid.type, "reconnect");
  if (invalid.type === "reconnect") assert.equal(invalid.invalidate, true);
  assert.equal(closePolicy(4014).fatal, true);
  assert.equal(closePolicy(4009).invalidate, true);
  assert.ok(gatewayUrl("wss://gateway-us-east1-b.discord.gg"));
  assert.equal(gatewayUrl("wss://discord.gg.evil.example"), null);
});

test("real Discord control frames accept null sequence and event name", () => {
  const protocol = new Protocol();
  const hello = parsePayload(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }));
  assert.deepEqual(protocol.consume(hello), [{ type: "hello", interval: 41250 }]);
  protocol.heartbeat();
  protocol.consume(parsePayload(JSON.stringify({ op: 11, d: null, s: null, t: null })));
  assert.equal(protocol.acknowledged, true);
});

test("two attachments create exactly one reply, retain both images in source order", async () => {
  const h = harness(2);
  await h.run("202"); await h.run("201"); await h.run("202");
  assert.equal(h.uploads, 2);
  assert.deepEqual(h.reply!.attachments.map(a => a.filename), ["same-201.png", "same-202.png"]);
  assert.equal((await h.state().job())?.status, "complete");
});

test("only a transiently failed PDF is retried; another can send immediately", async () => {
  const h = harness(2); h.failures.cdn = 503;
  assert.equal((await h.run()).retrySeconds, 5);
  await h.run("202");
  assert.equal(h.reply!.attachments.length, 1);
  h.tick(5000); await h.run("201", 2);
  assert.equal(h.uploads, 2);
  assert.equal(h.reply!.attachments.length, 2);
});

test("lost POST response is reconciled without a second POST", async () => {
  const h = harness(); h.failures.write = "lost-success";
  assert.equal((await h.run()).retrySeconds, 1);
  h.tick(1000); await h.run();
  assert.equal(h.uploads, 1);
  assert.equal((await h.state().item("201"))?.status, "sent");
});

test("unresolvable POST result stops the job without resending", async () => {
  const h = harness(); h.failures.write = "lost-failure";
  await h.run(); h.tick(1000); await h.run(); await h.run();
  assert.equal(h.uploads, 1);
  assert.equal((await h.state().job())?.status, "delivery_unknown");
});

test("lost PATCH response is reconciled and existing image survives", async () => {
  const h = harness(2); await h.run(); h.failures.write = "lost-success";
  await h.run("202"); h.tick(1000); await h.run("202");
  assert.equal(h.uploads, 2);
  assert.equal(h.reply!.attachments.length, 2);
  assert.equal((await h.state().job())?.status, "complete");
});

test("D1 failure after Discord success does not cause duplicate delivery", async () => {
  const h = harness(); h.failures.afterSuccessDb = true;
  await assert.rejects(h.run(), /injected DB failure/);
  await h.run();
  assert.equal(h.uploads, 1);
  assert.equal((await h.state().job())?.status, "complete");
});

test("deadline during rendering prevents all writes", async () => {
  const h = harness();
  h.dep.render = async () => { h.tick(LIFETIME_MS); return new Uint8Array([1]); };
  await h.run();
  assert.equal(h.uploads, 0);
  assert.equal((await h.state().job())?.status, "expired");
});

test("source deleted between conversion and send cancels instead of posting normally", async () => {
  const h = harness(); h.failures.deleteOnRead = 2;
  await h.run();
  assert.equal(h.uploads, 0);
  assert.equal((await h.state().job())?.status, "cancelled");
});

test("429 records a global cooldown and waits before other tasks", async () => {
  const h = harness(2); h.failures.write = "rate";
  assert.equal((await h.run()).retrySeconds, 2);
  assert.equal((await h.run("202")).retrySeconds, 2);
  assert.equal(h.uploads, 1);
  h.tick(2000); await h.run("202"); await h.run();
  assert.equal(h.reply!.attachments.length, 2);
});

test("a size rejection triggers smaller rendering, ordinary failure does not", async () => {
  const h = harness(); h.failures.write = "size";
  await h.run();
  assert.deepEqual(h.edges, [1200, 900]);
  assert.equal((await h.state().job())?.status, "complete");
});

test("rendering failure is silent and does not block other attachments", async () => {
  const h = harness(2);
  const original = h.dep.render;
  h.dep.render = async () => { throw new Error("password protected"); };
  await h.run();
  assert.equal(h.uploads, 0);
  h.dep.render = original; await h.run("202");
  assert.equal(h.reply!.attachments.length, 1);
  assert.equal((await h.state().job())?.status, "complete");
});

test("a lease fences stale consumers, including send reservations", async () => {
  const h = harness();
  const a = new State(h.store.db, "100", "a", h.dep.now), b = new State(h.store.db, "100", "b", h.dep.now);
  await a.initialize(task()); assert.equal(await a.claim(), true); assert.equal(await b.claim(), false);
  h.tick(120_001); assert.equal(await b.claim(), true);
  await assert.rejects(a.begin("201", "preview.png", "create"));
  assert.ok(await b.begin("201", "preview.png", "create"));
});

test("cleanup removes expired job metadata; a late task cannot recreate it", async () => {
  const h = harness(); await h.run(); h.tick(86_400_000 + LIFETIME_MS);
  await cleanup(h.store.db, h.dep.now());
  assert.equal(await h.state().job(), null);
  await h.run(); assert.equal(await h.state().job(), null); assert.equal(h.uploads, 1);
});
