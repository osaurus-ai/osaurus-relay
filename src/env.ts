// Fly.io injects these into every machine. Defaults keep local dev and tests working.
export const FLY_MACHINE_ID = Deno.env.get("FLY_MACHINE_ID") ?? "local";
export const FLY_REGION = Deno.env.get("FLY_REGION") ?? "local";
export const FLY_APP_NAME = Deno.env.get("FLY_APP_NAME") ?? "osaurus-relay";
export const BASE_DOMAIN = Deno.env.get("BASE_DOMAIN") ?? "agent.osaurus.ai";
