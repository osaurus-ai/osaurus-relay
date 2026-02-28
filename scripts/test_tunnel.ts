/**
 * Manual integration test for a live relay deployment.
 *
 * Usage:
 *   deno run --allow-net scripts/test_tunnel.ts [relay-base-domain]
 *
 * Default relay base domain: agent.osaurus.ai
 *
 * What it does:
 *   1. Generates a random secp256k1 keypair
 *   2. Connects a WebSocket tunnel to the relay
 *   3. Waits for the server challenge nonce
 *   4. Signs and sends an auth frame with the server nonce
 *   5. Waits for auth_ok and prints the agent's public URL
 *   6. Echoes back any requests that come through the tunnel
 *   7. Press Ctrl+C to disconnect
 */

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const BASE_DOMAIN = Deno.args[0] ?? "agent.osaurus.ai";
const WS_URL = `wss://${BASE_DOMAIN}/tunnel/connect`;

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("--- Osaurus Relay Tunnel Test ---");
console.log(`Agent address: ${account.address}`);
console.log(`Connecting to: ${WS_URL}`);
console.log();

const ws = new WebSocket(WS_URL);

ws.onopen = () => {
  console.log("WebSocket connected, waiting for challenge...");
};

ws.onmessage = async (event) => {
  const frame = JSON.parse(event.data);

  switch (frame.type) {
    case "challenge": {
      console.log("Received challenge, sending auth...");
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = frame.nonce as string;
      const message = `osaurus-tunnel:${account.address}:${nonce}:${timestamp}`;
      const signature = await account.signMessage({ message });
      ws.send(JSON.stringify({
        type: "auth",
        agents: [{ address: account.address, signature }],
        nonce,
        timestamp,
      }));
      break;
    }

    case "auth_ok":
      console.log("Authenticated!");
      console.log();
      for (const agent of frame.agents) {
        console.log(`  ${agent.address}`);
        console.log(`  ${agent.url}`);
      }
      console.log();
      console.log("Tunnel is live. Echoing requests. Test with:");
      console.log();
      console.log(
        `  curl -X POST ${frame.agents[0].url}/v1/chat/completions \\`,
      );
      console.log(`    -H "Content-Type: application/json" \\`);
      console.log(`    -d '{"message": "hello"}'`);
      console.log();
      console.log("Press Ctrl+C to disconnect.");
      console.log("---");
      break;

    case "auth_error":
      console.error("Auth failed:", frame.error);
      ws.close();
      Deno.exit(1);
      break;

    case "request": {
      console.log(`← ${frame.method} ${frame.path}`);
      const responseBody = JSON.stringify({
        echo: true,
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: frame.body,
        timestamp: new Date().toISOString(),
      });
      ws.send(JSON.stringify({
        type: "response",
        id: frame.id,
        status: 200,
        headers: { "content-type": "application/json" },
        body: responseBody,
      }));
      console.log(`→ 200 OK (${responseBody.length} bytes)`);
      break;
    }

    case "ping":
      ws.send(JSON.stringify({ type: "pong", ts: frame.ts }));
      break;

    default:
      console.log("Frame:", frame);
  }
};

ws.onclose = (event) => {
  console.log(`Disconnected (code=${event.code}, reason=${event.reason})`);
  Deno.exit(0);
};

ws.onerror = (event) => {
  console.error("WebSocket error:", event);
};
