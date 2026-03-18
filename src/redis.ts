import { Redis } from "ioredis";

const AGENT_TTL_SECONDS = 120;

export const FLY_MACHINE_ID = Deno.env.get("FLY_MACHINE_ID") ?? "local";

const REDIS_URL = Deno.env.get("REDIS_URL");

let client: Redis | null = null;

if (REDIS_URL) {
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

// deno-lint-ignore no-explicit-any
export function _setClientForTesting(c: any): void {
  client = c;
}

function agentKey(address: string): string {
  return `agent:${address}`;
}

/**
 * Attempt to claim ownership of an agent address for this machine.
 * Returns false if the address is already owned by a different instance.
 * Throws on Redis errors — callers should surface this as an auth failure.
 *
 * SET key value EX ttl NX GET is atomic:
 *   null     → key was newly set (claimed)
 *   our ID   → key already ours (NX skipped the write, still own it)
 *   other ID → owned by a different instance
 */
export async function claimAgent(address: string): Promise<boolean> {
  if (!client) return true;
  const prev = await client.set(
    agentKey(address),
    FLY_MACHINE_ID,
    "EX",
    AGENT_TTL_SECONDS,
    "NX",
    "GET",
  );
  return prev === null || prev === FLY_MACHINE_ID;
}

/**
 * Release ownership of an agent address (only if owned by this machine).
 */
export async function releaseAgent(address: string): Promise<void> {
  if (!client) return;
  const current = await client.get(agentKey(address));
  if (current === FLY_MACHINE_ID) {
    await client.del(agentKey(address));
  }
}

/**
 * Look up which machine instance owns an agent address.
 * Returns null if unclaimed.
 */
export async function lookupAgentInstance(
  address: string,
): Promise<string | null> {
  if (!client) return null;
  return await client.get(agentKey(address));
}

/**
 * Refresh TTL for all given agent keys (fire-and-forget, call on keepalive pong).
 */
export function refreshAgentsTTL(addresses: Iterable<string>): void {
  if (!client) return;
  for (const address of addresses) {
    client.expire(agentKey(address), AGENT_TTL_SECONDS);
  }
}
