import { getActiveTunnelCount, handleTunnelConnect } from "./tunnel.ts";
import { internalClientIp, internalOriginalHost, relayRequest } from "./relay.ts";
import { presenceLimiter, statsLimiter, tunnelLimiter } from "./rate_limit.ts";
import { getStats } from "./stats.ts";
import { handlePresence } from "./presence.ts";
import { corsPreflightResponse, jsonResponse } from "./http.ts";
import { BASE_DOMAIN, FLY_MACHINE_ID, FLY_REGION } from "./env.ts";
import { isRedisDegraded } from "./redis.ts";
import { isShuttingDown } from "./lifecycle.ts";

const AGENT_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function getClientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  // Set by Fly's edge and overwritten on every request it proxies, so it cannot be spoofed by a
  // public caller. Its presence also means the request did NOT arrive over the private network.
  const flyIp = req.headers.get("fly-client-ip");
  if (flyIp) return flyIp;
  // Machine-to-machine forward (large bodies that Fly cannot replay): the first-hop machine
  // recorded the real client IP. Only trusted when fly-client-ip is absent, i.e. off the edge.
  const internalIp = internalClientIp(req);
  if (internalIp) return internalIp;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const addr = info.remoteAddr;
  if (addr.transport === "tcp" || addr.transport === "udp") {
    return addr.hostname;
  }
  return "unknown";
}

function extractAgentAddress(host: string): string | null {
  const suffix = `.${BASE_DOMAIN}`;
  const bare = host.split(":")[0];
  if (!bare.endsWith(suffix)) return null;
  const subdomain = bare.slice(0, -suffix.length);
  if (!AGENT_ADDRESS_RE.test(subdomain)) return null;
  return subdomain.toLowerCase();
}

export function handleRequest(
  req: Request,
  info: Deno.ServeHandlerInfo,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const host = internalOriginalHost(req) ?? req.headers.get("host") ?? "";
  const clientIp = getClientIp(req, info);

  if (url.pathname === "/health") {
    const shuttingDown = isShuttingDown();
    return jsonResponse(shuttingDown ? 503 : 200, {
      status: shuttingDown ? "shutting_down" : "ok",
      tunnels: getActiveTunnelCount(),
      region: FLY_REGION,
      machine: FLY_MACHINE_ID,
      redis: isRedisDegraded() ? "degraded" : "ok",
    });
  }

  if (url.pathname === "/stats") {
    if (!statsLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return jsonResponse(200, getStats());
  }

  // Internal, bearer-authed batch presence for the osaurus-router (Teams agent discoverability).
  if (url.pathname === "/presence") {
    if (!presenceLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return handlePresence(req, url);
  }

  if (url.pathname === "/tunnel/connect") {
    if (isShuttingDown()) {
      // Fly is restarting this machine; make the client retry (it lands on another machine).
      return jsonResponse(503, { error: "relay_restarting" });
    }
    if (!req.headers.get("upgrade")?.toLowerCase().includes("websocket")) {
      return jsonResponse(400, { error: "websocket_required" });
    }
    if (!tunnelLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return handleTunnelConnect(req, clientIp);
  }

  const agentAddress = extractAgentAddress(host);
  if (!agentAddress) {
    return jsonResponse(400, { error: "invalid_subdomain" });
  }

  if (req.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  // Rate limiting happens inside relayRequest, on the machine that owns the tunnel, so that
  // first-hop machines which only route the request do not charge the agent's budget.
  return relayRequest(agentAddress, req, clientIp);
}
