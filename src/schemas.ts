import { z } from "zod";

// --- Tunnel: agent auth ---

export const AgentAuthSchema = z.object({
  address: z.string(),
  signature: z.string(),
});

// --- Tunnel: inbound frames ---

export const AuthFrameSchema = z.object({
  type: z.literal("auth"),
  agents: z.array(AgentAuthSchema),
  nonce: z.string(),
  timestamp: z.number(),
});

export const AddAgentFrameSchema = z.object({
  type: z.literal("add_agent"),
  address: z.string(),
  signature: z.string(),
  nonce: z.string(),
  timestamp: z.number(),
});

export const RemoveAgentFrameSchema = z.object({
  type: z.literal("remove_agent"),
  address: z.string(),
});

export const PongFrameSchema = z.object({
  type: z.literal("pong"),
  ts: z.number(),
});

export const ResponseFrameSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export const StreamStartFrameSchema = z.object({
  type: z.literal("stream_start"),
  id: z.string(),
  status: z.number(),
  headers: z.record(z.string(), z.string()),
});

export const StreamChunkFrameSchema = z.object({
  type: z.literal("stream_chunk"),
  id: z.string(),
  data: z.string(),
});

export const StreamEndFrameSchema = z.object({
  type: z.literal("stream_end"),
  id: z.string(),
});

export const RequestChallengeFrameSchema = z.object({
  type: z.literal("request_challenge"),
});

export const InboundFrameSchema = z.discriminatedUnion("type", [
  AuthFrameSchema,
  AddAgentFrameSchema,
  RemoveAgentFrameSchema,
  PongFrameSchema,
  ResponseFrameSchema,
  StreamStartFrameSchema,
  StreamChunkFrameSchema,
  StreamEndFrameSchema,
  RequestChallengeFrameSchema,
]);

// --- Pair: Redis session ---

export const PairSessionSchema = z.object({
  initiatorAddress: z.string(),
  state: z.enum(["pending", "approved"]),
  approverAddress: z.string().optional(),
  confirmCode: z.string().optional(),
  approverSignature: z.string().optional(),
  approverTimestamp: z.number().optional(),
});

// --- Pair: request bodies ---

export const PairInitiateBodySchema = z.object({
  agentAddress: z.string(),
  timestamp: z.number(),
  signature: z.string(),
});

export const PairApproveBodySchema = z.object({
  code: z.string(),
  pairingAddress: z.string(),
  confirmCode: z.string().regex(/^\d{4}$/),
  timestamp: z.number(),
  signature: z.string(),
});
