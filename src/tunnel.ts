import { generateNonce, verifyAgent, verifyAuth } from "./auth.ts";
import { jsonResponse } from "./http.ts";
import {
  failRequest,
  handleStreamChunk,
  handleStreamEnd,
  handleStreamStart,
  inflightCount,
  teardownStreaming,
} from "./relay.ts";
import { claimAgents, refreshAgentsTTL, releaseAgent } from "./redis.ts";
import { BASE_DOMAIN, FLY_REGION } from "./env.ts";
import { recordInvalidFrame, recordTakeover, recordTunnelConnect } from "./stats.ts";
import { controlFrameLimiter } from "./rate_limit.ts";
import { parseAuthFrame, parseInboundFrame } from "./frames.ts";
import { invalidateCachedOwner } from "./route_cache.ts";
import { log } from "./observability.ts";
import type {
  AddAgentFrame,
  InboundFrame,
  PendingRequest,
  RemoveAgentFrame,
  ResponseFrame,
  StreamingRequest,
  TunnelConnection,
} from "./types.ts";

const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 3;
const MAX_AGENTS_PER_TUNNEL = 50;
const AUTH_TIMEOUT_MS = 10_000;
const NONCE_EXPIRY_MS = 30_000;
// Per relay machine. Sized for a team behind one NAT, not a single household.
const MAX_CONNECTIONS_PER_IP = 50;

// agent address (lowercase) -> TunnelConnection
const tunnels = new Map<string, TunnelConnection>();

// ws -> TunnelConnection (for cleanup and message routing)
const connections = new Map<WebSocket, TunnelConnection>();

// client IP -> number of open sockets (counted from upgrade, so the pre-auth window is covered)
const ipConnectionCount = new Map<string, number>();

export function getActiveTunnelCount(): number {
  return connections.size;
}

export function getActiveAgentCount(): number {
  return tunnels.size;
}

export function getTunnelForAgent(address: string): TunnelConnection | undefined {
  return tunnels.get(address.toLowerCase());
}

export function _getIpConnectionCountForTesting(ip: string): number {
  return ipConnectionCount.get(ip) ?? 0;
}

function agentUrl(address: string): string {
  return `https://${address}.${BASE_DOMAIN}`;
}

function send(ws: WebSocket, frame: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch { /* socket closing; teardown will run from onclose */ }
}

function acquireIpSlot(clientIp: string): boolean {
  const current = ipConnectionCount.get(clientIp) ?? 0;
  if (current >= MAX_CONNECTIONS_PER_IP) return false;
  ipConnectionCount.set(clientIp, current + 1);
  return true;
}

function releaseIpSlot(clientIp: string): void {
  const count = ipConnectionCount.get(clientIp) ?? 0;
  if (count <= 1) {
    ipConnectionCount.delete(clientIp);
  } else {
    ipConnectionCount.set(clientIp, count - 1);
  }
}

// --- Registration and takeover --------------------------------------------------------------
//
// A freshly authenticated tunnel proves possession of the agent's key, so the newest connection
// always wins. This keeps a user from being locked out of their own agent for up to 90 s after a
// network blip (old socket still waiting on missed pings while the new one is rejected).

/**
 * Drops `address` from `conn` without the connection asking for it, telling the client why.
 * Closes the socket when it no longer carries any agents.
 */
function evictAgent(conn: TunnelConnection, address: string, reason: "superseded"): void {
  conn.agents.delete(address);
  if (tunnels.get(address) === conn) tunnels.delete(address);
  send(conn.ws, { type: "agent_removed", address, reason });
  log("info", "tunnel.agent_evicted", { agent: address, reason, conn: conn.id });
  if (conn.agents.size === 0) {
    try {
      conn.ws.close(1000, reason);
    } catch { /* already closed */ }
    teardown(conn);
  }
}

/**
 * Registers a set of verified addresses on `conn`, evicting any prior local holder and taking
 * over any Redis claim held by another machine. Redis is consulted once (pipelined) for the
 * whole batch. Never throws.
 */
async function registerAgents(conn: TunnelConnection, addresses: string[]): Promise<string[]> {
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase())));
  for (const address of unique) {
    const existing = tunnels.get(address);
    if (existing && existing !== conn) {
      recordTakeover();
      evictAgent(existing, address, "superseded");
    }
    conn.agents.add(address);
    tunnels.set(address, conn);
    invalidateCachedOwner(address);
  }

  const claims = await claimAgents(unique);
  claims.forEach((claim, i) => {
    if (claim.previousOwner) {
      recordTakeover();
      log("info", "tunnel.takeover", {
        agent: unique[i],
        previous_owner: claim.previousOwner,
        conn: conn.id,
      });
    }
    if (claim.degraded) {
      log("warn", "tunnel.claim_degraded", { agent: unique[i], conn: conn.id });
    }
  });

  // The connection may have been torn down while we awaited Redis (client hung up mid-auth).
  // Nothing to roll back in Redis: teardown already released whatever it held.
  return unique.filter((address) => conn.agents.has(address));
}

function unregisterAgent(conn: TunnelConnection, address: string): void {
  const lower = address.toLowerCase();
  conn.agents.delete(lower);
  if (tunnels.get(lower) === conn) {
    tunnels.delete(lower);
    invalidateCachedOwner(lower);
    releaseAgent(lower).catch(() => {}); // fire-and-forget; releaseAgent already logs
  }
}

function teardown(conn: TunnelConnection): void {
  if (!connections.has(conn.ws) && conn.agents.size === 0 && conn.pending.size === 0) {
    // Already torn down (close + error can both fire, or eviction followed by onclose).
    return;
  }
  clearInterval(conn.keepaliveTimer);
  if (conn.pendingNonceTimer !== null) {
    clearTimeout(conn.pendingNonceTimer);
  }
  for (const addr of conn.agents) {
    if (tunnels.get(addr) === conn) {
      tunnels.delete(addr);
      invalidateCachedOwner(addr);
      releaseAgent(addr).catch(() => {});
    }
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
  teardownStreaming(conn);
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
    send(conn.ws, { type: "ping", ts: Math.floor(Date.now() / 1000) });
  }, KEEPALIVE_INTERVAL_MS);
}

function handleResponse(conn: TunnelConnection, frame: ResponseFrame): void {
  const pending = conn.pending.get(frame.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  conn.pending.delete(frame.id);
  pending.resolve(frame);
}

async function handlePong(conn: TunnelConnection): Promise<void> {
  conn.missedPings = 0;
  const lost = await refreshAgentsTTL(conn.agents);
  // Another machine took over these addresses (the host reconnected elsewhere). Drop our stale
  // registrations so requests that still reach us are routed onward instead of served twice.
  for (const address of lost) {
    if (conn.agents.has(address)) {
      recordTakeover();
      evictAgent(conn, address, "superseded");
    }
  }
}

async function handleAddAgent(
  conn: TunnelConnection,
  frame: AddAgentFrame,
): Promise<void> {
  if (!controlFrameLimiter.allow(conn.id)) {
    send(conn.ws, { type: "error", error: "rate_limited" });
    return;
  }

  if (conn.agents.size >= MAX_AGENTS_PER_TUNNEL) {
    send(conn.ws, { type: "error", error: "max_agents_reached" });
    return;
  }

  if (!conn.pendingNonce || conn.pendingNonce !== frame.nonce) {
    send(conn.ws, { type: "error", error: "invalid_nonce" });
    return;
  }

  const nonce = conn.pendingNonce;
  conn.pendingNonce = null;
  if (conn.pendingNonceTimer !== null) {
    clearTimeout(conn.pendingNonceTimer);
    conn.pendingNonceTimer = null;
  }

  const addr = await verifyAgent(
    { address: frame.address, signature: frame.signature },
    nonce,
    frame.timestamp,
  );
  if (!addr) {
    send(conn.ws, { type: "error", error: "invalid_signature" });
    return;
  }

  const [registered] = await registerAgents(conn, [addr]);
  if (!registered) {
    send(conn.ws, { type: "error", error: "address_already_registered" });
    return;
  }

  send(conn.ws, {
    type: "agent_added",
    address: addr,
    url: agentUrl(addr),
    region: FLY_REGION,
  });
}

function handleRequestChallenge(conn: TunnelConnection): void {
  if (!controlFrameLimiter.allow(conn.id)) {
    send(conn.ws, { type: "error", error: "rate_limited" });
    return;
  }

  if (conn.pendingNonceTimer !== null) {
    clearTimeout(conn.pendingNonceTimer);
  }

  const nonce = generateNonce();
  conn.pendingNonce = nonce;
  conn.pendingNonceTimer = setTimeout(() => {
    conn.pendingNonce = null;
    conn.pendingNonceTimer = null;
  }, NONCE_EXPIRY_MS);

  send(conn.ws, { type: "challenge", nonce });
}

function handleRemoveAgent(
  conn: TunnelConnection,
  frame: RemoveAgentFrame,
): void {
  const lower = frame.address.toLowerCase();
  if (!conn.agents.has(lower)) return;
  unregisterAgent(conn, lower);
  send(conn.ws, { type: "agent_removed", address: lower });
}

function dispatch(conn: TunnelConnection, frame: InboundFrame): void | Promise<void> {
  switch (frame.type) {
    case "pong":
      return handlePong(conn);
    case "response":
      return handleResponse(conn, frame);
    case "stream_start":
      return handleStreamStart(conn, frame);
    case "stream_chunk":
      return handleStreamChunk(conn, frame);
    case "stream_end":
      return handleStreamEnd(conn, frame);
    case "add_agent":
      return handleAddAgent(conn, frame);
    case "remove_agent":
      return handleRemoveAgent(conn, frame);
    case "request_challenge":
      return handleRequestChallenge(conn);
  }
}

function onMessage(conn: TunnelConnection, data: string): void {
  const parsed = parseInboundFrame(data);
  if (!parsed.ok) {
    recordInvalidFrame();
    log("debug", "tunnel.invalid_frame", { conn: conn.id, reason: parsed.reason });
    // If the garbage names a request we are waiting on, fail that caller now rather than
    // letting it sit until the 30s timeout.
    if (parsed.id) failRequest(conn, parsed.id, parsed.reason);
    return;
  }
  // Handlers must never throw into the WebSocket event loop: an unhandled rejection would take
  // down the whole process (and every tunnel on this machine).
  try {
    const result = dispatch(conn, parsed.frame);
    if (result instanceof Promise) {
      result.catch((err) => logHandlerError(conn, parsed.frame.type, err));
    }
  } catch (err) {
    logHandlerError(conn, parsed.frame.type, err);
  }
}

function logHandlerError(conn: TunnelConnection, frameType: string, err: unknown): void {
  log("error", "tunnel.handler_error", {
    conn: conn.id,
    frame: frameType,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
}

export function handleTunnelConnect(req: Request, clientIp: string): Response {
  if (!acquireIpSlot(clientIp)) {
    return jsonResponse(429, { error: "too_many_connections" });
  }

  let socket: WebSocket;
  let response: Response;
  try {
    ({ socket, response } = Deno.upgradeWebSocket(req));
  } catch {
    releaseIpSlot(clientIp);
    return jsonResponse(400, { error: "websocket_required" });
  }

  const conn: TunnelConnection = {
    id: crypto.randomUUID(),
    ws: socket,
    clientIp,
    agents: new Set(),
    pending: new Map<string, PendingRequest>(),
    streaming: new Map<string, StreamingRequest>(),
    missedPings: 0,
    keepaliveTimer: undefined,
    pendingNonce: null,
    pendingNonceTimer: null,
  };

  let authenticated = false;
  let closed = false;
  let challengeNonce: string | null = null;

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      send(socket, { type: "auth_error", error: "auth_timeout" });
      try {
        socket.close(4001, "auth timeout");
      } catch { /* socket may not be open yet */ }
    }
  }, AUTH_TIMEOUT_MS);

  const rejectAuth = (error: string, code: number, reason: string) => {
    send(socket, { type: "auth_error", error });
    try {
      socket.close(code, reason);
    } catch { /* already closed */ }
  };

  const authenticate = async (data: string): Promise<void> => {
    const parsed = parseAuthFrame(data);
    if (!parsed.ok) {
      recordInvalidFrame();
      if (parsed.reason === "invalid_json") {
        rejectAuth("invalid_json", 4000, "invalid json");
      } else {
        rejectAuth("expected_auth_frame", 4000, "expected auth frame");
      }
      return;
    }
    const frame = parsed.frame;

    if (frame.nonce !== challengeNonce) {
      challengeNonce = null;
      rejectAuth("invalid_nonce", 4000, "invalid nonce");
      return;
    }
    challengeNonce = null;

    if (frame.agents.length === 0) {
      rejectAuth("no_agents", 4000, "no agents");
      return;
    }

    if (frame.agents.length > MAX_AGENTS_PER_TUNNEL) {
      rejectAuth("too_many_agents", 4000, "too many agents");
      return;
    }

    const verified = await verifyAuth(frame.agents, frame.nonce, frame.timestamp);
    if (!verified) {
      rejectAuth("signature_verification_failed", 4001, "auth failed");
      return;
    }
    if (closed) return; // client hung up while we were verifying

    clearTimeout(authTimeout);
    authenticated = true;
    connections.set(socket, conn);
    recordTunnelConnect();

    const registered = await registerAgents(conn, verified);
    if (closed) {
      // Client hung up while we were claiming. Teardown already ran; make sure no claim we
      // just wrote outlives the connection (compare-and-delete only removes our own).
      for (const addr of verified) releaseAgent(addr).catch(() => {});
      return;
    }

    send(socket, {
      type: "auth_ok",
      agents: registered.map((addr) => ({ address: addr, url: agentUrl(addr) })),
      region: FLY_REGION,
    });
    log("info", "tunnel.connected", {
      conn: conn.id,
      client_ip: clientIp,
      agents: registered.length,
    });

    startKeepalive(conn);
  };

  socket.onopen = () => {
    challengeNonce = generateNonce();
    send(socket, { type: "challenge", nonce: challengeNonce });
  };

  socket.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (!data) return;

    if (!authenticated) {
      authenticate(data).catch((err) => {
        logHandlerError(conn, "auth", err);
        rejectAuth("internal_error", 1011, "internal error");
      });
      return;
    }

    onMessage(conn, data);
  };

  const onGone = () => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimeout);
    releaseIpSlot(clientIp);
    if (authenticated) {
      log("info", "tunnel.disconnected", { conn: conn.id, agents: conn.agents.size });
      teardown(conn);
    }
  };
  socket.onclose = onGone;
  socket.onerror = onGone;

  return response;
}

// --- Shutdown -------------------------------------------------------------------------------

/**
 * Tells every connected host the relay is restarting and closes its socket so it reconnects
 * (to another machine) immediately instead of discovering the loss via missed pings. Releases
 * Redis claims so other machines can take the addresses right away.
 */
export function closeAllTunnels(reason: string): number {
  const conns = Array.from(connections.values());
  for (const conn of conns) {
    send(conn.ws, { type: "error", error: reason });
    try {
      conn.ws.close(1012, reason);
    } catch { /* already closed */ }
    teardown(conn);
  }
  return conns.length;
}

/** Requests still awaiting a host answer or mid-stream, across all connections. */
export function totalInflight(): number {
  let n = 0;
  for (const conn of connections.values()) n += inflightCount(conn);
  return n;
}
