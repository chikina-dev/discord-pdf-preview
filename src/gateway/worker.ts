import { WorkerEntrypoint } from "cloudflare:workers";
export { Gateway } from "./gateway.ts";

// Available only through an explicitly bound service entrypoint, not HTTP.
export class GatewayControl extends WorkerEntrypoint<GatewayEnv> {
  async status() { return this.env.GATEWAY.getByName("discord-bot").status(); }
  async ensureConnected() { await this.env.GATEWAY.getByName("discord-bot").ensureConnected(); }
}

export default {
  async scheduled(_event: ScheduledController, env: GatewayEnv) {
    await env.GATEWAY.getByName("discord-bot").ensureConnected();
  },
  fetch() { return new Response(null, { status: 404 }); },
} satisfies ExportedHandler<GatewayEnv>;
