import { assertEquals } from "jsr:@std/assert";
import { handlePresence } from "../src/presence.ts";
import { _setClientForTesting } from "../src/redis.ts";
import { MockRedis } from "./redis_mock.ts";

const TOKEN = "test-presence-secret-0123456789abcdef"; // >= 32 chars (strength gate)
const ADDR_A = "0x" + "aa".repeat(20);
const ADDR_B = "0x" + "bb".repeat(20);

function presenceReq(
  addresses: string,
  token: string | null = TOKEN,
): { req: Request; url: URL } {
  const url = new URL(`https://relay.test/presence?addresses=${addresses}`);
  const headers = new Headers();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return { req: new Request(url, { headers }), url };
}

Deno.test("presence: unconfigured token -> 404", async () => {
  Deno.env.delete("PRESENCE_TOKEN");
  const { req, url } = presenceReq(ADDR_A);
  const res = await handlePresence(req, url);
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("presence: token below 32 chars disables the endpoint (404)", async () => {
  Deno.env.set("PRESENCE_TOKEN", "short-secret");
  try {
    const { req, url } = presenceReq(ADDR_A, "short-secret");
    const res = await handlePresence(req, url);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    Deno.env.delete("PRESENCE_TOKEN");
  }
});

Deno.test("presence: wrong or missing bearer -> 401", async () => {
  Deno.env.set("PRESENCE_TOKEN", TOKEN);
  try {
    const wrong = presenceReq(ADDR_A, "nope");
    assertEquals((await handlePresence(wrong.req, wrong.url)).status, 401);
    const missing = presenceReq(ADDR_A, null);
    assertEquals((await handlePresence(missing.req, missing.url)).status, 401);
  } finally {
    Deno.env.delete("PRESENCE_TOKEN");
  }
});

Deno.test("presence: malformed address list -> 400", async () => {
  Deno.env.set("PRESENCE_TOKEN", TOKEN);
  try {
    const empty = presenceReq("");
    assertEquals((await handlePresence(empty.req, empty.url)).status, 400);
    const junk = presenceReq("not-an-address");
    assertEquals((await handlePresence(junk.req, junk.url)).status, 400);
    const tooMany = presenceReq(Array(101).fill(ADDR_A).join(","));
    assertEquals((await handlePresence(tooMany.req, tooMany.url)).status, 400);
    // Oversized raw param is rejected before splitting (bounded allocation).
    const oversized = presenceReq("x".repeat(5000));
    assertEquals((await handlePresence(oversized.req, oversized.url)).status, 400);
  } finally {
    Deno.env.delete("PRESENCE_TOKEN");
  }
});

Deno.test("presence: redis-claimed agents are online, unknown ones offline", async () => {
  Deno.env.set("PRESENCE_TOKEN", TOKEN);
  const redis = new MockRedis();
  _setClientForTesting(redis);
  try {
    // ADDR_A is claimed (by any instance); ADDR_B is unknown.
    await redis.set(`agent:${ADDR_A}`, "some-machine", "EX", 120, "GET");
    const { req, url } = presenceReq(`${ADDR_A},${ADDR_B.toUpperCase()}`);
    const res = await handlePresence(req, url);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.presence[ADDR_A].online, true);
    assertEquals(typeof body.presence[ADDR_A].last_seen, "string");
    assertEquals(body.presence[ADDR_B].online, false);
    assertEquals(body.presence[ADDR_B].last_seen, null);
  } finally {
    _setClientForTesting(null);
    Deno.env.delete("PRESENCE_TOKEN");
  }
});
