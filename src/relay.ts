import { getTunnelForAgent } from "./tunnel.ts";
import { recordRequest } from "./stats.ts";
import { jsonResponse, readBody, sanitizeRequestHeaders, sanitizeResponseHeaders } from "./http.ts";
import { FLY_MACHINE_ID, lookupAgentInstance } from "./redis.ts";
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

const encoder = new TextEncoder();

export async function relayRequest(
  agentAddress: string,
  req: Request,
  clientIp: string,
): Promise<Response> {
  const conn = getTunnelForAgent(agentAddress);
  if (!conn) {
    const machineId = await lookupAgentInstance(agentAddress.toLowerCase());
    if (machineId && machineId !== FLY_MACHINE_ID) {
      return new Response(null, {
        status: 307,
        headers: { "fly-replay": `instance=${machineId}` },
      });
    }
    return jsonResponse(502, { error: "agent_offline" });
  }

  recordRequest();

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: "body_too_large" });
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if (body === null) {
    return jsonResponse(413, { error: "body_too_large" });
  }

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
    body,
  };

  return sendAndAwait(conn, id, frame, req.signal);
}

/**
 * Tells the host to abandon an in-flight request. Best-effort: if the socket is
 * already gone, tunnel teardown will cancel everything anyway.
 */
function sendCancel(conn: TunnelConnection, id: string): void {
  try {
    conn.ws.send(JSON.stringify({ type: "cancel", id }));
  } catch { /* socket already gone */ }
}

function sendAndAwait(
  conn: TunnelConnection,
  id: string,
  frame: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      // The host never answered in time. Tell it to stop so a slow generation
      // (or a stuck model load) doesn't keep running after we've already
      // returned 504 to the caller.
      sendCancel(conn, id);
      resolve(jsonResponse(504, { error: "gateway_timeout" }));
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
      if (wasPending || streaming) sendCancel(conn, id);
    };

    conn.pending.set(id, {
      resolve: (resp: ResponseFrame) => {
        resolve(
          new Response(resp.body, {
            status: resp.status,
            headers: sanitizeResponseHeaders(resp.headers),
          }),
        );
      },
      resolveStream: (resp: StreamStartFrame) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });

        const idleTimer = setTimeout(() => {
          conn.streaming.delete(id);
          // No chunk for the idle window: the host is stuck. Stop it and close
          // the caller's stream cleanly.
          sendCancel(conn, id);
          try {
            controller.close();
          } catch { /* already closed */ }
        }, STREAM_IDLE_TIMEOUT_MS);

        conn.streaming.set(id, { controller, timer: idleTimer });

        resolve(
          new Response(stream, {
            status: resp.status,
            headers: sanitizeResponseHeaders(resp.headers),
          }),
        );
      },
      timer,
    });

    // Caller already gave up before we forwarded anything: don't dispatch, and
    // there is nothing for the host to cancel since it never saw the request.
    if (signal.aborted) {
      clearTimeout(timer);
      conn.pending.delete(id);
      resolve(jsonResponse(499, { error: "client_disconnected" }));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      conn.ws.send(JSON.stringify(frame));
    } catch {
      clearTimeout(timer);
      conn.pending.delete(id);
      resolve(jsonResponse(502, { error: "tunnel_send_failed" }));
    }
  });
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
  try {
    streaming.controller.enqueue(encoder.encode(frame.data));
  } catch {
    conn.streaming.delete(frame.id);
    return;
  }
  streaming.timer = setTimeout(() => {
    conn.streaming.delete(frame.id);
    // Stalled mid-stream: stop the host and close the caller's stream cleanly.
    sendCancel(conn, frame.id);
    try {
      streaming.controller.close();
    } catch { /* already closed */ }
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
}

export function teardownStreaming(conn: TunnelConnection): void {
  for (const [id, streaming] of conn.streaming) {
    clearTimeout(streaming.timer);
    try {
      streaming.controller.error(new Error("tunnel_closed"));
    } catch { /* already closed */ }
    conn.streaming.delete(id);
  }
}
