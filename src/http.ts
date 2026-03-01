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
 * Returns the decoded string, or null if the body was too large.
 */
export async function readBody(
  req: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!req.body) return "";
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
  return new TextDecoder().decode(merged);
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
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "*");
  return headers;
}

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-real-ip",
]);

const STRIPPED_REQUEST_HEADER_PREFIXES = ["fly-", "cf-"];

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
