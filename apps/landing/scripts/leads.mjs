import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { getCaptureConfig } from "../src/server/config.ts";
import { SqliteLeadStore } from "../src/server/lead-store.ts";
const [command, argument] = process.argv.slice(2);
const config = getCaptureConfig();
if (!["inspect", "export", "purge", "delete", "clear-dev"].includes(command)) {
  console.error(
    "Uso: pnpm leads inspect | export <arquivo.json> | purge | delete <uuid> | clear-dev --confirm",
  );
  process.exit(1);
}
let store;
try {
  if (
    command === "clear-dev" &&
    (process.env.NODE_ENV === "production" ||
      basename(config.databasePath) !== "leads.dev.sqlite" ||
      argument !== "--confirm")
  )
    throw new Error("INVALID_OPERATION");
  if (
    command === "export" &&
    (!argument?.endsWith(".json") ||
      basename(dirname(resolve(argument))) !== "lead-exports")
  )
    throw new Error("INVALID_OPERATION");
  if (command === "delete" && !/^[0-9a-f-]{36}$/i.test(argument ?? ""))
    throw new Error("INVALID_OPERATION");
  store = new SqliteLeadStore(config.databasePath);
  if (command === "inspect")
    console.table(
      store
        .exportLeads()
        .map(({ id, createdAt, interestedPlan, monthlyOrderVolume }) => ({
          id,
          createdAt,
          interestedPlan,
          monthlyOrderVolume,
        })),
    );
  if (command === "export") {
    mkdirSync(dirname(argument), { recursive: true, mode: 0o700 });
    if ((statSync(dirname(argument)).mode & 0o077) !== 0)
      throw new Error("UNSAFE_EXPORT_DIRECTORY");
    writeFileSync(argument, JSON.stringify(store.exportLeads(), null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "Exportação criada. Contém dados pessoais; mantenha acesso restrito.",
    );
  }
  if (command === "purge")
    console.log(`Registros expirados removidos: ${store.purgeExpired()}`);
  if (command === "delete")
    console.log(
      store.deleteLead(argument)
        ? "Registro removido."
        : "Registro não encontrado.",
    );
  if (command === "clear-dev") {
    store.clearDevelopment();
    console.log("Dados locais de desenvolvimento removidos.");
  }
} catch {
  console.error(
    "Operação não concluída. Confira comando, caminho e permissões; nenhum dado pessoal foi impresso.",
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
