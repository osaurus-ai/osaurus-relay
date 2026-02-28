import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { RateLimiter } from "../src/rate_limit.ts";

Deno.test("RateLimiter - allows up to max tokens", () => {
  const limiter = new RateLimiter(3, 60_000);
  assertEquals(limiter.allow("a"), true);
  assertEquals(limiter.allow("a"), true);
  assertEquals(limiter.allow("a"), true);
  assertEquals(limiter.allow("a"), false);
  limiter.destroy();
});

Deno.test("RateLimiter - separate keys are independent", () => {
  const limiter = new RateLimiter(1, 60_000);
  assertEquals(limiter.allow("a"), true);
  assertEquals(limiter.allow("a"), false);
  assertEquals(limiter.allow("b"), true);
  assertEquals(limiter.allow("b"), false);
  limiter.destroy();
});

Deno.test("RateLimiter - tokens refill over time", async () => {
  const limiter = new RateLimiter(1, 200);
  assertEquals(limiter.allow("a"), true);
  assertEquals(limiter.allow("a"), false);

  await new Promise((r) => setTimeout(r, 250));

  assertEquals(limiter.allow("a"), true);
  limiter.destroy();
});
