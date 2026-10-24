import { accessSync, constants, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { CaptureConfig } from "./config.ts";
import type { SqliteLeadStore } from "./lead-store.ts";
import { writeStatus } from "./persistence-health.ts";
export interface OperationalHealth {
  ready: boolean;
  capture: "enabled" | "disabled";
  storage: "ready" | "unavailable";
  writes: "ok" | "unknown" | "failing";
}
const key = Symbol.for("whiteoven.operationalHealth");
const runtime = globalThis as typeof globalThis & {
  [key: symbol]: (() => OperationalHealth) | undefined;
};
export function registerHealth(
  config: () => CaptureConfig,
  store: SqliteLeadStore | undefined,
  requested: boolean,
) {
  let draining = false;
  runtime[key] = () => {
    const settings = config();
    let storage = false;
    try {
      if (store) {
        accessSync(settings.databasePath, constants.R_OK | constants.W_OK);
        accessSync(
          dirname(settings.databasePath),
          constants.W_OK | constants.X_OK,
        );
        const disk = statfsSync(dirname(settings.databasePath));
        storage =
          disk.bavail * disk.bsize >= 8 * 1024 * 1024 && store.isHealthy();
      }
    } catch {
      /* No paths, SQL, records or exceptions exposed. */
    }
    const writes = writeStatus();
    return {
      ready:
        !draining &&
        (!requested || (settings.enabled && storage && writes !== "failing")),
      capture: settings.enabled ? "enabled" : "disabled",
      storage: storage ? "ready" : "unavailable",
      writes,
    };
  };
  return () => {
    draining = true;
  };
}
export function operationalHealth(): OperationalHealth {
  return (
    runtime[key]?.() ?? {
      ready: false,
      capture: "disabled",
      storage: "unavailable",
      writes: writeStatus(),
    }
  );
}
export function healthResponse(live: boolean) {
  const state = live ? null : operationalHealth();
  return new Response(JSON.stringify(live ? { status: "alive" } : state), {
    status: live || state?.ready ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
