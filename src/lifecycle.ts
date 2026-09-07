// Process lifecycle flags shared between main.ts (signal handling) and the router/tunnel code.
// Kept in its own module to avoid import cycles.

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function _resetLifecycleForTesting(): void {
  shuttingDown = false;
}
