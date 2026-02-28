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
│   ├── router.ts        # HTTP routing: health, tunnel connect, subdomain relay
│   ├── tunnel.ts        # WebSocket tunnel lifecycle + keepalive
│   ├── relay.ts         # HTTP-to-WS request multiplexing + timeout
│   ├── auth.ts          # secp256k1 signature verification via viem
│   ├── rate_limit.ts    # Token bucket rate limiter (per-IP and per-agent)
│   └── types.ts         # All frame/message TypeScript types
├── test/
│   ├── auth_test.ts     # Signature verification tests
│   ├── rate_limit_test.ts
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

## Security Model

The relay is a **transparent proxy**. It does not authenticate public traffic — that is handled by each user's Osaurus instance using the existing Identity system (secp256k1 signed tokens / `osk-v1` access keys).

Relay-level protections:

- **Rate limiting** — 100 req/min per agent address, 5 tunnel connects/min per IP
- **Max body size** — 10 MB per request/response frame
- **Tunnel auth** — secp256k1 signature with 30-second timestamp window
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
