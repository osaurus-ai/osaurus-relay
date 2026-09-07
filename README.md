# Osaurus Relay

A tunneling relay service that gives each [Osaurus](https://github.com/osaurus-ai/osaurus) agent its own public URL. Each user runs one Osaurus server with multiple agents — each agent has its own secp256k1 identity (address). The user opens a single WebSocket tunnel and registers their agents on it. Public traffic to any agent's subdomain routes through that one tunnel.

```
[Client A] → https://0xagent1.agent.osaurus.ai/chat ──┐
[Client B] → https://0xagent2.agent.osaurus.ai/chat ──┤→ [Relay] → [1 WebSocket] → [User's Osaurus]
[Client C] → https://0xagent5.agent.osaurus.ai/chat ──┘
```

## Requirements

- [Deno](https://deno.land/) v2+

## Quick Start

```bash
# Install dependencies
deno install

# Run in development mode (with file watcher)
deno task dev

# Run in production mode
deno task start

# Run tests
deno task test

# Lint
deno task lint

# Format
deno task fmt
```

The server starts on port `8080` by default. Override with the `PORT` environment variable.

## Project Structure

```
osaurus-relay/
├── main.ts              # Entry point — Deno.serve() HTTP server
├── src/
│   ├── router.ts        # HTTP routing: health, stats, presence, tunnel connect, subdomain relay
│   ├── tunnel.ts        # WebSocket tunnel lifecycle, takeover, keepalive, shutdown
│   ├── relay.ts         # HTTP-to-WS multiplexing, cross-machine routing, streaming, backpressure
│   ├── route_cache.ts   # In-process agent -> owning machine cache in front of Redis
│   ├── redis.ts         # Cross-machine ownership claims (Upstash Redis), degrade policy
│   ├── frames.ts        # zod schemas validating every frame received from hosts
│   ├── observability.ts # Structured JSON logs, per-request timing, Server-Timing headers
│   ├── http.ts          # Shared HTTP helpers: JSON responses, CORS, header sanitization
│   ├── auth.ts          # secp256k1 signature verification via viem
│   ├── presence.ts      # Internal bearer-authed presence endpoint for the router
│   ├── rate_limit.ts    # Token bucket rate limiters (per-IP, per-agent, per-connection)
│   ├── lifecycle.ts     # Shutdown flag shared by main.ts and the router
│   ├── env.ts           # Fly-injected environment (region, machine id, app name)
│   ├── stats.ts         # Aggregate analytics counters
│   └── types.ts         # All frame/message TypeScript types
├── test/                # deno test suite (see `deno task test`)
├── .github/workflows/   # CI: fmt, lint, check, test; deploy on master
├── Dockerfile           # Deno container for Fly.io (pinned by digest)
├── fly.toml             # Fly.io app config
└── deno.json            # Deno config, tasks, imports
```

## Endpoints

### `GET /health`

Health check, also used by Fly's HTTP health check. Returns `200 OK` with:

```json
{ "status": "ok", "tunnels": 42, "region": "ams", "machine": "e784...", "redis": "ok" }
```

`redis` is `degraded` when the coordination store is unreachable (the relay keeps serving from local state). During a graceful shutdown the endpoint returns `503` with `status: "shutting_down"` so Fly stops routing new traffic to the machine.

### `GET /stats`

Aggregate analytics. Returns `200 OK` with:

```json
{
  "region": "ams",
  "machine": "e784...",
  "uptime_seconds": 12345,
  "active_tunnels": 3,
  "active_agents": 7,
  "total_requests_relayed": 1042,
  "total_tunnel_connections": 15,
  "total_replays": 310,
  "total_internal_forwards": 2,
  "total_invalid_frames": 0,
  "total_bad_host_responses": 0,
  "total_slow_consumer_aborts": 0,
  "total_takeovers": 4,
  "route_cache_entries": 12,
  "redis_degraded": false
}
```

Counters are per machine. Rate-limited to 10 requests/min per IP.

### `WSS /tunnel/connect`

Opens a WebSocket tunnel. The Osaurus client sends an auth frame as the first message with agent addresses and secp256k1 signatures. On success the relay responds with public URLs for each agent.

Agents can be added or removed mid-session without reconnecting.

### `ANY https://0x<agent>.agent.osaurus.ai/*`

Public traffic to an agent's subdomain is relayed through the user's tunnel. The relay injects `X-Agent-Address` and `X-Forwarded-For` headers. Infrastructure headers (`fly-*`, `cf-*`) and sensitive caller headers (`cookie`) are stripped before forwarding; `authorization` is passed through for Osaurus client authentication. The Osaurus instance handles its own authentication — the relay is a transparent proxy.

Agent subdomain responses include `Access-Control-Allow-Origin: *` unless the Osaurus host set its own value. Preflight `OPTIONS` requests return `204` with appropriate CORS headers.

Every relayed response also carries `x-relay-region`, `x-relay-machine` and a `Server-Timing` header (`lookup` = time resolving the owning machine, `host` = time waiting on the Osaurus host, `relay` = total time in the relay) so latency can be attributed from the client side.

#### Multi-region routing

Relay machines run in several Fly regions. A host's WebSocket lands on the nearest region via anycast; that machine becomes the agent's **owner** and records the claim in Redis. A public request lands on the machine nearest the _caller_, which is usually not the owner:

1. The receiving machine resolves the owner (in-process route cache, then Redis) and answers `307` with `fly-replay: instance=<owner>` plus `fly-replay-cache: <agent-host>/*` (TTL 30s). Fly Proxy replays the request to the owner and caches the decision, so subsequent requests for that hostname from that edge go straight to the owner.
2. If the cached target no longer owns the agent (the host reconnected elsewhere), it replays to the current owner with `fly-replay-cache: invalidate`.
3. Fly cannot replay bodies over 1 MB. Those are streamed to the owner over the private network (`<machine>.vm.<app>.internal`) tagged `x-relay-internal-hop: 1`; the owner treats such requests as terminal.

Rate limits are applied only by the owning machine, so routing hops never charge the agent's or caller's budget.

## Configuration

| Variable                                       | Default            | Description                                                             |
| ---------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `PORT`                                         | `8080`             | HTTP server port                                                        |
| `BASE_DOMAIN`                                  | `agent.osaurus.ai` | Base domain for agent subdomains                                        |
| `REDIS_URL`                                    | unset              | Upstash Redis for cross-machine ownership; single-machine mode if unset |
| `PRESENCE_TOKEN`                               | unset              | Bearer token for the internal `/presence` endpoint (>= 32 chars)        |
| `LOG_LEVEL`                                    | `info`             | `debug`, `info`, `warn` or `error`; logs are JSON lines on stdout       |
| `FLY_REGION`, `FLY_MACHINE_ID`, `FLY_APP_NAME` | injected by Fly    | Used for routing and log/response tagging                               |

## Client Protocol Spec

For guidance on building a robust client (reconnect policy, takeover semantics, frame limits,
multi-region behaviour) see [docs/CLIENT_INTEGRATION.md](docs/CLIENT_INTEGRATION.md).

This section documents the WebSocket protocol for clients connecting a tunnel to the relay.

### Connecting

Open a WebSocket to:

```
wss://agent.osaurus.ai/tunnel/connect
```

### Challenge-Response Authentication

Authentication uses a challenge-response handshake to prevent signature replay attacks. The relay closes the connection if no auth is received within 10 seconds.

**Step 1:** Immediately after the WebSocket opens, the relay sends a `challenge` frame with a single-use 64-character hex nonce:

```json
{ "type": "challenge", "nonce": "a1b2c3...64 hex chars" }
```

**Step 2:** The client sends an `auth` frame including the server's nonce:

```json
{
  "type": "auth",
  "agents": [
    { "address": "0xAgentAddress1...", "signature": "0x..." },
    { "address": "0xAgentAddress2...", "signature": "0x..." }
  ],
  "nonce": "a1b2c3...same nonce from challenge",
  "timestamp": 1709136000
}
```

Each agent signs the following message with its own secp256k1 private key using EIP-191 `personal_sign`:

```
osaurus-tunnel:<agent-address>:<nonce>:<timestamp>
```

`timestamp` is Unix seconds. The relay rejects if it's more than 30 seconds from the server's clock. The nonce must match the one sent in the `challenge` frame — each nonce is single-use and consumed immediately after verification.

**Step 3:** If all signatures verify, the relay responds with:

```json
{
  "type": "auth_ok",
  "agents": [
    { "address": "0xagentaddress1...", "url": "https://0xagentaddress1.agent.osaurus.ai" },
    { "address": "0xagentaddress2...", "url": "https://0xagentaddress2.agent.osaurus.ai" }
  ],
  "region": "ams"
}
```

`region` is the Fly region that terminated the tunnel (diagnostics only).

**Takeover.** A valid signature proves possession of the agent's key, so the newest authenticated tunnel for an address always wins. If another connection (on any relay machine) currently holds the address, it receives `{"type":"agent_removed","address":"0x...","reason":"superseded"}` and is closed once it carries no agents. This means a host that reconnects after a network blip is never locked out waiting for its old socket to time out. Clients **must not** auto-reconnect for an address after receiving `reason: "superseded"`, or two sessions using the same identity will evict each other in a loop.

On failure the relay sends `auth_error` and closes the socket:

```json
{ "type": "auth_error", "error": "signature_verification_failed" }
{ "type": "auth_error", "error": "invalid_nonce" }
```

### Adding / Removing Agents Mid-Session

Adding an agent mid-session requires a new challenge-response exchange to get a fresh nonce.

**Step 1:** Request a challenge:

```json
{ "type": "request_challenge" }
```

**Step 2:** The relay responds with a new single-use nonce (expires after 30 seconds if unused):

```json
{ "type": "challenge", "nonce": "d4e5f6...64 hex chars" }
```

**Step 3:** Send the `add_agent` frame with the nonce:

```json
{
  "type": "add_agent",
  "address": "0xNewAgent...",
  "signature": "0x...",
  "nonce": "d4e5f6...same nonce",
  "timestamp": 1709136030
}
```

The signature covers `osaurus-tunnel:<agent-address>:<nonce>:<timestamp>`, same as initial auth.

**Step 4:** Response:

```json
{
  "type": "agent_added",
  "address": "0xnewagent...",
  "url": "https://0xnewagent.agent.osaurus.ai",
  "region": "ams"
}
```

Remove an agent:

```json
{ "type": "remove_agent", "address": "0xAgentToRemove..." }
```

Response:

```json
{ "type": "agent_removed", "address": "0xagenttoremove..." }
```

Maximum 50 agents per tunnel. `request_challenge` and `add_agent` are limited to 10 per minute per connection.

### Handling Incoming Requests

When a public HTTP request arrives at an agent's subdomain, the relay forwards it as a `request` frame:

```json
{
  "type": "request",
  "id": "req_abc123",
  "method": "POST",
  "path": "/v1/chat/completions",
  "headers": {
    "content-type": "application/json",
    "x-agent-address": "0xagentaddress1...",
    "x-forwarded-for": "203.0.113.1"
  },
  "body": "{\"message\": \"hello\"}"
}
```

The client **must** respond with a matching `id`. There are two response modes:

#### Buffered Response

For non-streaming endpoints, send a single `response` frame with the complete body:

```json
{
  "type": "response",
  "id": "req_abc123",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"reply\": \"hi there\"}"
}
```

#### Streaming Response

For streaming endpoints (e.g. SSE), send a `stream_start` frame to begin the response, followed by any number of `stream_chunk` frames, and a final `stream_end` frame:

```json
{ "type": "stream_start", "id": "req_abc123", "status": 200, "headers": { "content-type": "text/event-stream" } }
{ "type": "stream_chunk", "id": "req_abc123", "data": "data: {\"token\": \"Hello\"}\n\n" }
{ "type": "stream_chunk", "id": "req_abc123", "data": "data: {\"token\": \" world\"}\n\n" }
{ "type": "stream_end", "id": "req_abc123" }
```

The relay flushes headers to the HTTP client on `stream_start` and writes each chunk incrementally. The stream has a **30-second inactivity timeout** — if no `stream_chunk` or `stream_end` is received within 30 seconds of the last frame, the relay closes the stream.

#### Timeouts

If no `response` or `stream_start` is sent within **30 seconds**, the relay returns `504 Gateway Timeout` to the caller.

Multiple requests can be in-flight simultaneously over the same WebSocket — the `id` field is used to match responses to requests. The client chooses per-request whether to use buffered or streaming mode.

### Cancellation

When the public caller disconnects before a request completes — the browser tab closes, the user hits a "stop" button, or the network drops — the relay sends a `cancel` frame for that request `id`:

```json
{ "type": "cancel", "id": "req_abc123" }
```

The relay also sends `cancel` when one of its own timeouts fires (the `504` request timeout or the 30-second stream inactivity timeout), since the caller is no longer waiting on the response.

On receiving `cancel`, the client **should** abort the in-flight work for that `id` (stop generating, release the model, close any upstream connection) rather than finishing into a dead stream. After a `cancel`, any further `stream_chunk`/`stream_end`/`response` frames the client sends for that `id` are ignored by the relay. A `cancel` for an unknown or already-completed `id` is a no-op.

### Keepalive

The relay sends a `ping` frame every 30 seconds:

```json
{ "type": "ping", "ts": 1709136000 }
```

The client must respond with:

```json
{ "type": "pong", "ts": 1709136000 }
```

If 3 consecutive pings go unanswered, the relay closes the connection.

### Error Frames

The relay may send error frames for protocol violations:

```json
{ "type": "error", "error": "max_agents_reached" }
{ "type": "error", "error": "invalid_signature" }
{ "type": "error", "error": "invalid_nonce" }
{ "type": "error", "error": "rate_limited" }
{ "type": "error", "error": "relay_restarting" }
```

`relay_restarting` is sent to every tunnel just before the relay machine shuts down (deploy or restart), followed by a WebSocket close with code `1012`. Clients should reconnect immediately; anycast will place them on a healthy machine.

Frames that fail validation (wrong shape, oversized `body`/`data`, illegal header values) are dropped. If such a frame names an in-flight request `id`, that request is failed with `502 bad_host_response` and a `cancel` frame is sent, rather than leaving the caller waiting for the 30-second timeout. A `response` or `stream_start` whose status cannot be represented (outside 200-599, or a body on 204/304) is likewise answered with `502 bad_host_response`.

### HTTP Error Codes

Callers hitting agent subdomains may receive these relay-level errors:

| Status | Body                               | Meaning                                        |
| ------ | ---------------------------------- | ---------------------------------------------- |
| 400    | `{"error":"invalid_subdomain"}`    | Subdomain is not a valid agent address         |
| 413    | `{"error":"body_too_large"}`       | Request body exceeds 10 MB                     |
| 429    | `{"error":"rate_limited"}`         | Agent or caller budget exhausted               |
| 429    | `{"error":"too_many_connections"}` | IP has too many open tunnels (max 50)          |
| 499    | `{"error":"client_disconnected"}`  | Caller hung up before the host answered        |
| 502    | `{"error":"agent_offline"}`        | No active tunnel for this agent                |
| 502    | `{"error":"agent_unreachable"}`    | Owning machine could not be reached            |
| 502    | `{"error":"bad_host_response"}`    | Host answered with an unrepresentable response |
| 502    | `{"error":"tunnel_send_failed"}`   | Failed to send request through the tunnel      |
| 503    | `{"error":"relay_restarting"}`     | Machine is shutting down; retry                |
| 504    | `{"error":"gateway_timeout"}`      | Agent didn't respond within 30 seconds         |

Streams that stall for 30 seconds are closed. A caller that reads slower than the host streams is disconnected once the relay is holding more than 4 MB on its behalf (`slow_consumer`), and the host receives `cancel`.

### Rate Limits

All limits are per relay machine.

| Scope                     | Limit                                                |
| ------------------------- | ---------------------------------------------------- |
| Tunnel connections        | 20/min per IP                                        |
| Concurrent tunnels per IP | 50 max (counted from upgrade, pre-auth too)          |
| Stats endpoint            | 10/min per IP                                        |
| Presence endpoint         | 120/min per IP                                       |
| Inbound requests          | 100/min per agent address (on the owner)             |
| Inbound requests          | 300/min per caller IP (on the owner)                 |
| Control frames            | 10/min per tunnel (`request_challenge`, `add_agent`) |
| Agents per tunnel         | 50 max                                               |
| Request body size         | 10 MB max (streaming read with early abort)          |
| Response frame `body`     | 10 MB max                                            |
| Stream chunk `data`       | 1 MB max                                             |
| Stream buffer per caller  | 4 MB before `slow_consumer` abort                    |

## Security Model

The relay is a **transparent proxy**. It does not authenticate public traffic — that is handled by each user's Osaurus instance using the existing Identity system (secp256k1 signed tokens / `osk-v1` access keys).

Relay-level protections:

- **IP detection** — uses `fly-client-ip` (set by Fly.io edge, not spoofable) over `x-forwarded-for` for all rate limiting and forwarding. `x-relay-client-ip` (set by a relay machine when forwarding large bodies internally) is only honoured when `fly-client-ip` is absent, i.e. the request did not come through the edge
- **Rate limiting** — 100 req/min per agent address and 300 req/min per caller IP (so one caller cannot exhaust an agent's budget), 20 tunnel connects/min per IP, 10 control frames/min per tunnel, 10 stats req/min per IP
- **Concurrent connection limit** — max 50 open WebSocket tunnels per IP, counted from the upgrade so unauthenticated sockets are covered
- **Frame validation** — every frame from a host is schema-validated (zod) with size caps before it is acted on; malformed frames cannot throw inside the WebSocket handler
- **Backpressure** — a slow caller cannot make the relay buffer unbounded response data on its behalf
- **Crash isolation** — unhandled rejections and Redis errors are logged, never fatal; a Redis outage degrades to single-machine behaviour and is flagged on `/health`
- **Max body size** — 10 MB per request, enforced via streaming read with early abort (prevents memory exhaustion from chunked-encoding attacks that omit `content-length`)
- **Tunnel auth** — challenge-response handshake with server-issued single-use nonce + secp256k1 signature with 30-second timestamp window (prevents replay attacks)
- **Connection limit** — 50 agents per tunnel
- **Response header sanitization** — hop-by-hop headers (`transfer-encoding`, `connection`, `keep-alive`, `upgrade`, etc.) are stripped from response frames before constructing the HTTP response
- **Request header sanitization** — infrastructure headers (`fly-*`, `cf-*`) and sensitive caller headers (`cookie`, `proxy-authorization`) are stripped before forwarding to the Osaurus client; `authorization` is forwarded since Osaurus clients use bearer tokens for their own authentication
- **CORS** — agent subdomain responses include `Access-Control-Allow-Origin: *` unless the host sets its own; preflight `OPTIONS` are handled at the router level
- **Ownership** — the newest authenticated tunnel for an address supersedes older ones (see Takeover above); Redis claims are released and refreshed only by their owner (compare-and-delete / compare-and-expire), so a machine can never clobber another machine's claim

## Deploy to Fly.io

CI (`.github/workflows/ci.yml`) runs `fmt:check`, `lint`, `check` and `test` on every PR and push, and deploys `master` with `flyctl deploy --remote-only` when the `FLY_API_TOKEN` repository secret is set. Manual deploys work too:

```bash
fly deploy
```

`fly.toml` notes:

- `auto_stop_machines = 'off'` / `min_machines_running = 1` — idle shutdown would kill every active WebSocket tunnel.
- `kill_timeout = 30` and `[deploy] strategy = 'rolling'`, `max_unavailable = 1` — on SIGTERM the relay flips `/health` to 503, drains in-flight requests for up to 20s, then sends `relay_restarting` and closes tunnels so hosts reconnect to a machine that is not restarting. One machine restarts at a time.
- `[[http_service.checks]]` on `/health` — a wedged machine is pulled out of routing.
- `memory_mb = 512` — each in-flight request may buffer up to 10 MB of body plus stream queues.

### Multi-region

Region placement is controlled with `fly scale`, not `fly.toml`. Hosts connect to the nearest region by anycast; callers are routed to the owning machine with `fly-replay` (see "Multi-region routing" above). Current layout:

```bash
fly scale count lax=2,iad=1,ams=1,sin=1,gru=1
fly regions list
```

Add a region when logs show a cluster of hosts whose `tunnel.connected` region is far from where they are; two machines per region once a region carries enough tunnels that a single machine restart is disruptive.

### Redis (Upstash) for cross-machine ownership

`REDIS_URL` must point at an Upstash Redis with **read replicas in every region the app runs in**; ownership lookups on the request path read from the nearest replica (sub-millisecond), while claims (writes) are forwarded to the primary.

```bash
fly redis list
fly redis update <db-name> --replica-regions iad,ams,sin,gru
fly redis status <db-name>      # confirm "Read Regions"
```

The primary region cannot be changed after creation. Without `REDIS_URL` the relay runs in single-machine mode (no cross-machine routing).

### Observability

Every relayed request emits one JSON log line (`event: "relay.request"`) with `region`, `machine`, `agent`, `status`, `outcome`, `replay` (`direct` / `hit` / `miss` / `internal`), `lookup_ms`, `host_ms`, `ttfb_ms`, `total_ms`, `body_bytes`, `response_bytes`. Useful queries:

```bash
fly logs | grep '"event":"relay.request"'                  # per-request latency
fly logs | grep -E 'PA0[123]'                              # Fly replay errors (buffer exceeded, loop, invalid)
fly logs | grep -E 'redis.error|tunnel.takeover|handler_error'
curl -sD - -o /dev/null https://0x<agent>.agent.osaurus.ai/ | grep -iE 'x-relay|server-timing'
```

### DNS and TLS setup

Point the wildcard at the Fly app (use the IPs from `fly ips list`):

```
*.agent.osaurus.ai.  A     <fly.io IP>
*.agent.osaurus.ai.  AAAA  <fly.io IPv6>
```

Fly.io does **not** auto-issue wildcard certificates — you must request one and validate it via a DNS-01 challenge:

```bash
fly certs add "*.agent.osaurus.ai"
fly certs setup "*.agent.osaurus.ai"   # prints the exact records below
```

`fly certs setup` prints an ACME DNS challenge record that you must add:

```
CNAME _acme-challenge.agent.osaurus.ai → agent.osaurus.ai.<id>.flydns.net
```

> [!IMPORTANT]
> A wildcard TLS cert can only be validated with DNS-01, never HTTP-01. The
> `_acme-challenge.agent.osaurus.ai` CNAME **must be an explicit record**. Do not
> let the `*.agent.osaurus.ai` wildcard cover it — the wildcard matches
> `_acme-challenge.agent.osaurus.ai` and silently points it at the app, so the
> ACME challenge never validates, the certificate fails to renew, and every
> per-agent subdomain returns `ERR_CONNECTION_CLOSED` once the cert expires.

Verify issuance with `fly certs show "*.agent.osaurus.ai"` (status should be `Ready`/`Issued`). Until the wildcard cert is issued, requests to `https://0x<agent>.agent.osaurus.ai` are dropped during the TLS handshake even though the relay app is healthy.

## License

MIT
