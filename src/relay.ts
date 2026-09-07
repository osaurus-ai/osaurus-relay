import { getTunnelForAgent } from "./tunnel.ts";
import {
  recordBadHostResponse,
  recordInternalForward,
  recordReplay,
  recordRequest,
  recordSlowConsumerAbort,
} from "./stats.ts";
import {
  buildHostResponse,
  jsonResponse,
  readBody,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from "./http.ts";
import { FLY_MACHINE_ID, lookupAgentInstance } from "./redis.ts";
import { FLY_APP_NAME } from "./env.ts";
import { getCachedOwner, setCachedOwner } from "./route_cache.ts";
import { callerLimiter, requestLimiter } from "./rate_limit.ts";
import {
  applyRelayHeaders,
  finishRequest,
  log,
  markFirstByte,
  newRequestContext,
  type RequestContext,
} from "./observability.ts";
import type {
  ResponseFrame,
  StreamChunkFrame,
  StreamEndFrame,
  StreamStartFrame,
  TunnelConnection,
} from "./types.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// Fly Proxy cannot replay a request whose body exceeds 1 MB; larger bodies are forwarded to the
// owning machine over the private network instead.
const REPLAY_MAX_BODY_BYTES = 1024 * 1024;

// How long Fly's edge may route requests for an agent hostname straight to the owning machine
// without consulting us. Short so a host that reconnects to a different machine converges fast.
const REPLAY_CACHE_TTL_SECS = 30;

// Backpressure: bytes we are willing to hold for a caller that reads slower than the host
// streams. `highWaterMark` is the point at which desiredSize goes negative; the cap is where we
// give up and cancel the host so one slow consumer cannot exhaust machine memory.
const STREAM_HIGH_WATER_MARK_BYTES = 1024 * 1024; // 1 MB
const STREAM_BUFFER_CAP_BYTES = 4 * 1024 * 1024; // 4 MB

const INTERNAL_HOP_HEADER = "x-relay-internal-hop";
const INTERNAL_HOST_HEADER = "x-relay-original-host";
const INTERNAL_CLIENT_IP_HEADER = "x-relay-client-ip";
const INTERNAL_PORT = parseInt(Deno.env.get("PORT") ?? "8080");

const encoder = new TextEncoder();

type InternalTargetResolver = (machineId: string) => string;
let internalTargetFor: InternalTargetResolver = (machineId) =>
  `http://${machineId}.vm.${FLY_APP_NAME}.internal:${INTERNAL_PORT}`;

/** Test hook: point machine-to-machine forwarding at an arbitrary base URL. */
export function _setInternalTargetResolverForTesting(fn: InternalTargetResolver | null): void {
  internalTargetFor = fn ??
    ((machineId) => `http://${machineId}.vm.${FLY_APP_NAME}.internal:${INTERNAL_PORT}`);
}

export function isInternalHop(req: Request): boolean {
  return req.headers.get(INTERNAL_HOP_HEADER) === "1";
}

export function internalOriginalHost(req: Request): string | null {
  return isInternalHop(req) ? req.headers.get(INTERNAL_HOST_HEADER) : null;
}

export function internalClientIp(req: Request): string | null {
  return isInternalHop(req) ? req.headers.get(INTERNAL_CLIENT_IP_HEADER) : null;
}

export async function relayRequest(
  agentAddress: string,
  req: Request,
  clientIp: string,
): Promise<Response> {
  const ctx = newRequestContext(agentAddress, req, clientIp);
  const conn = getTunnelForAgent(agentAddress);

  if (!conn) {
    return await routeElsewhere(agentAddress, req, clientIp, ctx);
  }

  // Only the owning machine counts and limits: first-hop machines that merely route a request
  // must not charge the agent's budget or the caller's.
  if (!requestLimiter.allow(agentAddress)) {
    return finish(ctx, jsonResponse(429, { error: "rate_limited" }), "agent_rate_limited");
  }
  if (!callerLimiter.allow(clientIp)) {
    return finish(ctx, jsonResponse(429, { error: "rate_limited" }), "caller_rate_limited");
  }

  recordRequest();

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_BODY_BYTES) {
    return finish(ctx, jsonResponse(413, { error: "body_too_large" }), "body_too_large");
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) {
    return finish(ctx, jsonResponse(413, { error: "body_too_large" }), "body_too_large");
  }
  ctx.bodyBytes = body.bytes;

  const url = new URL(req.url);
  const id = crypto.randomUUID();

  const headers = sanitizeRequestHeaders(req);
  headers["x-agent-address"] = agentAddress;
  headers["x-forwarded-for"] = clientIp;

  const frame = {
    type: "request" as const,
    id,
    method: req.method,
    path: url.pathname + url.search,
    headers,
    body: body.text,
  };

  return sendAndAwait(conn, id, frame, req.signal, ctx);
}

/** Attaches relay identity/timing headers and emits the completion log for a local response. */
function finish(ctx: RequestContext, resp: Response, outcome: string): Response {
  applyRelayHeaders(resp.headers, ctx);
  finishRequest(ctx, resp.status, outcome);
  return resp;
}

// --- Cross-machine routing ------------------------------------------------------------------

async function resolveOwner(agentAddress: string, ctx: RequestContext): Promise<string | null> {
  const t0 = performance.now();
  const cached = getCachedOwner(agentAddress);
  if (cached !== undefined) {
    ctx.lookupMs = performance.now() - t0;
    return cached;
  }
  const owner = await lookupAgentInstance(agentAddress);
  // A Redis entry naming *this* machine is stale (we have no tunnel for it): treat as nobody.
  const effective = owner === FLY_MACHINE_ID ? null : owner;
  setCachedOwner(agentAddress, effective);
  ctx.lookupMs = performance.now() - t0;
  return effective;
}

function bodyMayExceedReplayLimit(req: Request): boolean {
  if (!req.body) return false;
  const contentLength = req.headers.get("content-length");
  if (contentLength === null) return true; // unknown length: cannot prove it fits
  const n = parseInt(contentLength);
  return !Number.isFinite(n) || n > REPLAY_MAX_BODY_BYTES;
}

async function routeElsewhere(
  agentAddress: string,
  req: Request,
  clientIp: string,
  ctx: RequestContext,
): Promise<Response> {
  // A request forwarded by another relay machine is terminal: we either have the tunnel or the
  // agent is gone. Never bounce it again.
  if (isInternalHop(req)) {
    return finish(ctx, jsonResponse(502, { error: "agent_offline" }), "agent_offline");
  }

  const owner = await resolveOwner(agentAddress, ctx);
  if (!owner) {
    return finish(ctx, jsonResponse(502, { error: "agent_offline" }), "agent_offline");
  }

  if (bodyMayExceedReplayLimit(req)) {
    return await forwardInternal(owner, agentAddress, req, clientIp, ctx);
  }

  recordReplay();
  const headers = new Headers({ "fly-replay": `instance=${owner}` });
  if (ctx.replay === "hit") {
    // Fly's edge cached a replay decision that pointed here, but the host has since moved.
    // Replay to the current owner and drop the stale cache entry; the next request from that
    // edge will consult us again and re-populate the cache. (Fly does not define behaviour for
    // a cached replay whose target issues another cached replay, so no cache headers here.)
    headers.set("fly-replay-cache", "invalidate");
  } else {
    const host = (req.headers.get("host") ?? "").split(":")[0];
    if (host) {
      headers.set("fly-replay-cache", `${host}/*`);
      headers.set("fly-replay-cache-ttl-secs", String(REPLAY_CACHE_TTL_SECS));
    }
  }
  const resp = new Response(null, { status: 307, headers });
  return finish(ctx, resp, ctx.replay === "hit" ? "replay_stale_hit" : "replay");
}

/**
 * Forwards a request to the owning machine over Fly's private network. Used when the body is too
 * large for Fly Proxy to replay. The body is streamed through, not buffered, and the response is
 * streamed back.
 */
async function forwardInternal(
  owner: string,
  agentAddress: string,
  req: Request,
  clientIp: string,
  ctx: RequestContext,
): Promise<Response> {
  recordInternalForward();
  const url = new URL(req.url);
  const target = `${internalTargetFor(owner)}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set(INTERNAL_HOP_HEADER, "1");
  headers.set(INTERNAL_HOST_HEADER, req.headers.get("host") ?? "");
  headers.set(INTERNAL_CLIENT_IP_HEADER, clientIp);
  // Strip anything Fly Proxy added for this hop; the owner will see our 6PN address, not the
  // proxy, and must take the client IP from x-relay-client-ip instead.
  for (const key of Array.from(headers.keys())) {
    if (key.startsWith("fly-")) headers.delete(key);
  }
  headers.delete("host");
  headers.delete("content-length"); // streamed body: let fetch decide the framing

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
      redirect: "manual",
      // Required by fetch when streaming a request body over HTTP/1.1 in Deno.
      // deno-lint-ignore no-explicit-any
      ...({ duplex: "half" } as any),
    });
    markFirstByte(ctx);
    const respHeaders = sanitizeResponseHeaders(Object.fromEntries(upstream.headers.entries()));
    respHeaders.set("x-relay-via", `${FLY_MACHINE_ID}`);
    applyRelayHeaders(respHeaders, ctx);
    // The owner already set x-relay-region/machine; keep theirs so callers see who served it.
    const ownerRegion = upstream.headers.get("x-relay-region");
    const ownerMachine = upstream.headers.get("x-relay-machine");
    if (ownerRegion) respHeaders.set("x-relay-region", ownerRegion);
    if (ownerMachine) respHeaders.set("x-relay-machine", ownerMachine);
    finishRequest(ctx, upstream.status, "internal_forward", { owner });
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (err) {
    log("warn", "relay.internal_forward_failed", {
      agent: agentAddress,
      owner,
      error: err instanceof Error ? err.message : String(err),
    });
    return finish(
      ctx,
      jsonResponse(502, { error: "agent_unreachable" }),
      "internal_forward_failed",
    );
  }
}

// --- Request dispatch over the tunnel -------------------------------------------------------

/**
 * Tells the host to abandon an in-flight request. Best-effort: if the socket is
 * already gone, tunnel teardown will cancel everything anyway.
 */
function sendCancel(conn: TunnelConnection, id: string): void {
  try {
    conn.ws.send(JSON.stringify({ type: "cancel", id }));
  } catch { /* socket already gone */ }
}

function badHostResponse(ctx: RequestContext, reason: string): Response {
  recordBadHostResponse();
  log("warn", "relay.bad_host_response", { agent: ctx.agent, reason });
  return finish(ctx, jsonResponse(502, { error: "bad_host_response" }), "bad_host_response");
}

function sendAndAwait(
  conn: TunnelConnection,
  id: string,
  frame: Record<string, unknown>,
  signal: AbortSignal,
  ctx: RequestContext,
): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      // The host never answered in time. Tell it to stop so a slow generation
      // (or a stuck model load) doesn't keep running after we've already
      // returned 504 to the caller.
      sendCancel(conn, id);
      resolve(finish(ctx, jsonResponse(504, { error: "gateway_timeout" }), "gateway_timeout"));
    }, REQUEST_TIMEOUT_MS);

    // A caller hanging up (closed tab, "stop" button, network drop) aborts the
    // request signal. Propagate that to the host as a `cancel` frame so it
    // tears down the in-flight generation instead of streaming into the void.
    // The map membership check makes this a no-op once the request has already
    // completed normally, so a late abort after `stream_end` does nothing.
    const onAbort = () => {
      const wasPending = conn.pending.delete(id);
      if (wasPending) clearTimeout(timer);
      const streaming = conn.streaming.get(id);
      if (streaming) {
        clearTimeout(streaming.timer);
        conn.streaming.delete(id);
        try {
          streaming.controller.error(new Error("client_disconnected"));
        } catch { /* already closed */ }
      }
      if (wasPending || streaming) {
        sendCancel(conn, id);
        finishRequest(ctx, 499, "client_disconnected");
      }
    };

    conn.pending.set(id, {
      ctx,
      resolve: (resp: ResponseFrame) => {
        markFirstByte(ctx);
        const body = resp.body ?? "";
        ctx.responseBytes = body.length;
        const built = buildHostResponse(resp.status, resp.headers, body);
        if (!built) {
          resolve(badHostResponse(ctx, `status=${resp.status}`));
          return;
        }
        resolve(finish(ctx, built, "ok"));
      },
      resolveStream: (resp: StreamStartFrame) => {
        markFirstByte(ctx);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>(
          {
            start(c) {
              controller = c;
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER_MARK_BYTES }),
        );

        const built = buildHostResponse(resp.status, resp.headers, stream);
        if (!built) {
          sendCancel(conn, id);
          resolve(badHostResponse(ctx, `status=${resp.status}`));
          return;
        }

        const idleTimer = setTimeout(() => {
          conn.streaming.delete(id);
          // No chunk for the idle window: the host is stuck. Stop it and close
          // the caller's stream cleanly.
          sendCancel(conn, id);
          try {
            controller.close();
          } catch { /* already closed */ }
          finishRequest(ctx, null, "stream_idle_timeout");
        }, STREAM_IDLE_TIMEOUT_MS);

        ctx.status = resp.status;
        conn.streaming.set(id, { controller, timer: idleTimer, ctx });
        applyRelayHeaders(built.headers, ctx);
        resolve(built);
      },
      timer,
    });

    // Caller already gave up before we forwarded anything: don't dispatch, and
    // there is nothing for the host to cancel since it never saw the request.
    if (signal.aborted) {
      clearTimeout(timer);
      conn.pending.delete(id);
      resolve(finish(ctx, jsonResponse(499, { error: "client_disconnected" }), "client_gone"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      ctx.dispatchedAt = performance.now();
      conn.ws.send(JSON.stringify(frame));
    } catch {
      clearTimeout(timer);
      conn.pending.delete(id);
      resolve(
        finish(ctx, jsonResponse(502, { error: "tunnel_send_failed" }), "tunnel_send_failed"),
      );
    }
  });
}

/**
 * Fails a request the host answered with something we could not parse. Pending callers get a
 * 502; in-progress streams are errored. Also tells the host to stop.
 */
export function failRequest(conn: TunnelConnection, id: string, reason: string): void {
  const pending = conn.pending.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    conn.pending.delete(id);
    sendCancel(conn, id);
    // Route through the normal resolve path so headers/logging stay consistent.
    pending.resolve({ type: "response", id, status: NaN, headers: {}, body: "" });
    log("warn", "relay.bad_host_frame", { agent: pending.ctx.agent, reason });
    return;
  }
  const streaming = conn.streaming.get(id);
  if (streaming) {
    clearTimeout(streaming.timer);
    conn.streaming.delete(id);
    sendCancel(conn, id);
    recordBadHostResponse();
    try {
      streaming.controller.error(new Error("bad_host_frame"));
    } catch { /* already closed */ }
    finishRequest(streaming.ctx, null, "bad_host_frame");
  }
}

export function handleStreamStart(
  conn: TunnelConnection,
  frame: StreamStartFrame,
): void {
  const pending = conn.pending.get(frame.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  conn.pending.delete(frame.id);
  pending.resolveStream(frame);
}

export function handleStreamChunk(
  conn: TunnelConnection,
  frame: StreamChunkFrame,
): void {
  const streaming = conn.streaming.get(frame.id);
  if (!streaming) return;
  clearTimeout(streaming.timer);

  const chunk = encoder.encode(frame.data);
  streaming.ctx.responseBytes += chunk.byteLength;

  // desiredSize = highWaterMark - bytes queued. Once the caller has fallen more than the cap
  // behind, stop buffering on their behalf: cancel the host and fail the stream.
  const desired = streaming.controller.desiredSize;
  if (desired !== null && STREAM_HIGH_WATER_MARK_BYTES - desired > STREAM_BUFFER_CAP_BYTES) {
    conn.streaming.delete(frame.id);
    sendCancel(conn, frame.id);
    recordSlowConsumerAbort();
    try {
      streaming.controller.error(new Error("slow_consumer"));
    } catch { /* already closed */ }
    finishRequest(streaming.ctx, null, "slow_consumer");
    return;
  }

  try {
    streaming.controller.enqueue(chunk);
  } catch {
    conn.streaming.delete(frame.id);
    finishRequest(streaming.ctx, null, "stream_enqueue_failed");
    return;
  }
  streaming.timer = setTimeout(() => {
    conn.streaming.delete(frame.id);
    // Stalled mid-stream: stop the host and close the caller's stream cleanly.
    sendCancel(conn, frame.id);
    try {
      streaming.controller.close();
    } catch { /* already closed */ }
    finishRequest(streaming.ctx, null, "stream_idle_timeout");
  }, STREAM_IDLE_TIMEOUT_MS);
}

export function handleStreamEnd(
  conn: TunnelConnection,
  frame: StreamEndFrame,
): void {
  const streaming = conn.streaming.get(frame.id);
  if (!streaming) return;
  clearTimeout(streaming.timer);
  conn.streaming.delete(frame.id);
  try {
    streaming.controller.close();
  } catch { /* already closed */ }
  finishRequest(streaming.ctx, null, "stream_ok");
}

export function teardownStreaming(conn: TunnelConnection): void {
  for (const [id, streaming] of conn.streaming) {
    clearTimeout(streaming.timer);
    try {
      streaming.controller.error(new Error("tunnel_closed"));
    } catch { /* already closed */ }
    conn.streaming.delete(id);
    finishRequest(streaming.ctx, null, "tunnel_closed");
  }
}

/** Number of requests in flight (awaiting first byte or streaming) on a connection. */
export function inflightCount(conn: TunnelConnection): number {
  return conn.pending.size + conn.streaming.size;
}
