import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { generateNonce, verifyAgent, verifyAuth } from "../src/auth.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

async function signForTunnel(address: string, nonce: string, timestamp: number): Promise<string> {
  const message = `osaurus-tunnel:${address}:${nonce}:${timestamp}`;
  return await account.signMessage({ message });
}

Deno.test("verifyAgent - valid signature within window", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signForTunnel(account.address, nonce, timestamp);

  const result = await verifyAgent(
    { address: account.address, signature },
    nonce,
    timestamp,
  );
  assertEquals(result, account.address.toLowerCase());
});

Deno.test("verifyAgent - expired timestamp", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  const signature = await signForTunnel(account.address, nonce, timestamp);

  const result = await verifyAgent(
    { address: account.address, signature },
    nonce,
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAgent - wrong address", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signForTunnel(account.address, nonce, timestamp);
  const fakeAddress = "0x0000000000000000000000000000000000000001";

  const result = await verifyAgent(
    { address: fakeAddress, signature },
    nonce,
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAgent - invalid signature bytes", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await verifyAgent(
    { address: account.address, signature: "0xdeadbeef" },
    nonce,
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAgent - wrong nonce rejects", async () => {
  const nonceA = generateNonce();
  const nonceB = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signForTunnel(account.address, nonceA, timestamp);

  const result = await verifyAgent(
    { address: account.address, signature },
    nonceB,
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAuth - all valid", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = await signForTunnel(account.address, nonce, timestamp);

  const result = await verifyAuth(
    [{ address: account.address, signature: sig }],
    nonce,
    timestamp,
  );
  assertEquals(result, [account.address.toLowerCase()]);
});

Deno.test("verifyAuth - one invalid rejects all", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const validSig = await signForTunnel(account.address, nonce, timestamp);

  const result = await verifyAuth(
    [
      { address: account.address, signature: validSig },
      { address: "0x0000000000000000000000000000000000000001", signature: validSig },
    ],
    nonce,
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("generateNonce returns 64 char hex", () => {
  const nonce = generateNonce();
  assertEquals(nonce.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(nonce), true);
});

Deno.test("generateNonce is unique each call", () => {
  const a = generateNonce();
  const b = generateNonce();
  assertEquals(a !== b, true);
});
