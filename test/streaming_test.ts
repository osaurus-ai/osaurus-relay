import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "../src/router.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

let portCounter = 9500;
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

async function connectAndAuth(port: number): Promise<{ ws: WebSocket; authResp: Record<string, unknown> }> {
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
  name: "streaming - full stream flow: start, chunks, end",
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
          type: "stream_start",
          id: frame.id,
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }));
        ws.send(JSON.stringify({
          type: "stream_chunk",
          id: frame.id,
          data: "data: chunk1\n\n",
        }));
        ws.send(JSON.stringify({
          type: "stream_chunk",
          id: frame.id,
          data: "data: chunk2\n\n",
        }));
        ws.send(JSON.stringify({
          type: "stream_end",
          id: frame.id,
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
        },
        body: JSON.stringify({ model: "test", stream: true }),
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 200);
    assertEquals(resp.headers.get("content-type"), "text/event-stream");

    const body = await resp.text();
    assertEquals(body, "data: chunk1\n\ndata: chunk2\n\n");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    await server.shutdown();
  },
});

Deno.test({
  name: "streaming - buffered response still works (backward compat)",
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
          body: JSON.stringify({ result: "buffered" }),
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
    assertEquals(body.result, "buffered");

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    await server.shutdown();
  },
});

Deno.test({
  name: "streaming - tunnel disconnect mid-stream closes response",
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
          type: "stream_start",
          id: frame.id,
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }));
        ws.send(JSON.stringify({
          type: "stream_chunk",
          id: frame.id,
          data: "data: partial\n\n",
        }));
        setTimeout(() => ws.close(), 50);
      }
    };

    const agentAddr = account.address.toLowerCase();
    const resp = await handleRequest(
      new Request("http://localhost/v1/chat/completions?stream=true", {
        method: "POST",
        headers: {
          host: `${agentAddr}.agent.osaurus.ai`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test", stream: true }),
      }),
      mockInfo(),
    );

    assertEquals(resp.status, 200);

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        collected += decoder.decode(value, { stream: true });
      }
    } catch {
      // stream errored due to tunnel_closed — expected
    }

    assertEquals(collected.includes("data: partial"), true);

    await new Promise((r) => setTimeout(r, 200));
    await server.shutdown();
  },
});
