import { handleRequest } from "./src/router.ts";
import { closeAllTunnels, totalInflight } from "./src/tunnel.ts";
import { markShuttingDown } from "./src/lifecycle.ts";
import { log } from "./src/observability.ts";
import { FLY_MACHINE_ID, FLY_REGION } from "./src/env.ts";

const PORT = parseInt(Deno.env.get("PORT") ?? "8080");

// How long to keep serving in-flight requests after SIGTERM before closing tunnels. Must stay
// under fly.toml's kill_timeout (30s) with margin for the tunnel close + server shutdown.
const DRAIN_TIMEOUT_MS = 20_000;
const DRAIN_POLL_MS = 250;

// --- Crash safety ---------------------------------------------------------------------------
//
// Deno terminates the process on an unhandled promise rejection or uncaught exception. For a
// relay that means every tunnel on the machine drops because one handler had a bug or Redis
// blipped. Log loudly and keep running instead.

globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const reason = event.reason;
  log("error", "process.unhandled_rejection", {
    error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});

globalThis.addEventListener("error", (event) => {
  event.preventDefault();
  const err = event.error;
  log("error", "process.uncaught_error", {
    error: err instanceof Error ? (err.stack ?? err.message) : String(event.message),
  });
});

// --- Server ----------------------------------------------------------------------------------

const server = Deno.serve({
  port: PORT,
  onListen: ({ port }) => log("info", "server.listening", { port }),
}, handleRequest);

// --- Graceful shutdown -----------------------------------------------------------------------
//
// Fly sends SIGTERM before replacing a machine. Order matters:
//   1. Flip the shutdown flag: /health returns 503 (so the proxy stops sending new traffic) and
//      /tunnel/connect returns 503 (so hosts reconnect elsewhere instead of to a dying machine).
//   2. Keep serving until in-flight requests finish or the drain window elapses.
//   3. Tell every host we are restarting and close its socket so it reconnects immediately
//      rather than discovering the loss via missed pings. This also releases Redis claims.
//   4. Stop the HTTP server and exit.

let shutdownStarted = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  markShuttingDown();
  log("info", "server.shutdown_started", { signal, inflight: totalInflight() });

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (totalInflight() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }

  const closed = closeAllTunnels("relay_restarting");
  log("info", "server.tunnels_closed", { tunnels: closed, inflight_abandoned: totalInflight() });

  try {
    await server.shutdown();
  } catch { /* already closed */ }
  log("info", "server.shutdown_complete", { region: FLY_REGION, machine: FLY_MACHINE_ID });
  Deno.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  try {
    Deno.addSignalListener(signal, () => {
      shutdown(signal).catch((err) => {
        log("error", "server.shutdown_failed", { error: String(err) });
        Deno.exit(1);
      });
    });
  } catch {
    // Signal not supported on this platform (e.g. Windows); rely on the default behaviour.
  }
}
