// Internal presence endpoint for the osaurus-router (Teams shared-agent discoverability).
//
//   GET /presence?addresses=0xaa..,0xbb..   (<= 100 per call)
//   Authorization: Bearer $PRESENCE_TOKEN
//
// An agent is online when a live tunnel on THIS instance carries it, or (cross-instance) when its
// Redis claim key exists — the same key tunnels refresh on every keepalive pong, so it expires
// within AGENT_TTL_SECONDS of a dead connection. Addresses the relay doesn't know are reported
// offline. This endpoint is for the router only (shared secret); it is not public, so it never
// leaks presence to unauthenticated callers.

import { getTunnelForAgent } from "./tunnel.ts";
import { lookupAgentInstances } from "./redis.ts";
import { jsonResponse } from "./http.ts";

const AGENT_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MAX_ADDRESSES = 100;
// A shared secret below this length is brute-forceable; refuse to serve rather than run weak.
const MIN_TOKEN_LENGTH = 32;
// 100 addresses of 42 chars + 99 separators = 4299; anything longer is garbage by construction.
const MAX_ADDRESSES_PARAM_LENGTH = 4300;

let warnedWeakToken = false;

function presenceToken(): string {
  const token = Deno.env.get("PRESENCE_TOKEN") ?? "";
  if (token && token.length < MIN_TOKEN_LENGTH) {
    if (!warnedWeakToken) {
      warnedWeakToken = true;
      console.warn(
        `presence: PRESENCE_TOKEN is shorter than ${MIN_TOKEN_LENGTH} chars; ` +
          "endpoint disabled (generate >= 32 random bytes)",
      );
    }
    return "";
  }
  return token;
}

/** Constant-time string comparison (the token is a shared secret). */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ba.length ^ bb.length;
  const len = Math.max(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ba[i % ba.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}

export async function handlePresence(req: Request, url: URL): Promise<Response> {
  const token = presenceToken();
  // Unconfigured -> indistinguishable from a nonexistent route.
  if (!token) return jsonResponse(404, { error: "not_found" });

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!timingSafeEqual(bearer, token)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  if (req.method !== "GET") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const raw = url.searchParams.get("addresses") ?? "";
  if (raw.length > MAX_ADDRESSES_PARAM_LENGTH) {
    return jsonResponse(400, { error: "addresses must contain 1-100 entries" });
  }
  const addresses = raw
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  if (addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
    return jsonResponse(400, { error: "addresses must contain 1-100 entries" });
  }
  for (const address of addresses) {
    if (!AGENT_ADDRESS_RE.test(address)) {
      return jsonResponse(400, { error: `invalid address: ${address}` });
    }
  }

  const presence: Record<string, { online: boolean; last_seen: string | null }> = {};
  const now = new Date().toISOString();

  // Local tunnels answer immediately; only the rest need the cross-instance Redis check.
  const remote: string[] = [];
  for (const address of addresses) {
    if (getTunnelForAgent(address)) {
      presence[address] = { online: true, last_seen: now };
    } else {
      remote.push(address);
    }
  }
  if (remote.length > 0) {
    const owners = await lookupAgentInstances(remote);
    for (let i = 0; i < remote.length; i++) {
      presence[remote[i]] = owners[i]
        ? { online: true, last_seen: now }
        : { online: false, last_seen: null };
    }
  }

  return jsonResponse(200, { presence });
}
