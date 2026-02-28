import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "../src/router.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

let portCounter = 9300;
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
  name: "relay - forwards headers and body correctly",
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

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth_ok") resolve();
      };
    });

    // Capture the request frame for inspection, then respond
    // deno-lint-ignore no-explicit-any
    let capturedFrame: any = null;
    ws.onmessage = (e) => {
      const frame = JSON.parse(e.data);
      if (frame.type === "request") {
        capturedFrame = frame;
        ws.send(JSON.stringify({
          type: "response",
          id: frame.id,
          status: 201,
          headers: { "x-custom": "test-value" },
          body: "created",
        }));
      }
    };

    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/v1/chat/completions?stream=true", {
        method: "POST",
        headers: {
          host: `${agentAddr}.agent.osaurus.ai`,
          "content-type": "application/json",
          "x-api-key": "secret123",
        },
        body: JSON.stringify({ model: "test" }),
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 201);
    assertEquals(resp.headers.get("x-custom"), "test-value");
    const body = await resp.text();
    assertEquals(body, "created");

    assertEquals(capturedFrame !== null, true);
    assertEquals(capturedFrame.headers["x-agent-address"], agentAddr);
    assertEquals(capturedFrame.headers["content-type"], "application/json");
    assertEquals(capturedFrame.headers["x-api-key"], "secret123");
    assertEquals(capturedFrame.method, "POST");
    assertEquals(capturedFrame.path, "/v1/chat/completions?stream=true");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    await server.shutdown();
  },
});

Deno.test({
  name: "relay - 502 after tunnel disconnect",
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

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth_ok") resolve();
      };
    });

    // Disconnect tunnel
    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    // Agent should be offline
    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/chat", {
        headers: { host: `${agentAddr}.agent.osaurus.ai` },
      }),
      mockInfo(),
    );
    assertEquals(resp.status, 502);
    const respBody = await resp.json();
    assertEquals(respBody.error, "agent_offline");

    await server.shutdown();
  },
});
