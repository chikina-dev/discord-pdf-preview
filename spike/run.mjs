import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decode } from "@cf-wasm/png/node";
import { createFixtures } from "./fixtures.mjs";

const output = resolve("spike/output");
await mkdir(output, { recursive: true });
execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--config", "spike/wrangler.jsonc", "--dry-run", "--outdir", "output/bundle"], {
  env: { ...process.env, WRANGLER_LOG_PATH: "/tmp/discord-pdf-wrangler-logs" }, stdio: "inherit",
});
const bundle = resolve(output, "bundle");
const files = await readdir(bundle);
const fixtures = await createFixtures();
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
  name: "pdf-spike",
  compatibilityDate: "2026-10-23",
  compatibilityFlags: ["nodejs_compat"],
  modulesRoot: bundle,
  modules: ["worker.js", ...files.filter(name => name.endsWith(".wasm"))].map(name => ({
    type: name.endsWith(".wasm") ? "CompiledWasm" : "ESModule", path: resolve(bundle, name),
  })),
  }],
  inspectorPort: 0,
}));

let socket;
try {
  await mf.ready;
  await mf.dispatchFetch("http://localhost/");
  const inspector = await mf.getInspectorURL();
  inspector.protocol = "http:";
  const targets = await fetch(new URL("/json/list", inspector)).then(r => r.json());
  console.log("Inspector targets:", targets.map(t => ({ id: t.id, title: t.title })));
  const target = targets.find(t => t.id?.includes("pdf-spike") || t.title?.includes("pdf-spike"));
  if (!target) throw new Error("No pdf-spike inspector target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => reject(new Error(`Inspector timeout: ${method}`)), 15_000);
      pending.set(requestId, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  await cdp("Profiler.enable");
  await cdp("Profiler.setSamplingInterval", { interval: 100 });
  const results = [];
  for (const fixture of fixtures) {
    await writeFile(resolve(output, `${fixture.name}.pdf`), fixture.bytes);
    for (const run of ["first", "repeat-1", "repeat-2"]) {
      await cdp("Profiler.start");
      const started = performance.now();
      const response = await mf.dispatchFetch("http://localhost/?longEdge=1200", {
        method: "POST", body: fixture.bytes, headers: { "Content-Type": "application/pdf" },
      });
      const png = new Uint8Array(await response.arrayBuffer());
      const elapsedMs = performance.now() - started;
      const { profile } = await cdp("Profiler.stop");
      assert.equal(response.status, 200, new TextDecoder().decode(png.subarray(0, 800)));
      const decoded = decode(png);
      assert.equal(decoded.width, 847);
      assert.equal(decoded.height, 1200);
      if (fixture.name === "text-two-pages") {
        assert.deepEqual(Array.from(decoded.image.subarray(0, 4)), [255, 255, 255, 255], "Must render the first page, not the magenta second page");
      }
      const nodes = new Map(profile.nodes.map(node => [node.id, node]));
      let sampledActiveUs = 0;
      for (let i = 0; i < (profile.samples ?? []).length; i++) {
        const name = nodes.get(profile.samples[i])?.callFrame.functionName;
        if (name !== "(idle)" && name !== "(program)" && name !== "(root)") sampledActiveUs += profile.timeDeltas[i];
      }
      const heap = await cdp("Runtime.getHeapUsage");
      const result = {
        fixture: fixture.name, run, pdfBytes: fixture.bytes.length, pngBytes: png.length,
        width: decoded.width, height: decoded.height,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        sampledActiveMs: Number((sampledActiveUs / 1000).toFixed(2)),
        pdfiumWasmBytes: Number(response.headers.get("X-Pdfium-Memory-Bytes")),
        pngWasmBytes: Number(response.headers.get("X-Png-Memory-Bytes")),
        rgbaBytes: Number(response.headers.get("X-Rgba-Bytes")),
        inspectorHeap: heap,
      };
      results.push(result);
      console.log(JSON.stringify(result));
      await writeFile(resolve(output, `${fixture.name}-${run}.cpuprofile`), JSON.stringify(profile));
      if (run === "first") await writeFile(resolve(output, `${fixture.name}.png`), png);
    }
  }
  const service = await mf.getWorker("pdf-spike");
  const queueResult = await service.queue("preview-spike", [{
    id: "text-pdf", timestamp: new Date(), attempts: 1,
    body: { pdf: fixtures[0].bytes.slice().buffer },
  }]);
  assert.equal(queueResult.outcome, "ok");
  assert.deepEqual(queueResult.explicitAcks, ["text-pdf"]);
  console.log("Queue result:", queueResult);
  const stress = [];
  for (let iteration = 0; iteration < 20; iteration++) {
    const response = await mf.dispatchFetch("http://localhost/", {
      method: "POST", body: fixtures[2].bytes,
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    stress.push({
      iteration,
      pdfiumWasmBytes: Number(response.headers.get("X-Pdfium-Memory-Bytes")),
      pngWasmBytes: Number(response.headers.get("X-Png-Memory-Bytes")),
      heap: await cdp("Runtime.getHeapUsage"),
    });
  }
  const heapAfterStress = await cdp("Runtime.getHeapUsage");
  console.log("After 20 image-PDF conversions (natural GC only):", heapAfterStress);
  await writeFile(resolve(output, "results.json"), JSON.stringify({
    recordedAt: new Date().toISOString(),
    note: "Local workerd only. Elapsed time and sampled V8 activity are not Cloudflare billed CPU. WASM buffers and heap snapshots do not establish peak isolate memory or Free-plan enforcement.",
    versions: {
      pdfium: "3.0.0", png: "0.4.0", miniflare: "5.20261019.2-beta",
      workerd: "1.20261019.1", compatibilityDate: "2026-10-23",
    },
    results, queueResult, stress, heapAfterStress,
  }, null, 2));
} finally {
  socket?.close();
  await mf.dispose();
}
