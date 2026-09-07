import type { TimerHandle } from "./types.ts";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const CLEANUP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 120_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per millisecond
  private cleanupTimer: TimerHandle;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.refillRate = maxTokens / windowMs;

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, lastRefill: now });
      return true;
    }

    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return false;

    bucket.tokens -= 1;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > STALE_THRESHOLD_MS) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}

// All limiters are per relay machine (not shared across the fleet), so effective global limits
// scale with machine count. They are abuse brakes, not quotas.

// 20 tunnel connection attempts per minute per source IP. Sized so a team behind one NAT
// (office, campus) can all reconnect after a relay restart without locking each other out.
export const tunnelLimiter = new RateLimiter(20, 60_000);

// 100 inbound requests per minute per agent address (checked only on the owning machine).
export const requestLimiter = new RateLimiter(100, 60_000);

// 300 inbound requests per minute per caller IP, independent of the per-agent budget above, so a
// single caller cannot exhaust an agent's budget and lock its owner out.
export const callerLimiter = new RateLimiter(300, 60_000);

// 10 post-auth control frames (request_challenge / add_agent) per minute per tunnel connection.
// Each add_agent costs an ECDSA recovery on the event loop; the 50-agent cap only counts
// successes, so failures need their own brake.
export const controlFrameLimiter = new RateLimiter(10, 60_000);

// 10 stats requests per minute per source IP
export const statsLimiter = new RateLimiter(10, 60_000);

// 120 presence requests per minute per source IP: sized for the router's service traffic
// (short-cache batch lookups), and deliberately NOT shared with the public /stats bucket so
// stats scraping can't starve presence (or vice versa).
export const presenceLimiter = new RateLimiter(120, 60_000);
