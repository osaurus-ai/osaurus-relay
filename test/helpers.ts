// Shared fixtures for integration-style tests that drive a real Deno.serve + WebSocket tunnel.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { handleRequest } from "../src/router.ts";

export const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const account = privateKeyToAccount(TEST_KEY);
export const agentAddr = account.address.toLowerCase();

export function mockInfo(ip = "127.0.0.1"): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp" as const, hostname: ip, port: 12345 },
    completed: Promise.resolve(),
  };
}

export function startServer(port: number): Deno.HttpServer {
  return Deno.serve({ port, onListen() {} }, (req, info) => handleRequest(req, info));
}

export function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function openSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel/connect`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
  return ws;
}

export async function connectAndAuth(
  port: number,
): Promise<{ ws: WebSocket; authResp: Record<string, unknown> }> {
  const ws = await openSocket(port);

  const challenge = await waitForMessage(ws);
  assertEquals(challenge.type, "challenge");
  const nonce = challenge.nonce as string;

  const timestamp = Math.floor(Date.now() / 1000);
  const sig = await account.signMessage({
    message: `osaurus-tunnel:${account.address}:${nonce}:${timestamp}`,
  });

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

/** Makes the host answer every `request` frame using `respond`, and collects other frames. */
export function hostResponder(
  ws: WebSocket,
  respond: (frame: Record<string, unknown>) => void,
): Record<string, unknown>[] {
  const others: Record<string, unknown>[] = [];
  ws.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    if (frame.type === "request") respond(frame);
    else others.push(frame);
  };
  return others;
}

export function agentRequest(
  path: string,
  init: RequestInit & { host?: string } = {},
): Request {
  const { host, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("host", host ?? `${agentAddr}.agent.osaurus.ai`);
  return new Request(`http://localhost${path}`, { ...rest, headers });
}
