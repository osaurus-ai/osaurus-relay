import { getActiveTunnelCount, handleTunnelConnect } from "./tunnel.ts";
import { relayRequest } from "./relay.ts";
import { requestLimiter, tunnelLimiter } from "./rate_limit.ts";

const BASE_DOMAIN = Deno.env.get("BASE_DOMAIN") ?? "agent.osaurus.ai";
const AGENT_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getClientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const flyIp = req.headers.get("fly-client-ip");
  if (flyIp) return flyIp;
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

  // Health check — matches any host
  if (url.pathname === "/health") {
    return jsonResponse(200, {
      status: "ok",
      tunnels: getActiveTunnelCount(),
    });
  }

  // Tunnel connect — on the bare domain
  if (url.pathname === "/tunnel/connect") {
    if (!req.headers.get("upgrade")?.toLowerCase().includes("websocket")) {
      return jsonResponse(400, { error: "websocket_required" });
    }
    if (!tunnelLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return handleTunnelConnect(req);
  }

  // Agent subdomain routing
  const agentAddress = extractAgentAddress(host);
  if (!agentAddress) {
    return jsonResponse(400, { error: "invalid_subdomain" });
  }

  if (!requestLimiter.allow(agentAddress)) {
    return jsonResponse(429, { error: "rate_limited" });
  }

  return relayRequest(agentAddress, req, clientIp);
}
