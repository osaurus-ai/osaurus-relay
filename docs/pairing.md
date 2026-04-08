## Cryptographic flow

**Initiator** signs with their **AgentKey** — a child key derived from the master key via HMAC-SHA512 with domain `osaurus-agent-v1` + agent index. Its address is `keccak256(pubkey)[12:]` in EIP-55 checksum form.

**Approver** signs with their **PairingKey** — derived from master key via HMAC-SHA512 with domain `osaurus-pairing-v1`, no index. Same address derivation. Stable and unique per device, but never exposed outside pairing.

Neither side ever sends a private key anywhere. The relay only ever sees addresses + signatures.

### Phase 1 — Initiation

Initiator signs:
`EIP-191("osaurus-pair:initiate:<agentAddress>:<timestamp>")` with their agent child key, sends `{ agentAddress, timestamp, signature }` to the relay.

Relay verifies the signature against `agentAddress` using viem's `verifyMessag`e (which reconstructs the signer via `ecrecover` and checks it matches). If valid, generates a 4-digit code, stores `{ initiatorAddress, state: "pending" }` in Redis with a 5-minute TTL, returns the code.

### Phase 2 — Fetch

Approver queries `GET /pair/{code}`. Relay returns `{ initiatorAddress }` — no commitment yet, just for display.

### Phase 3 — Approval

Approver signs:
`EIP-191("osaurus-pair:approve:<code>:<initiatorAddress>:<approverPairingAddress>:<timestamp>")` with their pairing key, sends `{ code, pairingAddress, timestamp, signature }`.

The critical security property: the approver's signature covers both code and `initiatorAddress`. This means:

- The relay cannot substitute a different initiator — the approver has cryptographically bound themselves to the specific identity they fetched in Phase 2.
- The signature cannot be replayed on a different pairing session (different code).

Relay verifies approver's signature against `pairingAddress`, marks session approved, stores `approverAddress`.

### Phase 4 — Result

Initiator polls `GET /pair/{code}/result`. Relay returns `{ status: "approved", approverAddress }`.

Both sides now hold each other's verifiable address:

- Initiator knows the approver's pairing address
- Approver knows the initiator's agent address

### What the relay learns

- Initiator's agent address (already public — it's their relay subdomain)
- Approver's pairing address (a stable pseudonym, not correlated to their agent addresses or master address)
- That a pairing happened between these two, at what time

The relay cannot learn any private key, cannot forge either party's identity, and cannot swap one party for another without breaking signature
verification.
