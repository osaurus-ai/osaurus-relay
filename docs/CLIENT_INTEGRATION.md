# Client Integration Guide

How an Osaurus host (the "client" of the relay) should connect to, authenticate with, and stay
connected to `osaurus-relay`, with emphasis on the behaviours introduced by the multi-region
deployment. The full wire format lives in the [README](../README.md#client-protocol-spec); this
document covers what a robust client must _do_.

## 1. Connection lifecycle

```
connect wss://relay.agent.osaurus.ai/tunnel/connect
  <- { type: "challenge", nonce }
  -> { type: "auth", agents: [...], nonce, timestamp }
  <- { type: "auth_ok", agents: [...], region }
  ... serve requests, answer pings ...
  <- { type: "error", error: "relay_restarting" }   (relay is being replaced)
  <- close 1012
  reconnect immediately (lands on another machine via anycast)
```

### 1.1 Connect

Open a WebSocket to `/tunnel/connect`. Anycast routes you to the nearest relay region; you do not
pick one. The `auth_ok` frame tells you which region you landed in (`region`), useful for support
tickets and for logging on your side. Nothing else should depend on it.

The first message you receive is a `challenge`. You have **10 seconds** to send a valid `auth`
frame or the socket is closed with `auth_error: auth_timeout`.

### 1.2 Authenticate

Sign `osaurus-tunnel:<address>:<nonce>:<timestamp>` (EIP-191 personal message) with each agent's
key. `timestamp` is Unix seconds and must be within **30 seconds** of the relay's clock: keep the
device clock synced, and compute the timestamp immediately before signing, not at app start.

Auth is all-or-nothing: one bad signature rejects the whole frame. If you manage many identities,
consider authenticating with one and adding the rest with `add_agent` so a single bad key does not
block the others.

The `auth_ok` response no longer carries a `rejected` list under normal operation (see Takeover
below). Treat it as optional and tolerate it if present.

### 1.3 Keepalive

The relay sends `{ type: "ping", ts }` every 30 seconds. Reply with `{ type: "pong", ts }`
promptly. Three unanswered pings and the relay closes the socket. On mobile / laptops waking from
sleep, expect the socket to be dead and reconnect proactively rather than waiting for a ping.

The pong is also when the relay reconciles ownership across machines (see Takeover), so a client
that stops answering pings can hold a stale claim for up to ~90 seconds.

## 2. Reconnection policy

You must reconnect in the following cases:

| Trigger                                              | Action                                        |
| ---------------------------------------------------- | --------------------------------------------- |
| `error: relay_restarting` then close `1012`          | Reconnect **immediately**, no backoff         |
| `503 { "error": "relay_restarting" }` on the upgrade | Retry after ~1s (that machine is draining)    |
| `429 { "error": "rate_limited" }` on the upgrade     | Backoff, see below                            |
| `429 { "error": "too_many_connections" }`            | Backoff; you have >50 sockets from one IP     |
| Unexpected close / network error                     | Exponential backoff                           |
| `auth_error: auth_timeout` / `invalid_nonce`         | Reconnect and re-auth with the new nonce      |
| `auth_error: signature_verification_failed`          | **Do not** retry blindly; check clock and key |
| `agent_removed` with `reason: "superseded"`          | **Do not** reconnect for that address         |

Recommended backoff: start at 1s, double to a cap of 60s, add ±20% jitter, reset after a
connection has been healthy for 60s. A relay deploy restarts one machine at a time, so a
`relay_restarting` reconnect nearly always succeeds on the first attempt.

Connection attempts are limited to **20 per minute per source IP per relay machine**. A tight
retry loop will trip this; a backoff that reaches 60s will not.

## 3. Takeover: the newest session wins

A valid signature proves possession of the agent key, so the relay treats the **most recently
authenticated tunnel** as the owner of an address, wherever it connected. Consequences:

- If you reconnect after a network blip before the relay noticed the old socket is dead, you are
  **not** rejected with `already_registered` (the old behaviour). Your new session takes over
  immediately.
- The previous session receives:

  ```json
  { "type": "agent_removed", "address": "0x...", "reason": "superseded" }
  ```

  and is closed with code `1000` once it holds no more agents.

- **A client that receives `reason: "superseded"` must not reconnect for that address.** If two
  devices share one identity and both auto-reconnect, they will evict each other forever. Surface
  this to the user ("this agent is now served from another device") and stop.
- A user-initiated "reconnect" or app restart may legitimately supersede a stale session. That is
  fine: the stale one goes quiet, the new one serves.

Ownership changes on another relay machine are propagated to the old machine on its next keepalive
cycle, so a request may still reach the superseded session for up to ~30 seconds after a takeover.
Do not rely on exclusivity within that window.

## 4. Serving requests

### 4.1 Request frame

```json
{
  "type": "request",
  "id": "uuid",
  "method": "POST",
  "path": "/v1/chat/completions?stream=true",
  "headers": {
    "content-type": "application/json",
    "x-agent-address": "0x...",
    "x-forwarded-for": "203.0.113.9"
  },
  "body": "..."
}
```

- `x-agent-address` is the lowercase address the request was for; use it to dispatch when one
  tunnel carries several agents.
- `x-forwarded-for` is the true caller IP as seen by Fly's edge. It survives cross-machine
  forwarding.
- Bodies are UTF-8 **text**; binary uploads are not yet supported (see Limits). Bodies up to
  **10 MB** are delivered.
- `authorization` is passed through. Cookies and infrastructure headers are stripped. Your own
  authentication of the caller happens here, on the host: the relay is a transparent proxy.

### 4.2 Answering

Reply with either one `response` frame or a `stream_start` / `stream_chunk`* / `stream_end`
sequence, echoing the request `id`.

Rules the relay now enforces (violations answer the caller with `502 bad_host_response` and send
you a `cancel`):

- `status` must be an integer in **200–599**. Use 4xx/5xx for errors; never 0 or 1xx.
- Header names and values must be valid HTTP tokens/field values (no CR/LF, no empty names).
  At most 128 headers, each value ≤ 16 KB.
- For `204`, `205`, `304` send `body: ""` (or omit it). Any body is discarded.
- `response.body` ≤ **10 MB**; `stream_chunk.data` ≤ **1 MB** per frame. Split larger chunks.
- Frames must be JSON objects with the documented `type`. Anything else is dropped and counted;
  if it names a live `id`, that request is failed immediately.

Timing:

- First byte (`response` or `stream_start`) within **30 seconds** or the caller gets `504`. For
  slow model loads, send `stream_start` early and keep the stream alive with periodic content
  (e.g. SSE comments `: keepalive\n\n`).
- Between chunks: **30 seconds** max idle or the stream is closed.

### 4.3 Cancellation

```json
{ "type": "cancel", "id": "uuid" }
```

Sent when the caller disconnects, when a relay timeout fires, when the caller is reading too
slowly (the relay stops buffering after 4 MB), or when your frame for that `id` was invalid.
Stop generating and release resources for that `id`. Frames you send afterwards for that `id` are
ignored; `cancel` for an unknown `id` is a no-op.

## 5. Control frames and their limits

`request_challenge` and `add_agent` are limited to **10 per minute per connection**; excess
requests are answered with `{ type: "error", error: "rate_limited" }`. Batch your identities into
the initial `auth` frame where possible. Maximum **50 agents per tunnel**.

`agent_added` now includes `region` like `auth_ok`.

Error frames you may receive at any time after auth:

| `error`              | Meaning / action                                         |
| -------------------- | -------------------------------------------------------- |
| `max_agents_reached` | Open a second tunnel or remove agents                    |
| `invalid_signature`  | Check key and clock                                      |
| `invalid_nonce`      | Nonce expired (30s) or reused; `request_challenge` again |
| `rate_limited`       | Too many control frames; back off                        |
| `relay_restarting`   | Reconnect immediately (followed by close `1012`)         |

## 6. Multi-region behaviour you will observe

- **Region in `auth_ok`.** Purely informational. Two devices in different countries will report
  different regions; that is expected.
- **Requests arrive at your tunnel regardless of where the caller is.** The relay routes the
  caller's request to the machine that holds your socket (`fly-replay`, cached at the edge for 30s
  per hostname). You never see routing hops; large bodies (> 1 MB) are forwarded machine-to-machine
  and arrive as a normal `request` frame.
- **Latency headers on responses.** Callers see `x-relay-region`, `x-relay-machine` and
  `Server-Timing` (`lookup`, `host`, `relay`). `host;dur` is the time between the relay sending
  you the request and receiving your first byte; it is the number to watch when profiling your
  handler.
- **Relay restarts are rolling.** During a deploy each machine drains for up to 20s, then sends
  `relay_restarting`. Expect at most one reconnect per deploy, and expect in-flight streams on
  that machine to be cut (the caller sees a truncated stream, you receive a close, not a `cancel`).

## 7. Current limits and known gaps

| Limit                              | Value                                        |
| ---------------------------------- | -------------------------------------------- |
| Request body                       | 10 MB, text only                             |
| Response frame body / stream chunk | 10 MB / 1 MB                                 |
| First byte / inter-chunk timeout   | 30 s / 30 s                                  |
| Inbound requests per agent         | 100/min (per relay machine)                  |
| Inbound requests per caller IP     | 300/min (per relay machine)                  |
| Tunnel connects per IP             | 20/min (per relay machine)                   |
| Concurrent sockets per IP          | 50 (per relay machine, counted from upgrade) |
| Agents per tunnel                  | 50                                           |
| Control frames per connection      | 10/min                                       |

Not yet supported (tracked as protocol v2):

- Binary request/response bodies (audio, images). Bodies pass through `TextDecoder`; send base64
  at the application layer if you need binary today.
- Streaming request bodies (the relay buffers up to 10 MB before forwarding).
- A "processing" heartbeat that would suspend the 30s first-byte timeout during cold model loads.
  Use an early `stream_start` as described above.

## 8. Minimal reference implementation (TypeScript)

```ts
type Frame = Record<string, unknown> & { type: string };

class RelayTunnel {
  private ws?: WebSocket;
  private backoffMs = 1000;
  private superseded = new Set<string>();

  constructor(
    private url: string,
    private agents: { address: string; sign: (msg: string) => Promise<string> }[],
    private handle: (req: Frame, send: (f: Frame) => void) => void,
  ) {}

  start() {
    this.connect();
  }

  private connect() {
    const active = this.agents.filter((a) => !this.superseded.has(a.address.toLowerCase()));
    if (active.length === 0) return; // every identity is served elsewhere; stop

    const ws = new WebSocket(this.url);
    this.ws = ws;
    let healthySince = 0;

    ws.onmessage = async (e) => {
      const f: Frame = JSON.parse(e.data);
      switch (f.type) {
        case "challenge": {
          const timestamp = Math.floor(Date.now() / 1000);
          const signed = await Promise.all(active.map(async (a) => ({
            address: a.address,
            signature: await a.sign(`osaurus-tunnel:${a.address}:${f.nonce}:${timestamp}`),
          })));
          ws.send(JSON.stringify({ type: "auth", agents: signed, nonce: f.nonce, timestamp }));
          break;
        }
        case "auth_ok":
          healthySince = Date.now();
          console.info("relay connected", { region: f.region });
          break;
        case "auth_error":
          console.error("auth failed", f.error); // check clock/key before retrying
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong", ts: f.ts }));
          break;
        case "request":
          this.handle(f, (out) => ws.send(JSON.stringify(out)));
          break;
        case "cancel":
          // abort work for f.id
          break;
        case "agent_removed":
          if (f.reason === "superseded") {
            this.superseded.add(String(f.address));
            console.warn("agent now served by another session; not reconnecting", f.address);
          }
          break;
        case "error":
          if (f.error === "relay_restarting") this.backoffMs = 0; // reconnect at once on close
          break;
      }
    };

    ws.onclose = () => {
      if (Date.now() - healthySince > 60_000) this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      const jitter = this.backoffMs * (0.8 + Math.random() * 0.4);
      setTimeout(() => this.connect(), jitter);
      if (this.backoffMs === 0) this.backoffMs = 1000;
    };
  }
}
```

The essentials are: sign at challenge time, answer pings, reconnect with backoff, reconnect
immediately after `relay_restarting`, and stop for any address marked `superseded`.
