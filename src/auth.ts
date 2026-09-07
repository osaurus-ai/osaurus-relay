import { verifyMessage } from "viem";
import type { AgentAuth } from "./types.ts";

const TIMESTAMP_WINDOW_SECONDS = 30;

export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildSignedMessage(address: string, nonce: string, timestamp: number): string {
  return `osaurus-tunnel:${address}:${nonce}:${timestamp}`;
}

export async function verifyAgent(
  agent: AgentAuth,
  nonce: string,
  timestamp: number,
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_WINDOW_SECONDS) return null;

  const message = buildSignedMessage(agent.address, nonce, timestamp);

  try {
    const valid = await verifyMessage({
      address: agent.address as `0x${string}`,
      message,
      signature: agent.signature as `0x${string}`,
    });
    if (!valid) return null;
  } catch {
    return null;
  }

  return agent.address.toLowerCase();
}

/**
 * Verifies every agent signature. All-or-nothing: one bad signature fails the whole frame.
 * Verifications run concurrently; a 50-agent auth should not serialise 50 ECDSA recoveries.
 */
export async function verifyAuth(
  agents: AgentAuth[],
  nonce: string,
  timestamp: number,
): Promise<string[] | null> {
  const results = await Promise.all(
    agents.map((agent) => verifyAgent(agent, nonce, timestamp)),
  );
  const verified: string[] = [];
  for (const addr of results) {
    if (!addr) return null;
    verified.push(addr);
  }
  return verified;
}
