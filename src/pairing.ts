import { verifyMessage } from "viem";
import { jsonResponse, readBody } from "./http.ts";
import { getPairSession, pairSessionExists, setPairSession } from "./redis.ts";

const TIMESTAMP_WINDOW_SECONDS = 30;

function isValidCode(code: string): boolean {
  return /^\d{4}$/.test(code);
}

function generateCode(): string {
  const n = Math.floor(Math.random() * 10000);
  return n.toString().padStart(4, "0");
}

async function findFreeCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateCode();
    if (!(await pairSessionExists(code))) return code;
  }
  throw new Error("no_free_code");
}

function isValidTimestamp(timestamp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= TIMESTAMP_WINDOW_SECONDS;
}

async function verifySig(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// POST /pair/initiate
// Body: { agentAddress, timestamp, signature }
export async function handleInitiate(req: Request): Promise<Response> {
  const raw = await readBody(req, 1024);
  if (raw === null) return jsonResponse(400, { error: "body_too_large" });

  let body: { agentAddress?: string; timestamp?: number; signature?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const { agentAddress, timestamp, signature } = body;
  if (!agentAddress || typeof timestamp !== "number" || !signature) {
    return jsonResponse(400, { error: "missing_fields" });
  }
  if (!isValidTimestamp(timestamp)) {
    return jsonResponse(400, { error: "timestamp_out_of_window" });
  }

  const message = `osaurus-pair:initiate:${agentAddress}:${timestamp}`;
  const valid = await verifySig(agentAddress, message, signature);
  if (!valid) return jsonResponse(401, { error: "invalid_signature" });

  let code: string;
  try {
    code = await findFreeCode();
  } catch {
    return jsonResponse(503, { error: "no_codes_available" });
  }

  await setPairSession(code, {
    initiatorAddress: agentAddress.toLowerCase(),
    state: "pending",
  });
  return jsonResponse(200, { code });
}

// GET /pair/:code
// Returns initiator address for the approver to display
export async function handleFetch(code: string): Promise<Response> {
  if (!isValidCode(code)) return jsonResponse(400, { error: "invalid_code" });

  const session = await getPairSession(code);
  if (!session) return jsonResponse(404, { error: "not_found" });
  if (session.state === "approved")
    return jsonResponse(409, { error: "already_approved" });

  return jsonResponse(200, { initiatorAddress: session.initiatorAddress });
}

// POST /pair/approve
// Body: { code, pairingAddress, timestamp, signature }
export async function handleApprove(req: Request): Promise<Response> {
  const raw = await readBody(req, 1024);
  if (raw === null) return jsonResponse(400, { error: "body_too_large" });

  let body: {
    code?: string;
    pairingAddress?: string;
    timestamp?: number;
    signature?: string;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const { code, pairingAddress, timestamp, signature } = body;
  if (!code || !pairingAddress || typeof timestamp !== "number" || !signature) {
    return jsonResponse(400, { error: "missing_fields" });
  }
  if (!isValidCode(code)) return jsonResponse(400, { error: "invalid_code" });
  if (!isValidTimestamp(timestamp))
    return jsonResponse(400, { error: "timestamp_out_of_window" });

  const session = await getPairSession(code);
  if (!session) return jsonResponse(404, { error: "not_found" });
  if (session.state === "approved")
    return jsonResponse(409, { error: "already_approved" });

  const message = `osaurus-pair:approve:${code}:${session.initiatorAddress}:${pairingAddress}:${timestamp}`;
  const valid = await verifySig(pairingAddress, message, signature);
  if (!valid) return jsonResponse(401, { error: "invalid_signature" });

  await setPairSession(code, {
    initiatorAddress: session.initiatorAddress,
    state: "approved",
    approverAddress: pairingAddress.toLowerCase(),
  });

  return jsonResponse(200, { initiatorAddress: session.initiatorAddress });
}

// GET /pair/:code/result
// Polled by initiator to check if approved
export async function handleResult(code: string): Promise<Response> {
  if (!isValidCode(code)) return jsonResponse(400, { error: "invalid_code" });

  const session = await getPairSession(code);
  if (!session) return jsonResponse(200, { status: "not_found" });

  if (session.state === "approved") {
    return jsonResponse(200, {
      status: "approved",
      approverAddress: session.approverAddress,
    });
  }
  return jsonResponse(200, { status: "pending" });
}
