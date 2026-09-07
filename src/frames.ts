// Runtime validation for frames received from Osaurus hosts. The host is authenticated but not
// trusted to be well-formed: a malformed frame must never throw inside a WebSocket handler
// (which would leave a caller hanging or, unhandled, take the process down).

import { z } from "zod";
import type { AuthFrame, InboundFrame } from "./types.ts";

/** Upper bound on a buffered response body carried in a single `response` frame. */
export const MAX_RESPONSE_BODY_CHARS = 10 * 1024 * 1024; // 10 MB
/** Upper bound on a single `stream_chunk` payload. */
export const MAX_STREAM_CHUNK_CHARS = 1024 * 1024; // 1 MB
const MAX_HEADERS = 128;
const MAX_HEADER_VALUE_CHARS = 16 * 1024;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexSignature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const nonce = z.string().min(1).max(128);
const frameId = z.string().min(1).max(64);
const timestamp = z.number().int().nonnegative();

const headers = z.record(z.string().max(256), z.string().max(MAX_HEADER_VALUE_CHARS))
  .refine((h) => Object.keys(h).length <= MAX_HEADERS, { message: "too many headers" });

const agentAuth = z.object({ address, signature: hexSignature });

export const authFrameSchema = z.object({
  type: z.literal("auth"),
  // Count limits are enforced by the tunnel so it can answer with the specific error codes
  // clients already understand (`no_agents`, `too_many_agents`).
  agents: z.array(agentAuth),
  nonce,
  timestamp,
});

const addAgent = z.object({
  type: z.literal("add_agent"),
  address,
  signature: hexSignature,
  nonce,
  timestamp,
});

const removeAgent = z.object({ type: z.literal("remove_agent"), address });

const pong = z.object({ type: z.literal("pong"), ts: z.number().optional() });

const response = z.object({
  type: z.literal("response"),
  id: frameId,
  status: z.number().int(),
  headers,
  body: z.string().max(MAX_RESPONSE_BODY_CHARS).optional().default(""),
});

const streamStart = z.object({
  type: z.literal("stream_start"),
  id: frameId,
  status: z.number().int(),
  headers,
});

const streamChunk = z.object({
  type: z.literal("stream_chunk"),
  id: frameId,
  data: z.string().max(MAX_STREAM_CHUNK_CHARS),
});

const streamEnd = z.object({ type: z.literal("stream_end"), id: frameId });

const requestChallenge = z.object({ type: z.literal("request_challenge") });

export const inboundFrameSchema = z.discriminatedUnion("type", [
  addAgent,
  removeAgent,
  pong,
  response,
  streamStart,
  streamChunk,
  streamEnd,
  requestChallenge,
]);

export type ParseFailure = {
  ok: false;
  reason: "invalid_json" | "invalid_frame" | "oversized";
  /** Best-effort request id from the malformed frame, so the waiting caller can be failed fast. */
  id?: string;
};
export type ParseResult<T> = { ok: true; frame: T } | ParseFailure;

function parseJson(data: string): unknown | undefined {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function parseInboundFrame(data: string): ParseResult<InboundFrame> {
  const raw = parseJson(data);
  if (raw === undefined) return { ok: false, reason: "invalid_json" };
  const result = inboundFrameSchema.safeParse(raw);
  if (!result.success) {
    const tooBig = result.error.issues.some((i) => i.code === "too_big");
    const id = typeof raw === "object" && raw !== null && "id" in raw &&
        typeof (raw as { id: unknown }).id === "string"
      ? (raw as { id: string }).id
      : undefined;
    return { ok: false, reason: tooBig ? "oversized" : "invalid_frame", id };
  }
  return { ok: true, frame: result.data as InboundFrame };
}

export function parseAuthFrame(data: string): ParseResult<AuthFrame> {
  const raw = parseJson(data);
  if (raw === undefined) return { ok: false, reason: "invalid_json" };
  const result = authFrameSchema.safeParse(raw);
  if (!result.success) return { ok: false, reason: "invalid_frame" };
  return { ok: true, frame: result.data };
}
