import { getActiveTunnelCount, handleTunnelConnect } from "./tunnel.ts";
import { relayRequest } from "./relay.ts";
import { requestLimiter, statsLimiter, tunnelLimiter } from "./rate_limit.ts";
import { getStats } from "./stats.ts";
import { corsPreflightResponse, jsonResponse } from "./http.ts";

const BASE_DOMAIN = Deno.env.get("BASE_DOMAIN") ?? "agent.osaurus.ai";
const AGENT_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function getClientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  const flyIp = req.headers.get("fly-client-ip");
  if (flyIp) return flyIp;
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
  if (!host.endsWith(suffix)) return null;
  const subdomain = host.slice(0, -suffix.length);
  if (!AGENT_ADDRESS_RE.test(subdomain)) return null;
  return subdomain.toLowerCase();
}

export function handleRequest(
  req: Request,
  info: Deno.ServeHandlerInfo,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? "";
  const clientIp = getClientIp(req, info);

  if (url.pathname === "/health") {
    return jsonResponse(200, {
      status: "ok",
      tunnels: getActiveTunnelCount(),
    });
  }

  if (url.pathname === "/stats") {
    if (!statsLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return jsonResponse(200, getStats());
  }

  if (url.pathname === "/tunnel/connect") {
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

  if (!requestLimiter.allow(agentAddress)) {
    return jsonResponse(429, { error: "rate_limited" });
  }

  return relayRequest(agentAddress, req, clientIp);
}
