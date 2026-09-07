import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "../src/router.ts";
import { tunnelLimiter } from "../src/rate_limit.ts";
import { _setClientForTesting, FLY_MACHINE_ID } from "../src/redis.ts";
import { MockRedis } from "./redis_mock.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

let portCounter = 9100;
function nextPort(): number {
  return portCounter++;
}

function mockInfo(): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp" as const, hostname: "127.0.0.1", port: 12345 },
    completed: Promise.resolve(),
  };
}

async function signForTunnel(address: string, nonce: string, timestamp: number): Promise<string> {
  const message = `osaurus-tunnel:${address}:${nonce}:${timestamp}`;
  return await account.signMessage({ message });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
  });
}

function resetRateLimiter(): void {
  // deno-lint-ignore no-explicit-any
  (tunnelLimiter as any).buckets.clear();
}

async function connectAndAuth(
  port: number,
): Promise<{ ws: WebSocket; authResp: Record<string, unknown> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel/connect`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });

  const challenge = await waitForMessage(ws);
  assertEquals(challenge.type, "challenge");
  const nonce = challenge.nonce as string;

  const timestamp = Math.floor(Date.now() / 1000);
  const sig = await signForTunnel(account.address, nonce, timestamp);

  ws.send(JSON.stringify({
    type: "auth",
    agents: [{ address: account.address, signature: sig }],
    nonce,
    timestamp,
  }));

  const authResp = await waitForMessage(ws);
  assertEquals(authResp.type, "auth_ok");

  return { ws, authResp };
}

Deno.test({
  name: "tunnel - full lifecycle: connect, auth, request relay, disconnect",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const { ws } = await connectAndAuth(port);

    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === "request") {
        ws.send(JSON.stringify({
          type: "response",
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ echo: true, path: frame.path }),
        }));
      }
    };

    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: {
          host: `${agentAddr}.agent.osaurus.ai`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 200);
    const body = await resp.json();
    assertEquals(body.echo, true);
    assertEquals(body.path, "/chat");

    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    const resp2 = await handleRequest(
      new Request("http://localhost/chat", {
        headers: { host: `${agentAddr}.agent.osaurus.ai` },
      }),
      mockInfo(),
    );
    assertEquals(resp2.status, 502);
    await resp2.body?.cancel();

    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - add and remove agent mid-session",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const { ws } = await connectAndAuth(port);

    const messages: Record<string, unknown>[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    ws.send(JSON.stringify({
      type: "remove_agent",
      address: account.address,
    }));
    await new Promise((r) => setTimeout(r, 200));

    const removeMsg = messages.find((m) => m.type === "agent_removed");
    assertEquals(removeMsg?.type, "agent_removed");

    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/chat", {
        headers: { host: `${agentAddr}.agent.osaurus.ai` },
      }),
      mockInfo(),
    );
    assertEquals(resp.status, 502);
    await resp.body?.cancel();

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - wrong nonce rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel/connect`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    const challenge = await waitForMessage(ws);
    assertEquals(challenge.type, "challenge");

    const fakeNonce = "a".repeat(64);
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signForTunnel(account.address, fakeNonce, timestamp);

    ws.send(JSON.stringify({
      type: "auth",
      agents: [{ address: account.address, signature: sig }],
      nonce: fakeNonce,
      timestamp,
    }));

    const resp = await waitForMessage(ws);
    assertEquals(resp.type, "auth_error");
    assertEquals(resp.error, "invalid_nonce");

    await new Promise((r) => setTimeout(r, 200));
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - add agent mid-session with request_challenge",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const { ws } = await connectAndAuth(port);

    ws.send(JSON.stringify({ type: "request_challenge" }));
    const challenge = await waitForMessage(ws);
    assertEquals(challenge.type, "challenge");
    const nonce = challenge.nonce as string;

    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signForTunnel(account.address, nonce, timestamp);

    ws.send(JSON.stringify({
      type: "add_agent",
      address: account.address,
      signature: sig,
      nonce,
      timestamp,
    }));

    const addResp = await waitForMessage(ws);
    assertEquals(addResp.type, "agent_added");
    assertEquals(addResp.address, account.address.toLowerCase());

    ws.close();
    await new Promise((r) => setTimeout(r, 200));
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - newer authenticated tunnel takes over the address (old one is superseded)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const { ws: ws1 } = await connectAndAuth(port);

    const ws1Messages: Record<string, unknown>[] = [];
    let ws1CloseCode: number | null = null;
    ws1.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      ws1Messages.push(frame);
      if (frame.type === "request") {
        ws1.send(JSON.stringify({
          type: "response",
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "first" }),
        }));
      }
    };
    ws1.onclose = (e) => {
      ws1CloseCode = e.code;
    };

    // A second tunnel authenticating the same address wins: proof of key possession is
    // proof of ownership, and the newest session is the one the user is actually using.
    const { ws: ws2, authResp } = await connectAndAuth(port);
    assertEquals(authResp.rejected, undefined);
    assertEquals(typeof authResp.region, "string");
    const agents = authResp.agents as { address: string }[];
    assertEquals(agents.length, 1);

    ws2.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === "request") {
        ws2.send(JSON.stringify({
          type: "response",
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "second" }),
        }));
      }
    };
    await new Promise((r) => setTimeout(r, 200));

    // Old connection was told why, and closed since it has no agents left.
    const evicted = ws1Messages.find((m) => m.type === "agent_removed");
    assertEquals(evicted?.reason, "superseded");
    assertEquals(evicted?.address, account.address.toLowerCase());
    assertEquals(ws1CloseCode, 1000);

    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: {
          host: `${agentAddr}.agent.osaurus.ai`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 200);
    assertEquals(typeof resp.headers.get("x-relay-region"), "string");
    assertEquals(resp.headers.get("server-timing")?.includes("host;dur="), true);
    const body = await resp.json();
    assertEquals(body.from, "second");

    ws2.close();
    await new Promise((r) => setTimeout(r, 200));
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - add_agent takes over an address held by another connection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const { ws: ws1 } = await connectAndAuth(port);
    const ws1Messages: Record<string, unknown>[] = [];
    ws1.onmessage = (e) => ws1Messages.push(JSON.parse(e.data));

    // Second connection authenticates with a *different* address, then adds the first one.
    const otherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const otherAccount = privateKeyToAccount(otherKey);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/tunnel/connect`);
    await new Promise<void>((resolve, reject) => {
      ws2.onopen = () => resolve();
      ws2.onerror = (e) => reject(e);
    });
    const challenge0 = await waitForMessage(ws2);
    const ts0 = Math.floor(Date.now() / 1000);
    const sig0 = await otherAccount.signMessage({
      message: `osaurus-tunnel:${otherAccount.address}:${challenge0.nonce}:${ts0}`,
    });
    ws2.send(JSON.stringify({
      type: "auth",
      agents: [{ address: otherAccount.address, signature: sig0 }],
      nonce: challenge0.nonce,
      timestamp: ts0,
    }));
    assertEquals((await waitForMessage(ws2)).type, "auth_ok");

    ws2.send(JSON.stringify({ type: "request_challenge" }));
    const challenge = await waitForMessage(ws2);
    assertEquals(challenge.type, "challenge");
    const nonce = challenge.nonce as string;

    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signForTunnel(account.address, nonce, timestamp);

    ws2.send(JSON.stringify({
      type: "add_agent",
      address: account.address,
      signature: sig,
      nonce,
      timestamp,
    }));

    const addResp = await waitForMessage(ws2);
    assertEquals(addResp.type, "agent_added");
    assertEquals(addResp.address, account.address.toLowerCase());
    assertEquals(typeof addResp.region, "string");

    await new Promise((r) => setTimeout(r, 100));
    const evicted = ws1Messages.find((m) => m.type === "agent_removed");
    assertEquals(evicted?.reason, "superseded");

    ws1.close();
    ws2.close();
    await new Promise((r) => setTimeout(r, 200));
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - teardown of old connection does not corrupt new connection's tunnel entry",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const { ws: ws1 } = await connectAndAuth(port);

    ws1.send(JSON.stringify({
      type: "remove_agent",
      address: account.address,
    }));
    await new Promise((r) => setTimeout(r, 200));

    const { ws: ws2 } = await connectAndAuth(port);

    ws2.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === "request") {
        ws2.send(JSON.stringify({
          type: "response",
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "second" }),
        }));
      }
    };

    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: {
          host: `${agentAddr}.agent.osaurus.ai`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 200);
    const body = await resp.json();
    assertEquals(body.from, "second");

    ws2.close();
    await new Promise((r) => setTimeout(r, 200));
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - auth takes over an agent claimed by a different fly instance",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const mock = new MockRedis();
    const agentAddr = account.address.toLowerCase();
    mock.store.set(`agent:${agentAddr}`, { value: "other-machine-id", expiresAt: Infinity });
    _setClientForTesting(mock);

    const { ws, authResp } = await connectAndAuth(port);

    // The host reconnected to this machine (e.g. after a network blip, before the old machine
    // noticed the dead socket). It must not be locked out: the claim moves to us.
    assertEquals(authResp.rejected, undefined);
    assertEquals((authResp.agents as unknown[]).length, 1);
    assertEquals(mock.store.get(`agent:${agentAddr}`)?.value, FLY_MACHINE_ID);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    _setClientForTesting(null);
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - pong learns of a takeover elsewhere and drops the stale local registration",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const mock = new MockRedis();
    _setClientForTesting(mock);

    const { ws } = await connectAndAuth(port);
    const agentAddr = account.address.toLowerCase();
    assertEquals(mock.store.get(`agent:${agentAddr}`)?.value, FLY_MACHINE_ID);

    const messages: Record<string, unknown>[] = [];
    let closeCode: number | null = null;
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    ws.onclose = (e) => {
      closeCode = e.code;
    };

    // Simulate the host re-authenticating on another machine, which force-claimed the key.
    mock.store.set(`agent:${agentAddr}`, { value: "other-machine-id", expiresAt: Infinity });

    ws.send(JSON.stringify({ type: "pong", ts: Math.floor(Date.now() / 1000) }));
    await new Promise((r) => setTimeout(r, 200));

    const evicted = messages.find((m) => m.type === "agent_removed");
    assertEquals(evicted?.reason, "superseded");
    assertEquals(closeCode, 1000);
    // We never clobbered the other machine's claim.
    assertEquals(mock.store.get(`agent:${agentAddr}`)?.value, "other-machine-id");

    // Requests landing here now route onward instead of being served by the stale socket.
    const resp = await handleRequest(
      new Request("http://localhost/chat", {
        headers: { host: `${agentAddr}.agent.osaurus.ai` },
      }),
      mockInfo(),
    );
    assertEquals(resp.status, 307);
    assertEquals(resp.headers.get("fly-replay"), "instance=other-machine-id");
    await resp.body?.cancel();

    _setClientForTesting(null);
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - disconnect releases agent from Redis",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const mock = new MockRedis();
    _setClientForTesting(mock);

    const { ws } = await connectAndAuth(port);

    const agentAddr = account.address.toLowerCase();
    assertEquals(mock.store.get(`agent:${agentAddr}`)?.value, FLY_MACHINE_ID);

    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    assertEquals(mock.store.has(`agent:${agentAddr}`), false);

    _setClientForTesting(null);
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - remove_agent releases agent from Redis",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const mock = new MockRedis();
    _setClientForTesting(mock);

    const { ws } = await connectAndAuth(port);

    const agentAddr = account.address.toLowerCase();
    assertEquals(mock.store.has(`agent:${agentAddr}`), true);

    ws.send(JSON.stringify({ type: "remove_agent", address: account.address }));
    await new Promise((r) => setTimeout(r, 200));

    assertEquals(mock.store.has(`agent:${agentAddr}`), false);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    _setClientForTesting(null);
    await server.shutdown();
  },
});

Deno.test({
  name: "tunnel - pong refreshes agent TTLs in Redis",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    resetRateLimiter();
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const mock = new MockRedis();
    _setClientForTesting(mock);

    const { ws } = await connectAndAuth(port);

    const agentAddr = account.address.toLowerCase();
    const callsBefore = mock.expireCalls.length;

    ws.send(JSON.stringify({ type: "pong", ts: Math.floor(Date.now() / 1000) }));
    await new Promise((r) => setTimeout(r, 100));

    const newCalls = mock.expireCalls.slice(callsBefore);
    assertEquals(newCalls.some((c) => c.key === `agent:${agentAddr}`), true);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    _setClientForTesting(null);
    await server.shutdown();
  },
});

Deno.test("health endpoint returns status ok", async () => {
  const resp = handleRequest(
    new Request("http://localhost/health"),
    mockInfo(),
  );
  const r = resp instanceof Promise ? await resp : resp;
  assertEquals(r.status, 200);
  const body = await r.json();
  assertEquals(body.status, "ok");
  assertEquals(typeof body.tunnels, "number");
});

Deno.test("invalid subdomain returns 400", async () => {
  const resp = handleRequest(
    new Request("http://localhost/test", {
      headers: { host: "invalid.agent.osaurus.ai" },
    }),
    mockInfo(),
  );
  const r = resp instanceof Promise ? await resp : resp;
  assertEquals(r.status, 400);
  await r.body?.cancel();
});

Deno.test("offline agent returns 502", async () => {
  const resp = handleRequest(
    new Request("http://localhost/test", {
      headers: { host: "0x0000000000000000000000000000000000000001.agent.osaurus.ai" },
    }),
    mockInfo(),
  );
  const r = resp instanceof Promise ? await resp : resp;
  assertEquals(r.status, 502);
  const body = await r.json();
  assertEquals(body.error, "agent_offline");
});
