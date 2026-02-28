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
│   ├── router.ts        # HTTP routing: health, stats, tunnel connect, subdomain relay
│   ├── tunnel.ts        # WebSocket tunnel lifecycle + keepalive
│   ├── relay.ts         # HTTP-to-WS request multiplexing + timeout
│   ├── auth.ts          # secp256k1 signature verification via viem
│   ├── rate_limit.ts    # Token bucket rate limiter (per-IP and per-agent)
│   ├── stats.ts         # Aggregate analytics counters
│   └── types.ts         # All frame/message TypeScript types
├── test/
│   ├── auth_test.ts     # Signature verification tests
│   ├── rate_limit_test.ts
│   ├── stats_test.ts    # Analytics endpoint + counter tests
│   ├── tunnel_test.ts   # Tunnel connect/disconnect/multi-agent tests
│   └── relay_test.ts    # Request forwarding tests
├── Dockerfile           # Deno container for Fly.io
├── fly.toml             # Fly.io app config
└── deno.json            # Deno config, tasks, imports
```

## Endpoints

### `GET /health`

Health check. Returns `200 OK` with:

```json
{ "status": "ok", "tunnels": 42 }
```

### `GET /stats`

Aggregate analytics. Returns `200 OK` with:

```json
{
  "uptime_seconds": 12345,
  "active_tunnels": 3,
  "active_agents": 7,
  "total_requests_relayed": 1042,
  "total_tunnel_connections": 15
}
```

Rate-limited to 10 requests/min per IP.

### `WSS /tunnel/connect`

Opens a WebSocket tunnel. The Osaurus client sends an auth frame as the first message with agent addresses and secp256k1 signatures. On success the relay responds with public URLs for each agent.

Agents can be added or removed mid-session without reconnecting.

### `ANY https://0x<agent>.agent.osaurus.ai/*`

Public traffic to an agent's subdomain is relayed through the user's tunnel. The relay injects `X-Agent-Address` and `X-Forwarded-For` headers. The Osaurus instance handles its own authentication — the relay is a transparent proxy.

## Configuration

| Variable      | Default            | Description                      |
| ------------- | ------------------ | -------------------------------- |
| `PORT`        | `8080`             | HTTP server port                 |
| `BASE_DOMAIN` | `agent.osaurus.ai` | Base domain for agent subdomains |

## Client Protocol Spec

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
  ]
}
```

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
{ "type": "add_agent", "address": "0xNewAgent...", "signature": "0x...", "nonce": "d4e5f6...same nonce", "timestamp": 1709136030 }
```

The signature covers `osaurus-tunnel:<agent-address>:<nonce>:<timestamp>`, same as initial auth.

**Step 4:** Response:

```json
{ "type": "agent_added", "address": "0xnewagent...", "url": "https://0xnewagent.agent.osaurus.ai" }
```

Remove an agent:

```json
{ "type": "remove_agent", "address": "0xAgentToRemove..." }
```

Response:

```json
{ "type": "agent_removed", "address": "0xagenttoremove..." }
```

Maximum 50 agents per tunnel.

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

The client **must** respond with a matching `id`:

```json
{
  "type": "response",
  "id": "req_abc123",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"reply\": \"hi there\"}"
}
```

If no response is sent within **30 seconds**, the relay returns `504 Gateway Timeout` to the caller.

Multiple requests can be in-flight simultaneously over the same WebSocket — the `id` field is used to match responses to requests.

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
```

### HTTP Error Codes

Callers hitting agent subdomains may receive these relay-level errors:

| Status | Body                            | Meaning                                |
| ------ | ------------------------------- | -------------------------------------- |
| 400    | `{"error":"invalid_subdomain"}` | Subdomain is not a valid agent address |
| 429    | `{"error":"rate_limited"}`      | Too many requests to this agent        |
| 502    | `{"error":"agent_offline"}`     | No active tunnel for this agent        |
| 504    | `{"error":"gateway_timeout"}`   | Agent didn't respond within 30 seconds |

### Rate Limits

| Scope              | Limit                     |
| ------------------ | ------------------------- |
| Tunnel connections | 5/min per IP              |
| Stats endpoint     | 10/min per IP             |
| Inbound requests   | 100/min per agent address |
| Agents per tunnel  | 50 max                    |
| Request body size  | 10 MB max                 |

## Security Model

The relay is a **transparent proxy**. It does not authenticate public traffic — that is handled by each user's Osaurus instance using the existing Identity system (secp256k1 signed tokens / `osk-v1` access keys).

Relay-level protections:

- **Rate limiting** — 100 req/min per agent address, 5 tunnel connects/min per IP, 10 stats req/min per IP
- **Max body size** — 10 MB per request/response frame
- **Tunnel auth** — challenge-response handshake with server-issued single-use nonce + secp256k1 signature with 30-second timestamp window (prevents replay attacks)
- **Connection limit** — 50 agents per tunnel

## Deploy to Fly.io

```bash
fly launch
fly deploy
```

DNS setup:

```
*.agent.osaurus.ai.  A     <fly.io IP>
*.agent.osaurus.ai.  AAAA  <fly.io IPv6>
```

Fly.io handles TLS termination with automatic certs for wildcard subdomains.

## License

MIT
