export { Gateway } from "./gateway.ts";

export default {
  async scheduled(_event: ScheduledController, env: GatewayEnv) {
    await env.GATEWAY.getByName("discord-bot").ensureConnected();
  },
  fetch() { return new Response(null, { status: 404 }); },
} satisfies ExportedHandler<GatewayEnv>;
