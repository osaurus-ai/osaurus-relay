import { getActiveAgentCount, getActiveTunnelCount } from "./tunnel.ts";
import { FLY_MACHINE_ID, FLY_REGION } from "./env.ts";
import { isRedisDegraded } from "./redis.ts";
import { routeCacheSize } from "./route_cache.ts";

const startedAt = Date.now();

let totalRequestsRelayed = 0;
let totalTunnelConnections = 0;
let totalReplays = 0;
let totalInternalForwards = 0;
let totalInvalidFrames = 0;
let totalBadHostResponses = 0;
let totalSlowConsumerAborts = 0;
let totalTakeovers = 0;

export function recordRequest(): void {
  totalRequestsRelayed++;
}

export function recordTunnelConnect(): void {
  totalTunnelConnections++;
}

export function recordReplay(): void {
  totalReplays++;
}

export function recordInternalForward(): void {
  totalInternalForwards++;
}

export function recordInvalidFrame(): void {
  totalInvalidFrames++;
}

export function recordBadHostResponse(): void {
  totalBadHostResponses++;
}

export function recordSlowConsumerAbort(): void {
  totalSlowConsumerAborts++;
}

export function recordTakeover(): void {
  totalTakeovers++;
}

export function getStats(): Record<string, number | string | boolean> {
  return {
    region: FLY_REGION,
    machine: FLY_MACHINE_ID,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    active_tunnels: getActiveTunnelCount(),
    active_agents: getActiveAgentCount(),
    total_requests_relayed: totalRequestsRelayed,
    total_tunnel_connections: totalTunnelConnections,
    total_replays: totalReplays,
    total_internal_forwards: totalInternalForwards,
    total_invalid_frames: totalInvalidFrames,
    total_bad_host_responses: totalBadHostResponses,
    total_slow_consumer_aborts: totalSlowConsumerAborts,
    total_takeovers: totalTakeovers,
    route_cache_entries: routeCacheSize(),
    redis_degraded: isRedisDegraded(),
  };
}
