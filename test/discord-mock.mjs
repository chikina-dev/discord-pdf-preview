import pdf from "./fixture.pdf";
import { DurableObject } from "cloudflare:workers";

const pdfs = ["201", "202"].map(id => ({ id, filename: "same.pdf", size: pdf.byteLength,
  url: `https://cdn.discordapp.com/attachments/200/${id}/same.pdf`, content_type: "application/pdf" }));
const source = { id: "100", channel_id: "200", guild_id: "400", timestamp: new Date().toISOString(),
  author: { id: "300", bot: false }, attachments: pdfs };
let reply = null, socket = null, writes = 0, identifies = 0, resumes = 0, heartbeats = 0;
let invalidate = false;
let firstPng = null;
let lostFirstResponse = true;
const routes = [];

export class MockDiscord extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json({ writes, identifies, resumes, heartbeats, reply, postedAt: source.timestamp, pdfSize: pdf.byteLength, routes });
    if (url.pathname === "/__png") return new Response(firstPng, { headers: { "Content-Type": "image/png" } });
    if (url.pathname === "/__disconnect") {
      invalidate = url.searchParams.has("invalidate");
      socket?.close(4000, "test disconnect");
      return new Response("ok");
    }
    routes.push(`${request.method} ${url.pathname}`);
    if (url.hostname === "cdn.discordapp.com") return new Response(pdf);
    if (url.pathname === "/api/v10/gateway/bot") return Response.json({
      url: "wss://gateway.discord.gg", session_start_limit: { remaining: 100, reset_after: 86_400_000 },
    });
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      socket = pair[1]; const active = socket;
      active.accept();
      active.addEventListener("message", event => {
        const frame = JSON.parse(event.data);
        if (frame.op === 2) {
          identifies++;
          source.timestamp = new Date().toISOString();
          active.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "mock-session", resume_gateway_url: "wss://gateway.discord.gg" } }));
          active.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: source }));
          active.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: source }));
          active.send(JSON.stringify({ op: 0, t: "MESSAGE_UPDATE", s: 3, d: source }));
          active.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { ...source, id: "101", author: { id: "999", bot: true } } }));
        } else if (frame.op === 6) {
          resumes++;
          if (invalidate) { invalidate = false; active.send(JSON.stringify({ op: 9, d: false })); }
          else active.send(JSON.stringify({ op: 0, t: "RESUMED", s: 5, d: {} }));
        } else if (frame.op === 1) {
          heartbeats++; active.send(JSON.stringify({ op: 11, d: null }));
        }
      });
      active.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.headers.get("Authorization") !== "Bot test-token") throw new Error("Missing Bot authentication");
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "999" });
    if (url.pathname.endsWith("/messages/100")) return Response.json(source);
    if (url.searchParams.has("limit")) return Response.json(reply ? [reply] : []);
    if (request.method === "POST" || request.method === "PATCH") {
      const form = await request.formData();
      const payload = JSON.parse(form.get("payload_json"));
      const file = form.get("files[0]");
      const bytes = await file.arrayBuffer();
      const header = new Uint8Array(bytes, 0, 8);
      if (header.join(",") !== "137,80,78,71,13,10,26,10") throw new Error("Not a real PNG");
      const view = new DataView(bytes);
      if (view.getUint32(16) !== 847 || view.getUint32(20) !== 1200) throw new Error("Unexpected PNG dimensions");
      firstPng ??= bytes;
      writes++;
      if (!reply) {
        if (request.method !== "POST" || !payload.message_reference.fail_if_not_exists) throw new Error("Missing reply reference");
        reply = { id: "500", author: { id: "999", bot: true }, message_reference: { message_id: "100" }, attachments: [] };
      } else if (request.method !== "PATCH") throw new Error("Duplicate reply");
      reply.attachments = payload.attachments.map(item => item.id === 0
        ? { id: String(600 + writes), filename: item.filename }
        : reply.attachments.find(file => file.id === item.id));
      if (reply.attachments.some(item => !item)) throw new Error("Lost retained attachment");
      // Discord accepted the write but its success response was lost.
      if (lostFirstResponse) { lostFirstResponse = false; return Response.json({ message: "upstream response lost" }, { status: 502 }); }
      return Response.json(reply);
    }
    if (url.pathname.endsWith("/messages/500")) return Response.json(reply);
    return new Response("not found", { status: 404 });
  }
}
export default {
  fetch(request, env) { return env.MOCK.getByName("discord").fetch(request); },
};
