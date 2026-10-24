// Outcome of real lead writes, shared between the Astro bundle and the Node launcher.
// Readiness reads it passively, so probes never have to write to report write failures.
export const WRITE_FAILURE_THRESHOLD = 3;
export interface WriteOutcome {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
}
const key = Symbol.for("whiteoven.writeOutcome");
const runtime = globalThis as typeof globalThis & {
  [key: symbol]: WriteOutcome | undefined;
};
const state = (): WriteOutcome =>
  (runtime[key] ??= { consecutiveFailures: 0, lastSuccessAt: null });
export function recordWrite(succeeded: boolean, now = Date.now()) {
  const current = state();
  if (succeeded) {
    current.consecutiveFailures = 0;
    current.lastSuccessAt = now;
  } else current.consecutiveFailures++;
}
export function writeStatus(): "ok" | "unknown" | "failing" {
  const current = state();
  if (current.consecutiveFailures >= WRITE_FAILURE_THRESHOLD) return "failing";
  return current.lastSuccessAt === null ? "unknown" : "ok";
}
export function resetWriteOutcome() {
  runtime[key] = undefined;
}
