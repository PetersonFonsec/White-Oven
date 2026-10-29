import type { SecretStore } from "./client.ts";

export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
interface Version {
  id: string;
  count: number;
}
interface Journal extends Version {
  previous: Version | null;
}
/**
 * Immutable chunks, then one commit pointer. A failed write leaves the previous record readable.
 *
 * Chunks never referenced by the pointer are garbage: a failed write removes its own chunks before
 * reporting the error, and a journal entry written before any chunk names the version being
 * written and the one it replaces, so chunks left by a process killed mid-write (or by a cleanup
 * that failed) are removed by the next write or removal. Chunks of the version the pointer
 * references are never removed. Limit: SecureStore cannot list keys, so garbage whose journal
 * entry was overwritten after a sweep failed (storage failing on consecutive operations) stays
 * until the app's data is cleared. It is never read.
 */
export function secureRecord(
  kv: SecureKV,
  prefix: string,
  uuid: () => string,
): SecretStore {
  const pointer = `${prefix}.head`;
  const journal = `${prefix}.journal`;
  function metadata(raw: string): Version {
    const value = JSON.parse(raw) as Version;
    if (
      !/^[a-f0-9-]{36}$/.test(value.id) ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > 2048
    )
      throw new Error(
        "Não foi possível ler os dados locais. Não envie outro pedido antes de conferir com a loja.",
      );
    return { id: value.id, count: value.count };
  }
  /** Tries every chunk; resolves only when all of them were removed. */
  async function drop(version: Version | null) {
    if (!version) return;
    const results = await Promise.allSettled(
      Array.from({ length: version.count }, (_, i) =>
        kv.remove(`${prefix}.${version.id}.${i}`),
      ),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  /** Removes what an interrupted or failed earlier operation left behind. Best effort. */
  async function sweep(current: Version | null) {
    const raw = await kv.get(journal);
    if (raw === null) return;
    const entry = JSON.parse(raw) as Journal;
    const written = metadata(raw);
    const previous = entry.previous
      ? metadata(JSON.stringify(entry.previous))
      : null;
    // Committed: only the version it replaced is garbage. Not committed: its own chunks are.
    const garbage = current?.id === written.id ? previous : written;
    if (garbage && garbage.id !== current?.id) await drop(garbage);
    await kv.remove(journal);
  }
  let queue: Promise<unknown> = Promise.resolve();
  /** Writes and removals of one record run one at a time, so no cleanup races a commit. */
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    async read() {
      const raw = await kv.get(pointer);
      if (raw === null) return null;
      const { id, count } = metadata(raw);
      const chunks = await Promise.all(
        Array.from({ length: count }, (_, i) => kv.get(`${prefix}.${id}.${i}`)),
      );
      if (chunks.some((chunk) => chunk === null))
        throw new Error(
          "Dados locais incompletos. Confira o pedido com a loja antes de continuar.",
        );
      return chunks.join("");
    },
    write: (value) =>
      serial(async () => {
        // 400 UTF-16 units stay below native per-entry limits even with non-ASCII text.
        const chunks: string[] = [];
        const characters = Array.from(value);
        for (let i = 0; i < characters.length; i += 200)
          chunks.push(characters.slice(i, i + 200).join(""));
        if (!chunks.length) chunks.push("");
        if (chunks.length > 2048)
          throw new Error("O carrinho excedeu o tamanho permitido.");
        const raw = await kv.get(pointer);
        const old = raw === null ? null : metadata(raw);
        await sweep(old).catch(() => {});
        const next: Version = { id: uuid(), count: chunks.length };
        // Recorded before the first chunk, so a killed process leaves its chunks findable.
        await kv.set(journal, JSON.stringify({ ...next, previous: old }));
        let attempted = 0;
        try {
          for (; attempted < chunks.length; attempted++)
            await kv.set(
              `${prefix}.${next.id}.${attempted}`,
              chunks[attempted]!,
            );
          await kv.set(pointer, JSON.stringify(next));
        } catch (error) {
          // A pointer write may fail after it landed: never remove what the pointer references.
          const head = await kv.get(pointer).then(
            (current) => (current === null ? null : metadata(current).id),
            () => undefined,
          );
          // The commit landed after all: continue as a successful write.
          if (head !== next.id) {
            // Unknown head: keep the chunks rather than risk them; the journal still names them.
            if (head !== undefined)
              await drop({
                id: next.id,
                count: Math.min(attempted + 1, chunks.length),
              })
                .then(() => kv.remove(journal))
                .catch(() => {});
            // The original error wins over any cleanup failure.
            throw error;
          }
        }
        // Committed. Cleanup must not turn it into a reported failure; the journal covers retries.
        await drop(old)
          .then(() => kv.remove(journal))
          .catch(() => {});
      }),
    remove: () =>
      serial(async () => {
        const raw = await kv.get(pointer);
        const old = raw === null ? null : metadata(raw);
        await sweep(old).catch(() => {});
        if (!old) return kv.remove(pointer);
        // Named before the pointer goes, so a killed process leaves the chunks findable.
        await kv.set(journal, JSON.stringify({ ...old, previous: null }));
        await kv.remove(pointer);
        await drop(old)
          .then(() => kv.remove(journal))
          .catch(() => {});
      }),
  };
}
