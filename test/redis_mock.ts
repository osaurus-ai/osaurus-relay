interface StoreEntry {
  value: string;
  expiresAt: number;
}

export class MockRedis {
  readonly store = new Map<string, StoreEntry>();
  expireCalls: { key: string; ttl: number }[] = [];

  private getEntry(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  // Handles: set(key, value, "EX", ttl, "NX", "GET")
  set(
    key: string,
    value: string,
    _ex: string,
    ttl: number,
    _nx: string,
    _get: string,
  ): Promise<string | null> {
    const current = this.getEntry(key);
    if (current !== null) {
      return Promise.resolve(current); // NX: key exists, return old value, skip write
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return Promise.resolve(null); // GET returns old value (was null)
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.getEntry(key));
  }

  del(key: string): Promise<number> {
    const had = this.store.has(key);
    this.store.delete(key);
    return Promise.resolve(had ? 1 : 0);
  }

  expire(key: string, ttl: number): Promise<number> {
    this.expireCalls.push({ key, ttl });
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + ttl * 1000;
    return Promise.resolve(1);
  }
}
