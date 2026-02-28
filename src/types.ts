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
}

export interface AuthErrorFrame {
  type: "auth_error";
  error: string;
}

export interface AgentAddedFrame {
  type: "agent_added";
  address: string;
  url: string;
}

export interface AgentRemovedFrame {
  type: "agent_removed";
  address: string;
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

export type OutboundFrame =
  | AuthOkFrame
  | AuthErrorFrame
  | AgentAddedFrame
  | AgentRemovedFrame
  | PingFrame
  | RequestFrame
  | ErrorFrame
  | ChallengeFrame;

// --- Pending request tracking ---

export interface PendingRequest {
  resolve: (response: ResponseFrame) => void;
  resolveStream: (response: StreamStartFrame) => void;
  timer: number;
}

// --- Active streaming request tracking ---

export interface StreamingRequest {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timer: number;
}

// --- Tunnel connection state ---

export interface TunnelConnection {
  ws: WebSocket;
  agents: Set<string>;
  pending: Map<string, PendingRequest>;
  streaming: Map<string, StreamingRequest>;
  missedPings: number;
  keepaliveTimer: number;
  pendingNonce: string | null;
  pendingNonceTimer: number | null;
}
