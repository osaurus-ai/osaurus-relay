import { verifyAgent, verifyAuth } from "./auth.ts";
import type {
  AddAgentFrame,
  AuthFrame,
  InboundFrame,
  PendingRequest,
  RemoveAgentFrame,
  ResponseFrame,
  TunnelConnection,
} from "./types.ts";

const BASE_DOMAIN = Deno.env.get("BASE_DOMAIN") ?? "agent.osaurus.ai";
const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 3;
const MAX_AGENTS_PER_TUNNEL = 50;
const AUTH_TIMEOUT_MS = 10_000;

// agent address (lowercase) -> TunnelConnection
const tunnels = new Map<string, TunnelConnection>();

// ws -> TunnelConnection (for cleanup and message routing)
const connections = new Map<WebSocket, TunnelConnection>();

export function getActiveTunnelCount(): number {
  return connections.size;
}

export function getTunnelForAgent(address: string): TunnelConnection | undefined {
  return tunnels.get(address.toLowerCase());
}

function agentUrl(address: string): string {
  return `https://${address}.${BASE_DOMAIN}`;
}

function registerAgent(conn: TunnelConnection, address: string): void {
  const lower = address.toLowerCase();
  conn.agents.add(lower);
  tunnels.set(lower, conn);
}

function unregisterAgent(conn: TunnelConnection, address: string): void {
  const lower = address.toLowerCase();
  conn.agents.delete(lower);
  tunnels.delete(lower);
}

function teardown(conn: TunnelConnection): void {
  clearInterval(conn.keepaliveTimer);
  for (const addr of conn.agents) {
    tunnels.delete(addr);
  }
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timer);
    pending.resolve({
      type: "response",
      id: "",
      status: 502,
      headers: {},
      body: JSON.stringify({ error: "tunnel_closed" }),
    });
  }
  conn.pending.clear();
  conn.agents.clear();
  connections.delete(conn.ws);
}

function startKeepalive(conn: TunnelConnection): void {
  conn.keepaliveTimer = setInterval(() => {
    if (conn.missedPings >= MAX_MISSED_PINGS) {
      try {
        conn.ws.close(1000, "keepalive timeout");
      } catch { /* already closed */ }
      teardown(conn);
      return;
    }
    conn.missedPings++;
    try {
      conn.ws.send(JSON.stringify({ type: "ping", ts: Math.floor(Date.now() / 1000) }));
    } catch {
      teardown(conn);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function handleResponse(conn: TunnelConnection, frame: ResponseFrame): void {
  const pending = conn.pending.get(frame.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  conn.pending.delete(frame.id);
  pending.resolve(frame);
}

async function handleAddAgent(
  conn: TunnelConnection,
  frame: AddAgentFrame,
): Promise<void> {
  if (conn.agents.size >= MAX_AGENTS_PER_TUNNEL) {
    conn.ws.send(JSON.stringify({ type: "error", error: "max_agents_reached" }));
    return;
  }

  const addr = await verifyAgent(
    { address: frame.address, signature: frame.signature },
    frame.timestamp,
  );
  if (!addr) {
    conn.ws.send(JSON.stringify({ type: "error", error: "invalid_signature" }));
    return;
  }

  registerAgent(conn, addr);
  conn.ws.send(JSON.stringify({
    type: "agent_added",
    address: addr,
    url: agentUrl(addr),
  }));
}

function handleRemoveAgent(
  conn: TunnelConnection,
  frame: RemoveAgentFrame,
): void {
  const lower = frame.address.toLowerCase();
  if (!conn.agents.has(lower)) return;
  unregisterAgent(conn, lower);
  conn.ws.send(JSON.stringify({ type: "agent_removed", address: lower }));
}

function onMessage(conn: TunnelConnection, data: string): void {
  let frame: InboundFrame;
  try {
    frame = JSON.parse(data);
  } catch {
    return;
  }

  switch (frame.type) {
    case "pong":
      conn.missedPings = 0;
      break;
    case "response":
      handleResponse(conn, frame);
      break;
    case "add_agent":
      handleAddAgent(conn, frame);
      break;
    case "remove_agent":
      handleRemoveAgent(conn, frame);
      break;
    default:
      break;
  }
}

export function handleTunnelConnect(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  const conn: TunnelConnection = {
    ws: socket,
    agents: new Set(),
    pending: new Map<string, PendingRequest>(),
    missedPings: 0,
    keepaliveTimer: 0,
  };

  let authenticated = false;

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      try {
        socket.send(JSON.stringify({ type: "auth_error", error: "auth_timeout" }));
        socket.close(4001, "auth timeout");
      } catch { /* socket may not be open yet */ }
    }
  }, AUTH_TIMEOUT_MS);

  socket.onopen = () => {};

  socket.onmessage = async (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (!data) return;

    if (!authenticated) {
      let frame: AuthFrame;
      try {
        frame = JSON.parse(data);
      } catch {
        socket.send(JSON.stringify({ type: "auth_error", error: "invalid_json" }));
        socket.close(4000, "invalid json");
        return;
      }

      if (frame.type !== "auth" || !Array.isArray(frame.agents) || !frame.timestamp) {
        socket.send(JSON.stringify({ type: "auth_error", error: "expected_auth_frame" }));
        socket.close(4000, "expected auth frame");
        return;
      }

      if (frame.agents.length === 0) {
        socket.send(JSON.stringify({ type: "auth_error", error: "no_agents" }));
        socket.close(4000, "no agents");
        return;
      }

      if (frame.agents.length > MAX_AGENTS_PER_TUNNEL) {
        socket.send(JSON.stringify({ type: "auth_error", error: "too_many_agents" }));
        socket.close(4000, "too many agents");
        return;
      }

      const verified = await verifyAuth(frame.agents, frame.timestamp);
      if (!verified) {
        socket.send(JSON.stringify({ type: "auth_error", error: "signature_verification_failed" }));
        socket.close(4001, "auth failed");
        return;
      }

      clearTimeout(authTimeout);
      authenticated = true;
      connections.set(socket, conn);

      for (const addr of verified) {
        registerAgent(conn, addr);
      }

      socket.send(JSON.stringify({
        type: "auth_ok",
        agents: verified.map((addr) => ({
          address: addr,
          url: agentUrl(addr),
        })),
      }));

      startKeepalive(conn);
      return;
    }

    onMessage(conn, data);
  };

  socket.onclose = () => {
    clearTimeout(authTimeout);
    if (authenticated) teardown(conn);
  };

  socket.onerror = () => {
    clearTimeout(authTimeout);
    if (authenticated) teardown(conn);
  };

  return response;
}
