// Structured JSON logging + per-request timing. One line per event to stdout so Fly's log
// shipper (and anything downstream) can parse fields without regexes.

import { FLY_MACHINE_ID, FLY_REGION } from "./env.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (Deno.env.get("LOG_LEVEL") as LogLevel | undefined) ?? "info";

let sink: (line: string) => void = (line) => console.log(line);

/** Test hook: capture log lines instead of writing to stdout. */
export function _setLogSinkForTesting(fn: ((line: string) => void) | null): void {
  sink = fn ?? ((line) => console.log(line));
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[MIN_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    region: FLY_REGION,
    machine: FLY_MACHINE_ID,
    ...fields,
  };
  try {
    sink(JSON.stringify(line));
  } catch {
    // Never let logging take down the request path.
  }
}

/** How a request reached this machine, derived from Fly's replay-cache header. */
export type ReplayStatus = "direct" | "hit" | "miss" | "bypass" | "internal";

export function replayStatusOf(req: Request): ReplayStatus {
  if (req.headers.get("x-relay-internal-hop") === "1") return "internal";
  const status = req.headers.get("fly-replay-cache-status");
  if (status === "hit" || status === "miss" || status === "bypass") return status;
  return "direct";
}

/**
 * Per-request timing context. Created when a request enters `relayRequest`, carried through the
 * pending/streaming maps, and finalized exactly once when the response is complete or fails.
 */
export interface RequestContext {
  agent: string;
  method: string;
  path: string;
  clientIp: string;
  replay: ReplayStatus;
  startedAt: number;
  lookupMs: number | null;
  dispatchedAt: number | null;
  firstByteAt: number | null;
  bodyBytes: number;
  responseBytes: number;
  /** Status sent to the caller once known (set at first byte for streams). */
  status: number | null;
  done: boolean;
}

export function newRequestContext(
  agent: string,
  req: Request,
  clientIp: string,
): RequestContext {
  const url = new URL(req.url);
  return {
    agent,
    method: req.method,
    path: url.pathname,
    clientIp,
    replay: replayStatusOf(req),
    startedAt: performance.now(),
    lookupMs: null,
    dispatchedAt: null,
    firstByteAt: null,
    bodyBytes: 0,
    responseBytes: 0,
    status: null,
    done: false,
  };
}

export function markFirstByte(ctx: RequestContext): void {
  if (ctx.firstByteAt === null) ctx.firstByteAt = performance.now();
}

/** Milliseconds from dispatch to the host's first byte, or null if never answered. */
function hostMs(ctx: RequestContext): number | null {
  if (ctx.dispatchedAt === null || ctx.firstByteAt === null) return null;
  return round(ctx.firstByteAt - ctx.dispatchedAt);
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/**
 * Builds the `Server-Timing` header value for a response. `lookup` is time spent resolving the
 * owning machine (Redis / route cache); `host` is time waiting on the Osaurus host.
 */
export function serverTiming(ctx: RequestContext): string {
  const parts: string[] = [];
  if (ctx.lookupMs !== null) parts.push(`lookup;dur=${round(ctx.lookupMs)}`);
  const host = hostMs(ctx);
  if (host !== null) parts.push(`host;dur=${host}`);
  parts.push(`relay;dur=${round(performance.now() - ctx.startedAt)}`);
  return parts.join(", ");
}

/** Relay identity headers so callers can see which region/machine served them. */
export function applyRelayHeaders(headers: Headers, ctx: RequestContext): void {
  headers.set("x-relay-region", FLY_REGION);
  headers.set("x-relay-machine", FLY_MACHINE_ID);
  headers.set("server-timing", serverTiming(ctx));
}

/** Emits the single completion log line for a relayed request. Idempotent. */
export function finishRequest(
  ctx: RequestContext,
  status: number | null,
  outcome: string,
  extra: Record<string, unknown> = {},
): void {
  if (ctx.done) return;
  ctx.done = true;
  if (status !== null) ctx.status = status;
  const now = performance.now();
  log("info", "relay.request", {
    agent: ctx.agent,
    method: ctx.method,
    path: ctx.path,
    client_ip: ctx.clientIp,
    status: ctx.status,
    outcome,
    replay: ctx.replay,
    ttfb_ms: ctx.firstByteAt === null ? null : round(ctx.firstByteAt - ctx.startedAt),
    host_ms: hostMs(ctx),
    lookup_ms: ctx.lookupMs === null ? null : round(ctx.lookupMs),
    total_ms: round(now - ctx.startedAt),
    body_bytes: ctx.bodyBytes,
    response_bytes: ctx.responseBytes,
    ...extra,
  });
}
