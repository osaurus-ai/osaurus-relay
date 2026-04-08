## Cryptographic flow

**Initiator** signs with their **AgentKey** — a child key derived from the master key via HMAC-SHA512 with domain `osaurus-agent-v1` + agent index. Its address is `keccak256(pubkey)[12:]` in EIP-55 checksum form.

**Approver** signs with their **PairingKey** — derived from master key via HMAC-SHA512 with domain `osaurus-pairing-v1`, no index. Same address derivation. Stable and unique per device, but never exposed outside pairing.

Neither side ever sends a private key anywhere. The relay only ever sees addresses + signatures.

### Phase 1 — Initiation

Initiator signs:
`EIP-191("osaurus-pair:initiate:<agentAddress>:<timestamp>")` with their agent child key, sends `{ agentAddress, timestamp, signature }` to the relay.

Relay verifies the signature against `agentAddress` using viem's `verifyMessage` (which reconstructs the signer via `ecrecover` and checks it matches). If valid, generates a 4-digit code, stores `{ initiatorAddress, state: "pending" }` in Redis with a 5-minute TTL, returns the code.

### Phase 2 — Fetch

Approver queries `GET /pair/{code}`. Relay returns `{ initiatorAddress }` — no commitment yet, just for display.

### Phase 3 — Approval

Approver generates a random 4-digit `confirmCode`, then signs:
`EIP-191("osaurus-pair:approve:<code>:<initiatorAddress>:<approverPairingAddress>:<confirmCode>:<timestamp>")` with their pairing key, sends `{ code, pairingAddress, confirmCode, timestamp, signature }`.

The approver's signature covers `code`, `initiatorAddress`, and `confirmCode`. This means:

- The relay cannot substitute a different initiator — the approver has cryptographically bound themselves to the specific identity they fetched in Phase 2.
- The relay cannot substitute a different `confirmCode` — it is inside the signed message.
- The signature cannot be replayed on a different pairing session (different code).

Relay verifies approver's signature against `pairingAddress`, marks session approved, stores `{ approverAddress, confirmCode, approverSignature, approverTimestamp }`.

### Phase 4 — Result

Initiator polls `GET /pair/{code}/result`. Relay returns `{ status: "approved", approverAddress, confirmCode, approverSignature, approverTimestamp }`.

**The initiator verifies the approver's signature locally** by reconstructing the signed message from the returned fields and running `ecrecover`. If the recovered address does not match `approverAddress`, the pairing is rejected. This means the initiator's trust in the outcome does not depend on the relay being honest.

Both sides then display `confirmCode`. The users compare it out-of-band (verbally or visually). A match confirms that no substitution occurred.

Both sides now hold each other's verifiable address:

- Initiator knows the approver's pairing address (signature-verified locally)
- Approver knows the initiator's agent address

### What the relay learns

- Initiator's agent address (already public — it's their relay subdomain)
- Approver's pairing address (a stable pseudonym, not correlated to their agent addresses or master address)
- The `confirmCode` (but cannot forge it without breaking the approver's signature)
- That a pairing happened between these two, at what time

The relay cannot forge either party's identity — any substitution breaks signature verification on the initiator's side.
