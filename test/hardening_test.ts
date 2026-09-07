// Hardening: malformed host frames, unrepresentable host responses, backpressure, pre-auth
// socket accounting, control-frame throttling, CORS passthrough, and graceful shutdown.

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../src/router.ts";
import { MAX_STREAM_CHUNK_CHARS, parseAuthFrame, parseInboundFrame } from "../src/frames.ts";
import { buildHostResponse, sanitizeResponseHeaders } from "../src/http.ts";
import { _getIpConnectionCountForTesting, closeAllTunnels } from "../src/tunnel.ts";
import { _resetLifecycleForTesting, markShuttingDown } from "../src/lifecycle.ts";
import { controlFrameLimiter } from "../src/rate_limit.ts";
import { getStats } from "../src/stats.ts";
import { _setClientForTesting } from "../src/redis.ts";
import { MockRedis } from "./redis_mock.ts";
import {
  agentRequest,
  connectAndAuth,
  hostResponder,
  mockInfo,
  openSocket,
  sleep,
  startServer,
  waitForMessage,
} from "./helpers.ts";

let portCounter = 9800;
const nextPort = () => portCounter++;

// --- frame validation (unit) ---

Deno.test("frames - rejects garbage, wrong shapes and oversized payloads; recovers id", () => {
  assertEquals(parseInboundFrame("not json").ok, false);
  assertEquals(parseInboundFrame(JSON.stringify({ type: "nope" })).ok, false);

  const badHeaders = parseInboundFrame(
    JSON.stringify({ type: "response", id: "r1", status: 200, headers: null, body: "" }),
  );
  assertEquals(badHeaders.ok, false);
  if (!badHeaders.ok) {
    assertEquals(badHeaders.reason, "invalid_frame");
    assertEquals(badHeaders.id, "r1");
  }

  const oversized = parseInboundFrame(
    JSON.stringify({
      type: "stream_chunk",
      id: "r2",
      data: "x".repeat(MAX_STREAM_CHUNK_CHARS + 1),
    }),
  );
  assertEquals(oversized.ok, false);
  if (!oversized.ok) assertEquals(oversized.reason, "oversized");

  const good = parseInboundFrame(
    JSON.stringify({ type: "response", id: "r3", status: 204, headers: {} }),
  );
  assertEquals(good.ok, true);
  if (good.ok && good.frame.type === "response") assertEquals(good.frame.body, "");

  assertEquals(parseAuthFrame(JSON.stringify({ type: "auth", agents: "x" })).ok, false);
});

Deno.test("buildHostResponse - unrepresentable responses return null instead of throwing", () => {
  assertEquals(buildHostResponse(99, {}, "x"), null);
  assertEquals(buildHostResponse(1000, {}, "x"), null);
  assertEquals(buildHostResponse(NaN, {}, "x"), null);
  assertEquals(buildHostResponse(200, { "bad\nname": "v" }, "x"), null);
  assertEquals(buildHostResponse(200, { ok: "bad\r\nvalue" }, "x"), null);

  const noContent = buildHostResponse(204, {}, "");
  assertEquals(noContent?.status, 204);
  assertEquals(noContent?.body, null);

  const ok = buildHostResponse(201, { "x-a": "1" }, "body");
  assertEquals(ok?.status, 201);
  assertEquals(ok?.headers.get("x-a"), "1");
});

Deno.test("sanitizeResponseHeaders - host-provided CORS origin is preserved", () => {
  const strict = sanitizeResponseHeaders({ "access-control-allow-origin": "https://app.example" });
  assertEquals(strict.get("access-control-allow-origin"), "https://app.example");
  const open = sanitizeResponseHeaders({});
  assertEquals(open.get("access-control-allow-origin"), "*");
});

// --- integration: a misbehaving host cannot hang callers or crash the process ---

Deno.test({
  name: "hardening - invalid status from host resolves to 502 instead of hanging",
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
        status: 1000,
        headers: {},
        body: "??",
      }));
    });

    const before = getStats().total_bad_host_responses as number;
    const resp = await handleRequest(agentRequest("/x"), mockInfo());
    assertEquals(resp.status, 502);
    assertEquals((await resp.json()).error, "bad_host_response");
    assertEquals(getStats().total_bad_host_responses, before + 1);

    ws.close();
    await sleep(100);
    await server.shutdown();
  },
});

Deno.test({
  name: "hardening - malformed frame naming a pending request fails it fast and cancels the host",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const { ws } = await connectAndAuth(port);
    const others = hostResponder(ws, (frame) => {
      // headers must be an object; null fails validation.
      ws.send(JSON.stringify({ type: "response", id: frame.id, status: 200, headers: null }));
    });

    const before = getStats().total_invalid_frames as number;
    const resp = await handleRequest(agentRequest("/x"), mockInfo());
    assertEquals(resp.status, 502);
    await resp.body?.cancel();
    assertEquals(getStats().total_invalid_frames, before + 1);
    await sleep(50);
    assertEquals(others.some((f) => f.type === "cancel"), true);

    ws.close();
    await sleep(100);
    await server.shutdown();
  },
});

Deno.test({
  name: "hardening - 204 with an empty body from the host is delivered, not dropped",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const { ws } = await connectAndAuth(port);
    hostResponder(ws, (frame) => {
      ws.send(
        JSON.stringify({ type: "response", id: frame.id, status: 204, headers: {}, body: "" }),
      );
    });

    const resp = await handleRequest(agentRequest("/x", { method: "DELETE" }), mockInfo());
    assertEquals(resp.status, 204);
    assertEquals(resp.body, null);

    ws.close();
    await sleep(100);
    await server.shutdown();
  },
});

Deno.test({
  name: "hardening - slow consumer is cut off once the buffer cap is exceeded",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const { ws } = await connectAndAuth(port);

    const chunk = "y".repeat(1000 * 1000); // ~1MB per frame, under the per-chunk cap
    const others = hostResponder(ws, (frame) => {
      ws.send(JSON.stringify({ type: "stream_start", id: frame.id, status: 200, headers: {} }));
      // 6MB queued against a caller that never reads: exceeds the 4MB cap.
      for (let i = 0; i < 6; i++) {
        ws.send(JSON.stringify({ type: "stream_chunk", id: frame.id, data: chunk }));
      }
    });

    const before = getStats().total_slow_consumer_aborts as number;
    const resp = await handleRequest(agentRequest("/stream"), mockInfo());
    assertEquals(resp.status, 200);

    // Do not read the body; wait for the host to finish pushing.
    await sleep(500);
    assertEquals(getStats().total_slow_consumer_aborts, before + 1);
    assertEquals(others.some((f) => f.type === "cancel"), true);
    await assertRejects(() => resp.text());

    ws.close();
    await sleep(100);
    await server.shutdown();
  },
});

// --- limits ---

Deno.test({
  name: "hardening - pre-auth sockets count toward the per-IP cap and are released on close",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const base = _getIpConnectionCountForTesting("127.0.0.1");

    const ws = await openSocket(port);
    await waitForMessage(ws); // challenge; we never authenticate
    assertEquals(_getIpConnectionCountForTesting("127.0.0.1"), base + 1);

    ws.close();
    await sleep(100);
    assertEquals(_getIpConnectionCountForTesting("127.0.0.1"), base);

    await server.shutdown();
  },
});

Deno.test({
  name: "hardening - request_challenge / add_agent are throttled per connection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const { ws } = await connectAndAuth(port);

    const frames: Record<string, unknown>[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(e.data));
    for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ type: "request_challenge" }));
    await sleep(150);

    const challenges = frames.filter((f) => f.type === "challenge").length;
    const limited = frames.filter((f) => f.type === "error" && f.error === "rate_limited").length;
    assertEquals(challenges, 10);
    assertEquals(limited, 2);

    // deno-lint-ignore no-explicit-any
    (controlFrameLimiter as any).buckets.clear();
    ws.close();
    await sleep(100);
    await server.shutdown();
  },
});

// --- shutdown ---

Deno.test({
  name: "hardening - shutdown refuses new tunnels, fails health, and closes existing tunnels",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = startServer(port);
    const mock = new MockRedis();
    _setClientForTesting(mock);

    const { ws } = await connectAndAuth(port);
    const frames: Record<string, unknown>[] = [];
    let closeCode: number | null = null;
    ws.onmessage = (e) => frames.push(JSON.parse(e.data));
    ws.onclose = (e) => {
      closeCode = e.code;
    };
    assertEquals(mock.store.size, 1);

    markShuttingDown();
    try {
      const health = await handleRequest(new Request("http://localhost/health"), mockInfo());
      assertEquals(health.status, 503);
      assertEquals((await health.json()).status, "shutting_down");

      const connect = await handleRequest(
        new Request("http://localhost/tunnel/connect", { headers: { upgrade: "websocket" } }),
        mockInfo(),
      );
      assertEquals(connect.status, 503);
      assertEquals((await connect.json()).error, "relay_restarting");

      const closed = closeAllTunnels("relay_restarting");
      assertEquals(closed >= 1, true);
      await sleep(150);
      assertEquals(frames.some((f) => f.type === "error" && f.error === "relay_restarting"), true);
      assertEquals(closeCode, 1012);
      // Claims released so other machines can take the addresses immediately.
      assertEquals(mock.store.size, 0);
    } finally {
      _resetLifecycleForTesting();
      _setClientForTesting(null);
      await server.shutdown();
    }
  },
});
