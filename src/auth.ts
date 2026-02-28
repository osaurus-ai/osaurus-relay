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

export async function verifyAuth(
  agents: AgentAuth[],
  nonce: string,
  timestamp: number,
): Promise<string[] | null> {
  const verified: string[] = [];
  for (const agent of agents) {
    const addr = await verifyAgent(agent, nonce, timestamp);
    if (!addr) return null;
    verified.push(addr);
  }
  return verified;
}
