import { record } from "../shared/task.ts";

export type Session = { id: string; url: string; sequence: number };
export type Payload = { op: number; d: unknown; s?: number | null; t?: string };
export type Command =
  | { type: "hello"; interval: number }
  | { type: "heartbeat" }
  | { type: "reconnect"; invalidate: boolean; delay: number }
  | { type: "dispatch"; payload: Payload };

export function parsePayload(raw: string): Payload {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || typeof value.op !== "number" || !("d" in value) ||
    (value.s !== undefined && value.s !== null && !Number.isInteger(value.s)) ||
    (value.t !== undefined && value.t !== null && typeof value.t !== "string")) throw new Error("Invalid Gateway payload");
  return { op: value.op, d: value.d, ...(typeof value.s === "number" ? { s: value.s } : {}),
    ...(typeof value.t === "string" ? { t: value.t } : {}) };
}
export class Protocol {
  acknowledged = true;
  helloReceived = false;
  consume(payload: Payload): Command[] {
    switch (payload.op) {
      case 10:
        if (this.helloReceived || !record(payload.d) || typeof payload.d.heartbeat_interval !== "number" || payload.d.heartbeat_interval < 1000) {
          return [{ type: "reconnect", invalidate: false, delay: 1000 }];
        }
        this.helloReceived = true;
        return [{ type: "hello", interval: payload.d.heartbeat_interval }];
      case 11: this.acknowledged = true; return [];
      case 1: return [{ type: "heartbeat" }];
      case 7: return [{ type: "reconnect", invalidate: false, delay: 1000 }];
      case 9: return [{ type: "reconnect", invalidate: payload.d !== true, delay: 1000 + randomFraction() * 4000 }];
      case 0: return [{ type: "dispatch", payload }];
      default: return [];
    }
  }
  heartbeat() {
    if (!this.acknowledged) return false;
    this.acknowledged = false;
    return true;
  }
}
export function randomFraction() { return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; }
export function closePolicy(code: number) {
  return { fatal: [4004, 4010, 4011, 4012, 4013, 4014].includes(code), invalidate: [4007, 4009].includes(code) };
}
export function gatewayUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:" || url.username || url.password || url.port ||
      !(url.hostname === "gateway.discord.gg" || url.hostname.endsWith(".discord.gg"))) return null;
    url.protocol = "https:";
    url.search = "?v=10&encoding=json";
    return url.href;
  } catch { return null; }
}
