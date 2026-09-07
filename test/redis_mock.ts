import { COMPARE_AND_DELETE, COMPARE_AND_EXPIRE } from "../src/redis.ts";

interface StoreEntry {
  value: string;
  expiresAt: number;
}

type Op = () => Promise<unknown>;

class MockPipeline {
  private ops: Op[] = [];
  constructor(private redis: MockRedis) {}

  set(key: string, value: string, ex: "EX", ttl: number, get: "GET"): MockPipeline {
    this.ops.push(() => this.redis.set(key, value, ex, ttl, get));
    return this;
  }

  eval(script: string, numKeys: number, ...args: (string | number)[]): MockPipeline {
    this.ops.push(() => this.redis.eval(script, numKeys, ...args));
    return this;
  }

  async exec(): Promise<[Error | null, unknown][]> {
    const out: [Error | null, unknown][] = [];
    for (const op of this.ops) {
      try {
        out.push([null, await op()]);
      } catch (e) {
        out.push([e as Error, null]);
      }
    }
    return out;
  }
}

export class MockRedis {
  readonly store = new Map<string, StoreEntry>();
  /** Every TTL refresh attempted via COMPARE_AND_EXPIRE, whether or not it succeeded. */
  expireCalls: { key: string; ttl: number }[] = [];
  /** When set, every command rejects with this error (simulates an outage). */
  failWith: Error | null = null;

  private getEntry(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  // Handles: set(key, value, "EX", ttl, "GET") -> previous value (force-claim, returns old owner)
  set(
    key: string,
    value: string,
    _ex: "EX",
    ttl: number,
    _get: "GET",
  ): Promise<string | null> {
    this.check();
    const previous = this.getEntry(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return Promise.resolve(previous);
  }

  /** Number of GET commands issued (route-cache tests assert on this). */
  getCalls = 0;

  get(key: string): Promise<string | null> {
    this.check();
    this.getCalls++;
    return Promise.resolve(this.getEntry(key));
  }

  mget(keys: string[]): Promise<(string | null)[]> {
    this.check();
    return Promise.resolve(keys.map((k) => this.getEntry(k)));
  }

  del(key: string): Promise<number> {
    this.check();
    const had = this.store.has(key);
    this.store.delete(key);
    return Promise.resolve(had ? 1 : 0);
  }

  expire(key: string, ttl: number): Promise<number> {
    this.check();
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + ttl * 1000;
    return Promise.resolve(1);
  }

  eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.check();
    const key = String(args[0]);
    const owner = String(args[1]);
    if (script === COMPARE_AND_DELETE) {
      if (this.getEntry(key) === owner) return this.del(key);
      return Promise.resolve(0);
    }
    if (script === COMPARE_AND_EXPIRE) {
      const ttl = Number(args[2]);
      this.expireCalls.push({ key, ttl });
      if (this.getEntry(key) === owner) return this.expire(key, ttl);
      return Promise.resolve(0);
    }
    throw new Error(`MockRedis: unknown script`);
  }

  pipeline(): MockPipeline {
    return new MockPipeline(this);
  }
}
