import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _setClientForTesting,
  claimAgent,
  FLY_MACHINE_ID,
  lookupAgentInstance,
  refreshAgentsTTL,
  releaseAgent,
} from "../src/redis.ts";
import { MockRedis } from "./redis_mock.ts";

const OTHER_MACHINE = "other-machine-id";
const ADDR = "0xaabbccdd";

// --- claimAgent ---
Deno.test.afterEach(() => {
  _setClientForTesting(null);
});

Deno.test("claimAgent - no client returns true", async () => {
  _setClientForTesting(null);
  assertEquals(await claimAgent(ADDR), true);
});

Deno.test("claimAgent - unclaimed key is claimed", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  assertEquals(await claimAgent(ADDR), true);
  assertEquals(mock.store.get(`agent:${ADDR}`)?.value, FLY_MACHINE_ID);
});

Deno.test(
  "claimAgent - key already owned by this machine returns true",
  async () => {
    const mock = new MockRedis();
    mock.store.set(`agent:${ADDR}`, {
      value: FLY_MACHINE_ID,
      expiresAt: Infinity,
    });
    _setClientForTesting(mock);

    assertEquals(await claimAgent(ADDR), true);
  },
);

Deno.test(
  "claimAgent - key owned by different machine returns false",
  async () => {
    const mock = new MockRedis();
    mock.store.set(`agent:${ADDR}`, {
      value: OTHER_MACHINE,
      expiresAt: Infinity,
    });
    _setClientForTesting(mock);

    assertEquals(await claimAgent(ADDR), false);
  },
);

Deno.test("claimAgent - Redis error propagates", async () => {
  _setClientForTesting({
    set: () => Promise.reject(new Error("connection refused")),
  });

  let threw = false;
  try {
    await claimAgent(ADDR);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// --- releaseAgent ---

Deno.test("releaseAgent - no client does nothing", async () => {
  _setClientForTesting(null);
  await releaseAgent(ADDR); // should not throw
});

Deno.test("releaseAgent - deletes key owned by this machine", async () => {
  const mock = new MockRedis();
  mock.store.set(`agent:${ADDR}`, {
    value: FLY_MACHINE_ID,
    expiresAt: Infinity,
  });
  _setClientForTesting(mock);

  await releaseAgent(ADDR);
  assertEquals(mock.store.has(`agent:${ADDR}`), false);
});

Deno.test(
  "releaseAgent - does not delete key owned by different machine",
  async () => {
    const mock = new MockRedis();
    mock.store.set(`agent:${ADDR}`, {
      value: OTHER_MACHINE,
      expiresAt: Infinity,
    });
    _setClientForTesting(mock);

    await releaseAgent(ADDR);
    assertEquals(mock.store.get(`agent:${ADDR}`)?.value, OTHER_MACHINE);

    _setClientForTesting(null);
  },
);

Deno.test("releaseAgent - does nothing when key absent", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await releaseAgent(ADDR); // should not throw
  assertEquals(mock.store.has(`agent:${ADDR}`), false);

  _setClientForTesting(null);
});

// --- lookupAgentInstance ---

Deno.test("lookupAgentInstance - no client returns null", async () => {
  _setClientForTesting(null);
  assertEquals(await lookupAgentInstance(ADDR), null);
});

Deno.test(
  "lookupAgentInstance - returns machine ID when key exists",
  async () => {
    const mock = new MockRedis();
    mock.store.set(`agent:${ADDR}`, {
      value: OTHER_MACHINE,
      expiresAt: Infinity,
    });
    _setClientForTesting(mock);

    assertEquals(await lookupAgentInstance(ADDR), OTHER_MACHINE);

    _setClientForTesting(null);
  },
);

Deno.test("lookupAgentInstance - returns null when key absent", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  assertEquals(await lookupAgentInstance(ADDR), null);

  _setClientForTesting(null);
});

// --- refreshAgentsTTL ---

Deno.test("refreshAgentsTTL - no client does nothing", () => {
  _setClientForTesting(null);
  refreshAgentsTTL([ADDR]); // should not throw
});

Deno.test("refreshAgentsTTL - calls expire for each address", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  const addrs = ["0xaaa", "0xbbb", "0xccc"];
  refreshAgentsTTL(addrs);
  await Promise.resolve(); // flush microtasks

  assertEquals(
    mock.expireCalls.map((c) => c.key),
    addrs.map((a) => `agent:${a}`),
  );
});

Deno.test("refreshAgentsTTL - empty iterable does nothing", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  refreshAgentsTTL([]);
  await Promise.resolve();

  assertEquals(mock.expireCalls.length, 0);
});
