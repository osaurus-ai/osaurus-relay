import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { verifyAgent, verifyAuth } from "../src/auth.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

async function signForTunnel(address: string, timestamp: number): Promise<string> {
  const message = `osaurus-tunnel:${address}:${timestamp}`;
  return await account.signMessage({ message });
}

Deno.test("verifyAgent - valid signature within window", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signForTunnel(account.address, timestamp);

  const result = await verifyAgent(
    { address: account.address, signature },
    timestamp,
  );
  assertEquals(result, account.address.toLowerCase());
});

Deno.test("verifyAgent - expired timestamp", async () => {
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  const signature = await signForTunnel(account.address, timestamp);

  const result = await verifyAgent(
    { address: account.address, signature },
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAgent - wrong address", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signForTunnel(account.address, timestamp);
  const fakeAddress = "0x0000000000000000000000000000000000000001";

  const result = await verifyAgent(
    { address: fakeAddress, signature },
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAgent - invalid signature bytes", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await verifyAgent(
    { address: account.address, signature: "0xdeadbeef" },
    timestamp,
  );
  assertEquals(result, null);
});

Deno.test("verifyAuth - all valid", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = await signForTunnel(account.address, timestamp);

  const result = await verifyAuth(
    [{ address: account.address, signature: sig }],
    timestamp,
  );
  assertEquals(result, [account.address.toLowerCase()]);
});

Deno.test("verifyAuth - one invalid rejects all", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const validSig = await signForTunnel(account.address, timestamp);

  const result = await verifyAuth(
    [
      { address: account.address, signature: validSig },
      { address: "0x0000000000000000000000000000000000000001", signature: validSig },
    ],
    timestamp,
  );
  assertEquals(result, null);
});
