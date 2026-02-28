import { getActiveTunnelCount, getActiveAgentCount } from "./tunnel.ts";

const startedAt = Date.now();

let totalRequestsRelayed = 0;
let totalTunnelConnections = 0;

export function recordRequest(): void {
  totalRequestsRelayed++;
}

export function recordTunnelConnect(): void {
  totalTunnelConnections++;
}

export function getStats(): Record<string, number> {
  return {
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    active_tunnels: getActiveTunnelCount(),
    active_agents: getActiveAgentCount(),
    total_requests_relayed: totalRequestsRelayed,
    total_tunnel_connections: totalTunnelConnections,
  };
}
