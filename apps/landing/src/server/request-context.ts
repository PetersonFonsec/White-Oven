import { AsyncLocalStorage } from "node:async_hooks";
// The launcher and Astro bundle share a process, but not a module instance.
// No browser header can populate this context.
const key = Symbol.for("whiteoven.requestClient");
const runtime = globalThis as typeof globalThis & {
  [key: symbol]: AsyncLocalStorage<string> | undefined;
};
const context = (runtime[key] ??= new AsyncLocalStorage<string>());
export const withRequestClient = <T>(client: string, operation: () => T): T =>
  context.run(client, operation);
export const getRequestClient = (): string | undefined => context.getStore();
