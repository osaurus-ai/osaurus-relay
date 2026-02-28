import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getStats, recordRequest, recordTunnelConnect } from "../src/stats.ts";
import { handleRequest } from "../src/router.ts";

function mockInfo(ip = "127.0.0.1"): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp" as const, hostname: ip, port: 12345 },
    completed: Promise.resolve(),
  };
}

Deno.test("getStats - returns expected shape", () => {
  const stats = getStats();
  assertEquals(typeof stats.uptime_seconds, "number");
  assertEquals(typeof stats.active_tunnels, "number");
  assertEquals(typeof stats.active_agents, "number");
  assertEquals(typeof stats.total_requests_relayed, "number");
  assertEquals(typeof stats.total_tunnel_connections, "number");
});

Deno.test("recordRequest - increments total_requests_relayed", () => {
  const before = getStats().total_requests_relayed;
  recordRequest();
  recordRequest();
  assertEquals(getStats().total_requests_relayed, before + 2);
});

Deno.test("recordTunnelConnect - increments total_tunnel_connections", () => {
  const before = getStats().total_tunnel_connections;
  recordTunnelConnect();
  assertEquals(getStats().total_tunnel_connections, before + 1);
});

Deno.test("GET /stats - returns stats JSON", async () => {
  const req = new Request("http://localhost/stats");
  const resp = await handleRequest(req, mockInfo());
  assertEquals(resp.status, 200);

  const body = await resp.json();
  assertEquals(typeof body.uptime_seconds, "number");
  assertEquals(typeof body.active_tunnels, "number");
  assertEquals(typeof body.active_agents, "number");
  assertEquals(typeof body.total_requests_relayed, "number");
  assertEquals(typeof body.total_tunnel_connections, "number");
});

Deno.test("GET /stats - rate limited after 10 requests", async () => {
  const ip = "10.99.99.99";
  for (let i = 0; i < 10; i++) {
    const resp = await handleRequest(new Request("http://localhost/stats"), mockInfo(ip));
    assertEquals(resp.status, 200);
  }

  const resp = await handleRequest(new Request("http://localhost/stats"), mockInfo(ip));
  assertEquals(resp.status, 429);
  const body = await resp.json();
  assertEquals(body.error, "rate_limited");
});
