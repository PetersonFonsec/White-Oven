import type { SecretStore } from "./client.ts";

export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
/** Immutable chunks, then one commit pointer. A failed write leaves the previous record readable. */
export function secureRecord(
  kv: SecureKV,
  prefix: string,
  uuid: () => string,
): SecretStore {
  const pointer = `${prefix}.head`;
  function metadata(raw: string) {
    const value = JSON.parse(raw) as { id: string; count: number };
    if (
      !/^[a-f0-9-]{36}$/.test(value.id) ||
      !Number.isInteger(value.count) ||
      value.count < 1 ||
      value.count > 2048
    )
      throw new Error(
        "Não foi possível ler os dados locais. Não envie outro pedido antes de conferir com a loja.",
      );
    return value;
  }
  async function cleanup(raw: string | null) {
    if (!raw) return;
    const { id, count } = metadata(raw);
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        kv.remove(`${prefix}.${id}.${i}`),
      ),
    );
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
    async write(value) {
      // 400 UTF-16 units stay below native per-entry limits even with non-ASCII text.
      const chunks: string[] = [];
      const characters = Array.from(value);
      for (let i = 0; i < characters.length; i += 200)
        chunks.push(characters.slice(i, i + 200).join(""));
      if (!chunks.length) chunks.push("");
      if (chunks.length > 2048)
        throw new Error("O carrinho excedeu o tamanho permitido.");
      const old = await kv.get(pointer);
      const id = uuid();
      for (let i = 0; i < chunks.length; i++)
        await kv.set(`${prefix}.${id}.${i}`, chunks[i]!);
      await kv.set(pointer, JSON.stringify({ id, count: chunks.length }));
      // Cleanup must not turn an already committed write into a reported failure.
      await cleanup(old).catch(() => {});
    },
    async remove() {
      const old = await kv.get(pointer);
      await kv.remove(pointer);
      await cleanup(old).catch(() => {});
    },
  };
}
