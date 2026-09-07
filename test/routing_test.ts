// Cross-machine routing: route cache, fly-replay + edge replay cache, stale-hit handling,
// internal forwarding for bodies Fly cannot replay, and owner-only rate limiting.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../src/router.ts";
import { _setInternalTargetResolverForTesting } from "../src/relay.ts";
import { _setClientForTesting, FLY_MACHINE_ID } from "../src/redis.ts";
import {
  _clearRouteCacheForTesting,
  getCachedOwner,
  invalidateCachedOwner,
  setCachedOwner,
} from "../src/route_cache.ts";
import { callerLimiter, requestLimiter } from "../src/rate_limit.ts";
import { MockRedis } from "./redis_mock.ts";
import {
  agentAddr,
  agentRequest,
  connectAndAuth,
  hostResponder,
  mockInfo,
  sleep,
  startServer,
} from "./helpers.ts";

const REMOTE_AGENT = "0x00000000000000000000000000000000000000a1";
const REMOTE_HOST = `${REMOTE_AGENT}.agent.osaurus.ai`;
const OWNER = "owner-machine";

let portCounter = 9700;
const nextPort = () => portCounter++;

function drainBucket(limiter: unknown, key: string): void {
  // deno-lint-ignore no-explicit-any
  (limiter as any).buckets.set(key, { tokens: 0, lastRefill: Date.now() });
}
function resetBucket(limiter: unknown, key: string): void {
  // deno-lint-ignore no-explicit-any
  (limiter as any).buckets.delete(key);
}

// --- route cache (unit) ---

Deno.test("route_cache - set/get/invalidate, distinguishes miss from cached-nobody", () => {
  _clearRouteCacheForTesting();
  assertEquals(getCachedOwner("0xa"), undefined);
  setCachedOwner("0xa", "m1");
  assertEquals(getCachedOwner("0xa"), "m1");
  setCachedOwner("0xb", null);
  assertEquals(getCachedOwner("0xb"), null);
  invalidateCachedOwner("0xa");
  assertEquals(getCachedOwner("0xa"), undefined);
  _clearRouteCacheForTesting();
});

Deno.test("routing - repeated misses for the same agent hit Redis once", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
  _setClientForTesting(mock);

  for (let i = 0; i < 5; i++) {
    const resp = await handleRequest(agentRequest("/x", { host: REMOTE_HOST }), mockInfo());
    assertEquals(resp.status, 307);
    assertEquals(resp.headers.get("fly-replay"), `instance=${OWNER}`);
    await resp.body?.cancel();
  }
  assertEquals(mock.getCalls, 1);

  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

Deno.test("routing - offline agents are negatively cached", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  _setClientForTesting(mock);

  for (let i = 0; i < 3; i++) {
    const resp = await handleRequest(agentRequest("/x", { host: REMOTE_HOST }), mockInfo());
    assertEquals(resp.status, 502);
    await resp.body?.cancel();
  }
  assertEquals(mock.getCalls, 1);
  assertEquals(getCachedOwner(REMOTE_AGENT), null);

  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

// --- fly-replay + replay cache ---

Deno.test("routing - stale edge cache hit re-replays to the real owner and invalidates", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
  _setClientForTesting(mock);

  const resp = await handleRequest(
    agentRequest("/x", { host: REMOTE_HOST, headers: { "fly-replay-cache-status": "hit" } }),
    mockInfo(),
  );
  assertEquals(resp.status, 307);
  assertEquals(resp.headers.get("fly-replay"), `instance=${OWNER}`);
  assertEquals(resp.headers.get("fly-replay-cache"), "invalidate");
  assertEquals(resp.headers.get("fly-replay-cache-ttl-secs"), null);
  await resp.body?.cancel();

  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

Deno.test("routing - replay-cache key strips a port from the Host header", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
  _setClientForTesting(mock);

  const resp = await handleRequest(
    agentRequest("/x", { host: `${REMOTE_HOST}:443` }),
    mockInfo(),
  );
  assertEquals(resp.status, 307);
  assertEquals(resp.headers.get("fly-replay-cache"), `${REMOTE_HOST}/*`);
  await resp.body?.cancel();

  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

Deno.test("routing - a forwarded (internal-hop) request is terminal: 502, never re-replayed", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
  _setClientForTesting(mock);

  const resp = await handleRequest(
    agentRequest("/x", {
      host: "127.0.0.1:8080",
      headers: { "x-relay-internal-hop": "1", "x-relay-original-host": REMOTE_HOST },
    }),
    mockInfo(),
  );
  assertEquals(resp.status, 502);
  assertEquals(resp.headers.get("fly-replay"), null);
  assertEquals((await resp.json()).error, "agent_offline");
  assertEquals(mock.getCalls, 0);

  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

// --- internal forward for large bodies ---

Deno.test({
  name: "routing - bodies over 1MB are streamed to the owner over the private network",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _clearRouteCacheForTesting();
    const mock = new MockRedis();
    mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
    _setClientForTesting(mock);

    // Stand-in for the owning machine: records what arrived and streams a reply back.
    let seen: { headers: Headers; bodyBytes: number; url: string } | null = null;
    const ownerPort = nextPort();
    const owner = Deno.serve({ port: ownerPort, onListen() {} }, async (req) => {
      const body = new Uint8Array(await req.arrayBuffer());
      seen = { headers: req.headers, bodyBytes: body.byteLength, url: req.url };
      return new Response("owner says hi", {
        status: 201,
        headers: { "x-relay-region": "ams", "x-relay-machine": OWNER, "x-from-owner": "1" },
      });
    });
    _setInternalTargetResolverForTesting((machineId) => {
      assertEquals(machineId, OWNER);
      return `http://127.0.0.1:${ownerPort}`;
    });

    const big = new Uint8Array(2 * 1024 * 1024).fill(0x41);
    const resp = await handleRequest(
      agentRequest("/v1/audio/transcriptions?x=1", {
        method: "POST",
        host: REMOTE_HOST,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(big.byteLength),
          "fly-client-ip": "203.0.113.9",
        },
        body: big,
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 201);
    assertEquals(await resp.text(), "owner says hi");
    assertEquals(resp.headers.get("x-from-owner"), "1");
    assertEquals(resp.headers.get("x-relay-via"), FLY_MACHINE_ID);
    // Owner identity wins so callers see who actually served the request.
    assertEquals(resp.headers.get("x-relay-region"), "ams");
    assertEquals(resp.headers.get("x-relay-machine"), OWNER);

    assertEquals(seen !== null, true);
    assertEquals(seen!.bodyBytes, big.byteLength);
    assertEquals(seen!.headers.get("x-relay-internal-hop"), "1");
    assertEquals(seen!.headers.get("x-relay-original-host"), REMOTE_HOST);
    assertEquals(seen!.headers.get("x-relay-client-ip"), "203.0.113.9");
    assertEquals(seen!.headers.get("fly-client-ip"), null);
    assertEquals(new URL(seen!.url).pathname, "/v1/audio/transcriptions");
    assertEquals(new URL(seen!.url).search, "?x=1");

    _setInternalTargetResolverForTesting(null);
    _setClientForTesting(null);
    _clearRouteCacheForTesting();
    await owner.shutdown();
  },
});

Deno.test("routing - unreachable owner on internal forward yields 502, not a hang", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
  _setClientForTesting(mock);
  _setInternalTargetResolverForTesting(() => "http://127.0.0.1:1"); // nothing listens here

  const resp = await handleRequest(
    agentRequest("/x", {
      method: "POST",
      host: REMOTE_HOST,
      headers: { "content-length": String(3 * 1024 * 1024) },
      body: new Uint8Array(3 * 1024 * 1024),
    }),
    mockInfo(),
  );
  assertEquals(resp.status, 502);
  assertEquals((await resp.json()).error, "agent_unreachable");

  _setInternalTargetResolverForTesting(null);
  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

// --- rate limiting lives on the owner ---

Deno.test("routing - a non-owner never charges the agent's or caller's budget", async () => {
  _clearRouteCacheForTesting();
  const mock = new MockRedis();
  mock.store.set(`agent:${REMOTE_AGENT}`, { value: OWNER, expiresAt: Infinity });
  _setClientForTesting(mock);

  drainBucket(requestLimiter, REMOTE_AGENT);
  drainBucket(callerLimiter, "127.0.0.1");
  const resp = await handleRequest(agentRequest("/x", { host: REMOTE_HOST }), mockInfo());
  assertEquals(resp.status, 307); // routed, not 429
  await resp.body?.cancel();

  resetBucket(requestLimiter, REMOTE_AGENT);
  resetBucket(callerLimiter, "127.0.0.1");
  _setClientForTesting(null);
  _clearRouteCacheForTesting();
});

Deno.test({
  name: "routing - owner enforces per-agent and per-caller limits",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const { ws } = await connectAndAuth(port);
    hostResponder(ws, (frame) => {
      ws.send(JSON.stringify({
        type: "response",
        id: frame.id,
        status: 200,
        headers: {},
        body: "ok",
      }));
    });

    // Per-agent budget exhausted -> 429 regardless of caller.
    drainBucket(requestLimiter, agentAddr);
    let resp = await handleRequest(agentRequest("/x"), mockInfo("10.0.0.1"));
    assertEquals(resp.status, 429);
    await resp.body?.cancel();
    resetBucket(requestLimiter, agentAddr);

    // Per-caller budget exhausted -> that caller gets 429, another caller is served.
    drainBucket(callerLimiter, "10.0.0.2");
    resp = await handleRequest(agentRequest("/x"), mockInfo("10.0.0.2"));
    assertEquals(resp.status, 429);
    await resp.body?.cancel();
    resp = await handleRequest(agentRequest("/x"), mockInfo("10.0.0.3"));
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "ok");
    resetBucket(callerLimiter, "10.0.0.2");

    ws.close();
    await sleep(100);
    await server.shutdown();
  },
});
