import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decode } from "@cf-wasm/png/node";
import { createFixtures } from "../spike/fixtures.mjs";

// The two local test bundles must keep their own names even inside a single
// Worker's Builds job. Actual deploy commands retain Cloudflare's CI guards.
const buildEnv = { ...process.env };
delete buildEnv.WRANGLER_CI_MATCH_TAG;
delete buildEnv.WRANGLER_CI_OVERRIDE_NAME;
execFileSync("npm", ["run", "build"], { stdio: "inherit", env: buildEnv });
async function modules(directory) {
  const root = resolve(directory);
  const files = await readdir(root);
  return { modulesRoot: root, modules: ["worker.js", ...files.filter(file => file.endsWith(".wasm"))].map(file => ({
    type: file.endsWith(".wasm") ? "CompiledWasm" : "ESModule", path: resolve(root, file),
  })) };
}
const [fixture] = await createFixtures();
const mockRoot = resolve("output/integration");
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    { name: "gateway", ...await modules("output/gateway"), compatibilityDate: "2026-10-23", compatibilityFlags: ["nodejs_compat"],
      bindings: { DISCORD_BOT_TOKEN: "test-token", GATEWAY_ENABLED: "true", GATEWAY_INTENTS: "33281", GATEWAY_REVISION: "1" },
      durableObjects: { GATEWAY: { className: "Gateway", useSQLite: true } },
      queueProducers: { PREVIEWS: "discord-pdf-previews" }, outboundService: "discord-mock" },
    { name: "preview", ...await modules("output/preview"), compatibilityDate: "2026-10-23", compatibilityFlags: ["nodejs_compat"],
      bindings: { DISCORD_BOT_TOKEN: "test-token" }, d1Databases: { DB: "preview-test" },
      queueConsumers: { "discord-pdf-previews": { maxBatchSize: 1, maxBatchTimeout: 0, maxConcurrency: 1, maxRetries: 100, retryDelay: 1 } },
      outboundService: "discord-mock" },
    { name: "discord-mock", compatibilityDate: "2026-10-23", modulesRoot: mockRoot,
      durableObjects: { MOCK: { className: "MockDiscord", useSQLite: true } }, modules: [
      { type: "ESModule", path: resolve(mockRoot, "mock.mjs"), contents: await readFile("test/discord-mock.mjs", "utf8") },
      { type: "Data", path: resolve(mockRoot, "fixture.pdf"), contents: fixture.bytes },
    ] },
  ],
}));
try {
  await mf.ready;
  const { DB } = await mf.getBindings("preview");
  const sql = await readFile("migrations/0001_preview.sql", "utf8");
  for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await DB.prepare(statement).run();
  const { GATEWAY } = await mf.getBindings("gateway");
  const gateway = GATEWAY.getByName("discord-bot");
  const mock = await mf.getWorker("discord-mock");
  const stats = async () => (await mock.fetch("https://mock.invalid/__stats")).json();
  async function waitFor(check, description, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await stats();
      if (await check(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}; ${JSON.stringify(await stats())}; gateway=${JSON.stringify(await gateway.status())}; jobs=${JSON.stringify(await DB.prepare("SELECT * FROM preview_jobs").all())}; items=${JSON.stringify(await DB.prepare("SELECT * FROM preview_items").all())}`);
  }
  await gateway.ensureConnected();
  const first = await waitFor(async value => value.reply?.attachments.length === 2 &&
    (await DB.prepare("SELECT status FROM preview_jobs WHERE source_message_id='100'").first())?.status === "complete", "two PNGs in a single reply");
  assert.equal(first.writes, 2, "Lost POST response must not cause a duplicate write");
  assert.deepEqual(first.reply.attachments.map(file => file.filename), ["same-201.png", "same-202.png"]);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM preview_jobs").first()).n, 1, "Bot posts and edits must be ignored");
  const png = new Uint8Array(await (await mock.fetch("https://mock.invalid/__png")).arrayBuffer());
  const image = decode(png);
  assert.equal(image.width, 847); assert.equal(image.height, 1200);
  assert.deepEqual(Array.from(image.image.subarray(0, 4)), [255, 255, 255, 255], "First page, not magenta second page");
  // A successful upgrade must survive the original 15-second connection deadline.
  // This failed with a lingering AbortSignal.timeout(): a healthy socket reconnected.
  const beforeIdle = await stats();
  await new Promise(resolve => setTimeout(resolve, 20_000));
  const afterIdle = await stats();
  assert.equal(afterIdle.identifies, beforeIdle.identifies, "A healthy idle connection must not Identify again");
  assert.equal(afterIdle.resumes, beforeIdle.resumes, "The upgrade timeout must not close a connected socket");
  const idleStatus = await gateway.status();
  assert.equal(idleStatus.authenticated, true);
  assert.ok(idleStatus.connectedForMs >= 20_000, "Connection age must continue beyond the upgrade deadline");
  assert.ok(idleStatus.lastHeartbeatAckAt, "Heartbeat ACKs must continue on the original connection");
  await mock.fetch("https://mock.invalid/__disconnect");
  await waitFor(value => value.resumes >= 1, "Gateway Resume");
  await mock.fetch("https://mock.invalid/__disconnect?invalidate=1");
  const final = await waitFor(value => value.identifies >= 2, "Invalid Session followed by Identify");
  await waitFor(value => value.heartbeats > 0, "Heartbeat ACK");
  assert.equal(final.writes, 2, "Replayed Gateway events must not duplicate replies");
  assert.equal((await gateway.status()).fatal, false);
  await mkdir(mockRoot, { recursive: true });
  await writeFile(resolve(mockRoot, "preview.png"), png);
  await writeFile(resolve(mockRoot, "results.json"), JSON.stringify({
    checks: ["WebSocket Identify", "MESSAGE_CREATE filtering", "Queue dispatch", "D1 migrations", "PDFium and PNG WASM",
      "lost-response recovery", "one reply with two attachments", "Heartbeat ACK", "healthy connection survives upgrade timeout", "Gateway Resume", "Invalid Session re-identification"],
    stats: await stats(),
  }, null, 2));
  console.log("Integration passed: Gateway WebSocket → Queue → D1 → WASM → one Discord reply; reconnect and uncertain-send recovery verified.");
} finally { await mf.dispose(); }
