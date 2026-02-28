import { verifyMessage } from "viem";
import type { AgentAuth } from "./types.ts";

const TIMESTAMP_WINDOW_SECONDS = 30;

function buildSignedMessage(address: string, timestamp: number): string {
  return `osaurus-tunnel:${address}:${timestamp}`;
}

export async function verifyAgent(
  agent: AgentAuth,
  timestamp: number,
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_WINDOW_SECONDS) return null;

  const message = buildSignedMessage(agent.address, timestamp);

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
  timestamp: number,
): Promise<string[] | null> {
  const verified: string[] = [];
  for (const agent of agents) {
    const addr = await verifyAgent(agent, timestamp);
    if (!addr) return null;
    verified.push(addr);
  }
  return verified;
}
