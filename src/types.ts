import type { z } from "zod";
import type {
  AddAgentFrameSchema,
  AgentAuthSchema,
  AuthFrameSchema,
  InboundFrameSchema,
  PairSessionSchema,
  PongFrameSchema,
  RemoveAgentFrameSchema,
  RequestChallengeFrameSchema,
  ResponseFrameSchema,
  StreamChunkFrameSchema,
  StreamEndFrameSchema,
  StreamStartFrameSchema,
} from "./schemas.ts";

export type PairSession = z.infer<typeof PairSessionSchema>;

// --- Agent types ---

export type AgentAuth = z.infer<typeof AgentAuthSchema>;

export interface AgentInfo {
  address: string;
  url: string;
}

// --- Inbound frames (Osaurus client -> relay) ---

export type AuthFrame = z.infer<typeof AuthFrameSchema>;
export type AddAgentFrame = z.infer<typeof AddAgentFrameSchema>;
export type RemoveAgentFrame = z.infer<typeof RemoveAgentFrameSchema>;
export type PongFrame = z.infer<typeof PongFrameSchema>;
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;
export type StreamStartFrame = z.infer<typeof StreamStartFrameSchema>;
export type StreamChunkFrame = z.infer<typeof StreamChunkFrameSchema>;
export type StreamEndFrame = z.infer<typeof StreamEndFrameSchema>;
export type RequestChallengeFrame = z.infer<typeof RequestChallengeFrameSchema>;
export type InboundFrame = z.infer<typeof InboundFrameSchema>;

// --- Outbound frames (relay -> Osaurus client) ---

export interface AuthOkFrame {
  type: "auth_ok";
  agents: AgentInfo[];
  rejected?: { address: string; reason: string }[];
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
  clientIp: string;
  agents: Set<string>;
  pending: Map<string, PendingRequest>;
  streaming: Map<string, StreamingRequest>;
  missedPings: number;
  keepaliveTimer: number;
  pendingNonce: string | null;
  pendingNonceTimer: number | null;
}
