// In-process cache of agent address -> owning machine id, in front of the Redis lookup.
//
// In a multi-region deployment most requests land on a non-owner machine first (Fly routes to
// the nearest machine, not the one holding the tunnel). Without this cache every such request
// pays a Redis round trip before it can be replayed. Positive entries are short so a host that
// moves machines is picked up quickly; negative entries are shorter still so a host that just
// connected elsewhere is not reported offline for long.

const POSITIVE_TTL_MS = 10_000;
const NEGATIVE_TTL_MS = 2_000;
const MAX_ENTRIES = 50_000;

interface Entry {
  machineId: string | null;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/** Returns the cached owner (string), a cached "nobody" (null), or undefined on a miss. */
export function getCachedOwner(address: string): string | null | undefined {
  const entry = cache.get(address);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(address);
    return undefined;
  }
  return entry.machineId;
}

export function setCachedOwner(address: string, machineId: string | null): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(address)) {
    // Bounded memory: drop the oldest insertion. Map preserves insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const ttl = machineId === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  cache.set(address, { machineId, expiresAt: Date.now() + ttl });
}

export function invalidateCachedOwner(address: string): void {
  cache.delete(address);
}

export function routeCacheSize(): number {
  return cache.size;
}

export function _clearRouteCacheForTesting(): void {
  cache.clear();
}
