export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stream-reads a request body with an early abort if maxBytes is exceeded.
 * Returns the decoded string and raw byte count, or null if the body was too large.
 */
export async function readBody(
  req: Request,
  maxBytes: number,
): Promise<{ text: string; bytes: number } | null> {
  if (!req.body) return { text: "", bytes: 0 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), bytes: totalBytes };
}

/** Statuses for which the Fetch spec forbids a body; a host body is dropped for these. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Builds the caller-facing Response from a host-supplied status/headers/body. The host is
 * authenticated but not trusted to be well-formed: an out-of-range status, an illegal header
 * value, or a body on a 204 would otherwise throw inside a WebSocket handler after the pending
 * timer was already cleared, leaving the caller hanging forever. Returns null when the host's
 * response cannot be represented, so the caller can answer 502 instead.
 */
export function buildHostResponse(
  status: number,
  rawHeaders: Record<string, string>,
  body: BodyInit | null,
): Response | null {
  if (!Number.isInteger(status) || status < 200 || status > 599) return null;
  let headers: Headers;
  try {
    headers = sanitizeResponseHeaders(rawHeaders);
  } catch {
    return null;
  }
  const finalBody = NULL_BODY_STATUSES.has(status) ? null : body;
  try {
    return new Response(finalBody, { status, headers });
  } catch {
    return null;
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-request-id",
  "access-control-max-age": "86400",
} as const;

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const HOP_BY_HOP_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

export function sanitizeResponseHeaders(
  raw: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  // Default to a permissive CORS policy, but let the Osaurus host restrict origins if it
  // chooses to: only fill in the wildcard when the host did not set one itself.
  if (!headers.has("access-control-allow-origin")) {
    headers.set("access-control-allow-origin", "*");
  }
  if (!headers.has("access-control-expose-headers")) {
    headers.set("access-control-expose-headers", "*");
  }
  return headers;
}

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "proxy-authorization",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-real-ip",
]);

// `x-relay-*` are relay-internal (machine-to-machine forwarding); never leak them to the host.
const STRIPPED_REQUEST_HEADER_PREFIXES = ["fly-", "cf-", "x-relay-"];

export function sanitizeRequestHeaders(
  req: Request,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (STRIPPED_REQUEST_HEADER_PREFIXES.some((p) => lower.startsWith(p))) {
      continue;
    }
    headers[lower] = value;
  }
  return headers;
}
