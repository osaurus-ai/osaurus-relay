import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "../src/router.ts";

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

async function signForTunnel(address: string, timestamp: number): Promise<string> {
  const message = `osaurus-tunnel:${address}:${timestamp}`;
  return await account.signMessage({ message });
}

Deno.test({
  name: "tunnel - full lifecycle: connect, auth, request relay, disconnect",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = nextPort();
    const server = Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));

    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signForTunnel(account.address, timestamp);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel/connect`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    ws.send(JSON.stringify({
      type: "auth",
      agents: [{ address: account.address, signature: sig }],
      timestamp,
    }));

    const authResponse = await new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
    });
    assertEquals(authResponse.type, "auth_ok");

    // Set up echo responder
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

    // Test relay by calling handleRequest directly with proper Host header
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

    // Disconnect
    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    // After disconnect, agent should be offline
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

    const timestamp = Math.floor(Date.now() / 1000);
    const sig = await signForTunnel(account.address, timestamp);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel/connect`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    ws.send(JSON.stringify({
      type: "auth",
      agents: [{ address: account.address, signature: sig }],
      timestamp,
    }));

    const authResp = await new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
    });
    assertEquals(authResp.type, "auth_ok");

    // Remove agent
    const messages: Record<string, unknown>[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));

    ws.send(JSON.stringify({
      type: "remove_agent",
      address: account.address,
    }));
    await new Promise((r) => setTimeout(r, 200));

    const removeMsg = messages.find((m) => m.type === "agent_removed");
    assertEquals(removeMsg?.type, "agent_removed");

    // Agent should be offline now
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
