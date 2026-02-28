import { getTunnelForAgent } from "./tunnel.ts";
import type { ResponseFrame, TunnelConnection } from "./types.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function relayRequest(
  agentAddress: string,
  req: Request,
  clientIp: string,
): Promise<Response> {
  const conn = getTunnelForAgent(agentAddress);
  if (!conn) {
    return jsonResponse(502, { error: "agent_offline" });
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: "body_too_large" });
  }

  let body = "";
  if (req.body) {
    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "body_too_large" });
    }
    body = new TextDecoder().decode(raw);
  }

  const url = new URL(req.url);
  const id = crypto.randomUUID();

  const headers: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    if (key.toLowerCase() === "host") continue;
    headers[key.toLowerCase()] = value;
  }
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

  return sendAndAwait(conn, id, frame);
}

function sendAndAwait(
  conn: TunnelConnection,
  id: string,
  frame: Record<string, unknown>,
): Promise<Response> {
  return new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      resolve(jsonResponse(504, { error: "gateway_timeout" }));
    }, REQUEST_TIMEOUT_MS);

    conn.pending.set(id, {
      resolve: (resp: ResponseFrame) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(resp.headers)) {
          responseHeaders.set(key, value);
        }
        resolve(
          new Response(resp.body, {
            status: resp.status,
            headers: responseHeaders,
          }),
        );
      },
      timer,
    });

    try {
      conn.ws.send(JSON.stringify(frame));
    } catch {
      clearTimeout(timer);
      conn.pending.delete(id);
      resolve(jsonResponse(502, { error: "tunnel_send_failed" }));
    }
  });
}
