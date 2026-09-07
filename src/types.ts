import type { RequestContext } from "./observability.ts";

// --- Agent types ---

export interface AgentAuth {
  address: string;
  signature: string;
}

export interface AgentInfo {
  address: string;
  url: string;
}

// --- Inbound frames (Osaurus client -> relay) ---

export interface AuthFrame {
  type: "auth";
  agents: AgentAuth[];
  nonce: string;
  timestamp: number;
}

export interface AddAgentFrame {
  type: "add_agent";
  address: string;
  signature: string;
  nonce: string;
  timestamp: number;
}

export interface RemoveAgentFrame {
  type: "remove_agent";
  address: string;
}

export interface PongFrame {
  type: "pong";
  ts: number;
}

export interface ResponseFrame {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface StreamStartFrame {
  type: "stream_start";
  id: string;
  status: number;
  headers: Record<string, string>;
}

export interface StreamChunkFrame {
  type: "stream_chunk";
  id: string;
  data: string;
}

export interface StreamEndFrame {
  type: "stream_end";
  id: string;
}

export interface RequestChallengeFrame {
  type: "request_challenge";
}

export type InboundFrame =
  | AuthFrame
  | AddAgentFrame
  | RemoveAgentFrame
  | PongFrame
  | ResponseFrame
  | StreamStartFrame
  | StreamChunkFrame
  | StreamEndFrame
  | RequestChallengeFrame;

// --- Outbound frames (relay -> Osaurus client) ---

export interface AuthOkFrame {
  type: "auth_ok";
  agents: AgentInfo[];
  rejected?: { address: string; reason: string }[];
  /** Fly region of the relay machine that terminated this tunnel (diagnostics). */
  region?: string;
}

export interface AuthErrorFrame {
  type: "auth_error";
  error: string;
}

export interface AgentAddedFrame {
  type: "agent_added";
  address: string;
  url: string;
  region?: string;
}

export interface AgentRemovedFrame {
  type: "agent_removed";
  address: string;
  /**
   * Present when the relay removed the agent on its own: `superseded` means a newer
   * authenticated tunnel for the same address took over (this connection should NOT
   * auto-reconnect for that address, or the two sessions will evict each other in a loop).
   */
  reason?: "superseded";
}

export interface PingFrame {
  type: "ping";
  ts: number;
}

export interface RequestFrame {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ErrorFrame {
  type: "error";
  error: string;
}

export interface ChallengeFrame {
  type: "challenge";
  nonce: string;
}

/**
 * Tells the Osaurus client to abandon an in-flight request. Sent when the
 * public caller disconnects (closed tab, "stop", network drop) or when a relay
 * timeout fires, so the host tears down the generation instead of streaming
 * into a dead connection.
 */
export interface CancelFrame {
  type: "cancel";
  id: string;
}

export type OutboundFrame =
  | AuthOkFrame
  | AuthErrorFrame
  | AgentAddedFrame
  | AgentRemovedFrame
  | PingFrame
  | RequestFrame
  | ErrorFrame
  | ChallengeFrame
  | CancelFrame;

// --- Timers ---

/**
 * Handle returned by setTimeout/setInterval. This is `number` under Deno's own
 * lib types, but becomes `NodeJS.Timeout` once @types/node is in scope (pulled
 * in transitively by the npm deps when `deno install` materializes a
 * node_modules dir, e.g. in the Docker build). Deriving the type from the
 * timer functions keeps the code type-checking in both environments.
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

// --- Pending request tracking ---

export interface PendingRequest {
  resolve: (response: ResponseFrame) => void;
  resolveStream: (response: StreamStartFrame) => void;
  timer: TimerHandle;
  ctx: RequestContext;
}

// --- Active streaming request tracking ---

export interface StreamingRequest {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timer: TimerHandle;
  ctx: RequestContext;
}

// --- Tunnel connection state ---

export interface TunnelConnection {
  /** Opaque per-connection id (rate-limit key for post-auth control frames, log correlation). */
  id: string;
  ws: WebSocket;
  clientIp: string;
  agents: Set<string>;
  pending: Map<string, PendingRequest>;
  streaming: Map<string, StreamingRequest>;
  missedPings: number;
  keepaliveTimer: TimerHandle | undefined;
  pendingNonce: string | null;
  pendingNonceTimer: TimerHandle | null;
}
