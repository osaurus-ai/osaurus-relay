import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _setClientForTesting,
  AGENT_TTL_SECONDS,
  claimAgent,
  claimAgents,
  FLY_MACHINE_ID,
  isRedisDegraded,
  lookupAgentInstance,
  lookupAgentInstances,
  refreshAgentsTTL,
  releaseAgent,
} from "../src/redis.ts";
import { MockRedis } from "./redis_mock.ts";

const OTHER_MACHINE = "other-machine-id";
const ADDR = "0xaabbccdd";

// Each test installs its own client at the start, so isolation only requires
// resetting the shared singleton back to null at the end of any test that set a
// mock — otherwise it would leak into other test files (which share the same
// redis.ts module instance).

// --- claimAgent(s) ---

Deno.test("claimAgent - no client: claimed locally, not degraded", async () => {
  _setClientForTesting(null);
  assertEquals(await claimAgent(ADDR), { previousOwner: null, degraded: false });
});

Deno.test("claimAgent - unclaimed key is claimed", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  assertEquals(await claimAgent(ADDR), { previousOwner: null, degraded: false });
  assertEquals(mock.store.get(`agent:${ADDR}`)?.value, FLY_MACHINE_ID);

  _setClientForTesting(null);
});

Deno.test("claimAgent - key already owned by this machine: no previous owner", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, { value: FLY_MACHINE_ID, expiresAt: Infinity });
  _setClientForTesting(mock);

  assertEquals(await claimAgent(ADDR), { previousOwner: null, degraded: false });

  _setClientForTesting(null);
});

Deno.test("claimAgent - key owned by different machine is taken over", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, { value: OTHER_MACHINE, expiresAt: Infinity });
  _setClientForTesting(mock);

  assertEquals(await claimAgent(ADDR), { previousOwner: OTHER_MACHINE, degraded: false });
  assertEquals(mock.store.get(`agent:${ADDR}`)?.value, FLY_MACHINE_ID);

  _setClientForTesting(null);
});

Deno.test("claimAgents - one pipelined round trip for a batch", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:0xbbb`, { value: OTHER_MACHINE, expiresAt: Infinity });
  _setClientForTesting(mock);

  const results = await claimAgents(["0xaaa", "0xbbb", "0xccc"]);
  assertEquals(results.map((r) => r.previousOwner), [null, OTHER_MACHINE, null]);
  for (const a of ["0xaaa", "0xbbb", "0xccc"]) {
    assertEquals(mock.store.get(`agent:${a}`)?.value, FLY_MACHINE_ID);
  }

  _setClientForTesting(null);
});

Deno.test("claimAgent - Redis error degrades instead of throwing", async () => {
  const mock = new MockRedis();
  mock.failWith = new Error("connection refused");
  _setClientForTesting(mock);

  assertEquals(isRedisDegraded(), false);
  assertEquals(await claimAgent(ADDR), { previousOwner: null, degraded: true });
  assertEquals(isRedisDegraded(), true);

  // Recovery clears the flag.
  mock.failWith = null;
  await claimAgent(ADDR);
  assertEquals(isRedisDegraded(), false);

  _setClientForTesting(null);
});

// --- releaseAgent ---

Deno.test("releaseAgent - no client does nothing", async () => {
  _setClientForTesting(null);
  await releaseAgent(ADDR); // should not throw
});

Deno.test("releaseAgent - deletes key owned by this machine", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, { value: FLY_MACHINE_ID, expiresAt: Infinity });
  _setClientForTesting(mock);

  await releaseAgent(ADDR);
  assertEquals(mock.store.has(`agent:${ADDR}`), false);

  _setClientForTesting(null);
});

Deno.test("releaseAgent - does not delete key owned by different machine", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, { value: OTHER_MACHINE, expiresAt: Infinity });
  _setClientForTesting(mock);

  await releaseAgent(ADDR);
  assertEquals(mock.store.get(`agent:${ADDR}`)?.value, OTHER_MACHINE);

  _setClientForTesting(null);
});

Deno.test("releaseAgent - does nothing when key absent", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await releaseAgent(ADDR); // should not throw
  assertEquals(mock.store.has(`agent:${ADDR}`), false);

  _setClientForTesting(null);
});

Deno.test("releaseAgent - Redis error is swallowed and flagged", async () => {
  const mock = new MockRedis();
  mock.failWith = new Error("timeout");
  _setClientForTesting(mock);

  await releaseAgent(ADDR); // must not throw
  assertEquals(isRedisDegraded(), true);

  _setClientForTesting(null);
});

// --- lookupAgentInstance(s) ---

Deno.test("lookupAgentInstance - no client returns null", async () => {
  _setClientForTesting(null);
  assertEquals(await lookupAgentInstance(ADDR), null);
});

Deno.test("lookupAgentInstance - returns machine ID when key exists", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, { value: OTHER_MACHINE, expiresAt: Infinity });
  _setClientForTesting(mock);

  assertEquals(await lookupAgentInstance(ADDR), OTHER_MACHINE);

  _setClientForTesting(null);
});

Deno.test("lookupAgentInstance - returns null when key absent", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  assertEquals(await lookupAgentInstance(ADDR), null);

  _setClientForTesting(null);
});

Deno.test("lookupAgentInstance - Redis error fails open to null", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, { value: OTHER_MACHINE, expiresAt: Infinity });
  mock.failWith = new Error("timeout");
  _setClientForTesting(mock);

  assertEquals(await lookupAgentInstance(ADDR), null);
  assertEquals(await lookupAgentInstances([ADDR, "0x1"]), [null, null]);
  assertEquals(isRedisDegraded(), true);

  _setClientForTesting(null);
});

// --- refreshAgentsTTL ---

Deno.test("refreshAgentsTTL - no client does nothing", async () => {
  _setClientForTesting(null);
  assertEquals(await refreshAgentsTTL([ADDR]), []);
});

Deno.test("refreshAgentsTTL - refreshes each owned address", async () => {
  const mock = new MockRedis();
  const addrs = ["0xaaa", "0xbbb", "0xccc"];
  for (const a of addrs) {
    mock.store.set(`agent:${a}`, { value: FLY_MACHINE_ID, expiresAt: Date.now() + 1000 });
  }
  _setClientForTesting(mock);

  const lost = await refreshAgentsTTL(addrs);
  assertEquals(lost, []);
  assertEquals(mock.expireCalls.map((c) => c.key), addrs.map((a) => `agent:${a}`));
  for (const a of addrs) {
    // TTL was pushed out from the original 1s to (roughly) the full AGENT_TTL_SECONDS.
    assertEquals(
      mock.store.get(`agent:${a}`)!.expiresAt > Date.now() + (AGENT_TTL_SECONDS - 1) * 1000,
      true,
    );
  }

  _setClientForTesting(null);
});

Deno.test("refreshAgentsTTL - reports addresses taken over by another machine", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:0xaaa`, { value: FLY_MACHINE_ID, expiresAt: Infinity });
  mock.store.set(`agent:0xbbb`, { value: OTHER_MACHINE, expiresAt: Infinity });
  _setClientForTesting(mock);

  const lost = await refreshAgentsTTL(["0xaaa", "0xbbb"]);
  assertEquals(lost, ["0xbbb"]);
  // Never extends another machine's claim.
  assertEquals(mock.store.get(`agent:0xbbb`)?.value, OTHER_MACHINE);

  _setClientForTesting(null);
});

Deno.test("refreshAgentsTTL - re-claims a key that expired while we still hold the tunnel", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  const lost = await refreshAgentsTTL(["0xaaa"]);
  assertEquals(lost, []);
  assertEquals(mock.store.get(`agent:0xaaa`)?.value, FLY_MACHINE_ID);

  _setClientForTesting(null);
});

Deno.test("refreshAgentsTTL - empty iterable does nothing", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  assertEquals(await refreshAgentsTTL([]), []);
  assertEquals(mock.expireCalls.length, 0);

  _setClientForTesting(null);
});

Deno.test("refreshAgentsTTL - Redis error returns nothing lost", async () => {
  const mock = new MockRedis();
  mock.failWith = new Error("timeout");
  _setClientForTesting(mock);

  assertEquals(await refreshAgentsTTL(["0xaaa"]), []);
  assertEquals(isRedisDegraded(), true);

  _setClientForTesting(null);
});
