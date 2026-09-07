import { Redis } from "ioredis";
import { FLY_MACHINE_ID } from "./env.ts";
import { log } from "./observability.ts";

export { FLY_MACHINE_ID };

export const AGENT_TTL_SECONDS = 120;

const REDIS_URL = Deno.env.get("REDIS_URL");

// Minimal surface we use from ioredis, so tests can substitute a mock.
export interface RedisLike {
  set(
    key: string,
    value: string,
    ex: "EX",
    ttl: number,
    get: "GET",
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  pipeline(): PipelineLike;
}

export interface PipelineLike {
  set(key: string, value: string, ex: "EX", ttl: number, get: "GET"): PipelineLike;
  eval(script: string, numKeys: number, ...args: (string | number)[]): PipelineLike;
  exec(): Promise<[Error | null, unknown][] | null>;
}

let client: RedisLike | null = null;

if (REDIS_URL) {
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: false,
  }) as unknown as RedisLike;
  // ioredis emits 'error' events on connection trouble; without a listener they become
  // uncaught exceptions.
  (client as unknown as { on: (ev: string, fn: (e: Error) => void) => void }).on(
    "error",
    (e) => noteFailure("connection", e),
  );
}

// deno-lint-ignore no-explicit-any
export function _setClientForTesting(c: any): void {
  client = c;
  degraded = false;
}

export function hasRedis(): boolean {
  return client !== null;
}

// --- Degrade policy -------------------------------------------------------------------------
//
// Redis is a coordination aid, not the source of truth for a live tunnel. When it is unreachable
// we keep serving from the in-memory map, skip cross-machine claims, and flag the condition on
// /health so the outage is visible. We never let a Redis error propagate into a WebSocket or
// HTTP handler.

let degraded = false;
let lastFailureAt = 0;
const FAILURE_LOG_INTERVAL_MS = 10_000;

export function isRedisDegraded(): boolean {
  return degraded;
}

function noteFailure(op: string, err: unknown): void {
  const now = Date.now();
  if (!degraded || now - lastFailureAt > FAILURE_LOG_INTERVAL_MS) {
    log("warn", "redis.error", { op, error: err instanceof Error ? err.message : String(err) });
  }
  degraded = true;
  lastFailureAt = now;
}

function noteSuccess(): void {
  if (degraded) log("info", "redis.recovered", {});
  degraded = false;
}

function agentKey(address: string): string {
  return `agent:${address}`;
}

// --- Lua scripts ----------------------------------------------------------------------------
//
// Each script compares the stored owner to ARGV[1] before mutating, so a machine can never
// delete or extend a claim that has since been taken over by another machine.

/** KEYS[1]=agent key, ARGV[1]=my machine id. Returns 1 if deleted, 0 otherwise. */
export const COMPARE_AND_DELETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** KEYS[1]=agent key, ARGV[1]=my machine id, ARGV[2]=ttl seconds. Returns 1 if refreshed. */
export const COMPARE_AND_EXPIRE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;

// --- Claims ---------------------------------------------------------------------------------

export interface ClaimResult {
  /** Previous owner machine id, if the address was held by another machine. */
  previousOwner: string | null;
  /** True when Redis was unavailable and the claim was recorded locally only. */
  degraded: boolean;
}

/**
 * Claims ownership of agent addresses for this machine, taking over from any previous owner.
 * A fresh authenticated tunnel is proof of key possession, so the newest connection wins; the
 * previous owner is returned so the caller can decide how to notify it.
 *
 * `SET key value EX ttl GET` is atomic and returns the prior value (null when unclaimed).
 */
export async function claimAgents(addresses: string[]): Promise<ClaimResult[]> {
  if (addresses.length === 0) return [];
  if (!client) return addresses.map(() => ({ previousOwner: null, degraded: false }));
  try {
    const pipe = client.pipeline();
    for (const address of addresses) {
      pipe.set(agentKey(address), FLY_MACHINE_ID, "EX", AGENT_TTL_SECONDS, "GET");
    }
    const results = await pipe.exec();
    if (!results) throw new Error("pipeline returned null");
    noteSuccess();
    return results.map(([err, prev]) => {
      if (err) throw err;
      const previous = typeof prev === "string" ? prev : null;
      return {
        previousOwner: previous !== null && previous !== FLY_MACHINE_ID ? previous : null,
        degraded: false,
      };
    });
  } catch (err) {
    noteFailure("claim", err);
    return addresses.map(() => ({ previousOwner: null, degraded: true }));
  }
}

export async function claimAgent(address: string): Promise<ClaimResult> {
  const [result] = await claimAgents([address]);
  return result;
}

/** Releases ownership of an agent address, only if this machine still holds it. */
export async function releaseAgent(address: string): Promise<void> {
  if (!client) return;
  try {
    await client.eval(COMPARE_AND_DELETE, 1, agentKey(address), FLY_MACHINE_ID);
    noteSuccess();
  } catch (err) {
    noteFailure("release", err);
  }
}

/**
 * Looks up which machine owns an agent address. Returns null when unclaimed or when Redis is
 * unavailable (callers then answer from local state only).
 */
export async function lookupAgentInstance(address: string): Promise<string | null> {
  if (!client) return null;
  try {
    const owner = await client.get(agentKey(address));
    noteSuccess();
    return owner;
  } catch (err) {
    noteFailure("lookup", err);
    return null;
  }
}

/**
 * Batch ownership lookup (presence): one MGET for many addresses. Position i is the owning
 * machine id for addresses[i], or null when unclaimed / Redis unavailable.
 */
export async function lookupAgentInstances(addresses: string[]): Promise<(string | null)[]> {
  if (!client || addresses.length === 0) return addresses.map(() => null);
  try {
    const owners = await client.mget(addresses.map(agentKey));
    noteSuccess();
    return owners;
  } catch (err) {
    noteFailure("mget", err);
    return addresses.map(() => null);
  }
}

/**
 * Refreshes the TTL of every claim this machine still owns, in one pipelined round trip.
 * Returns the addresses whose claim now belongs to another machine (takeover happened elsewhere)
 * so the caller can drop its stale local registration. Empty when Redis is unavailable.
 */
export async function refreshAgentsTTL(addresses: Iterable<string>): Promise<string[]> {
  const list = Array.from(addresses);
  if (!client || list.length === 0) return [];
  try {
    const pipe = client.pipeline();
    for (const address of list) {
      pipe.eval(COMPARE_AND_EXPIRE, 1, agentKey(address), FLY_MACHINE_ID, AGENT_TTL_SECONDS);
    }
    const results = await pipe.exec();
    if (!results) throw new Error("pipeline returned null");
    noteSuccess();
    const unrefreshed: string[] = [];
    results.forEach(([err, refreshed], i) => {
      if (err) throw err;
      if (refreshed === 0) unrefreshed.push(list[i]);
    });
    if (unrefreshed.length === 0) return [];

    // 0 means the key is gone (expired during a Redis outage) or owned by another machine
    // (takeover). Tell them apart: re-claim the former, report the latter.
    const owners = await client.mget(unrefreshed.map(agentKey));
    const lost: string[] = [];
    const reclaim: string[] = [];
    owners.forEach((owner, i) => {
      if (owner === null) reclaim.push(unrefreshed[i]);
      else if (owner !== FLY_MACHINE_ID) lost.push(unrefreshed[i]);
    });
    if (reclaim.length > 0) {
      const pipe2 = client.pipeline();
      for (const address of reclaim) {
        pipe2.set(agentKey(address), FLY_MACHINE_ID, "EX", AGENT_TTL_SECONDS, "GET");
      }
      await pipe2.exec();
    }
    return lost;
  } catch (err) {
    noteFailure("refresh", err);
    return [];
  }
}
