import type { StoreView } from "../brand/store-loader.ts";

export interface StoreMessage {
  /** Which screen shows: the store, the closed notice or the unavailable notice. */
  screen: "store" | "closed" | "unavailable";
  title: string;
  body: string;
  /** Shown above the screen when the app could not reach the API. */
  offlineNotice: string | null;
}

function localTime(instant: string, timezone: string): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleTimeString("pt-BR", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

/** Texts of the first screen, in Portuguese, from what `loadStore` found. Pure, for tests. */
export function storeMessage(view: StoreView): StoreMessage {
  const offlineNotice =
    view.availability.kind !== "offline"
      ? null
      : view.brandSource === "manifest"
        ? "Sem conexão com a pizzaria. Confira a internet e tente de novo."
        : "Sem conexão. Mostrando a última versão salva da pizzaria.";
  switch (view.availability.kind) {
    case "open":
      return {
        screen: "store",
        title: view.name,
        body: "Aberta agora.",
        offlineNotice,
      };
    case "closed": {
      const { reason, pausedUntil, timezone } = view.availability;
      const until =
        reason === "PAUSED" && pausedUntil
          ? localTime(pausedUntil, timezone)
          : null;
      return {
        screen: "closed",
        title: "Loja fechada",
        body:
          reason === "PAUSED"
            ? until
              ? `${view.name} pausou os pedidos até ${until}.`
              : `${view.name} pausou os pedidos por enquanto.`
            : `${view.name} está fora do horário de funcionamento.`,
        offlineNotice,
      };
    }
    case "unavailable":
      return {
        screen: "unavailable",
        title: "Pizzaria indisponível",
        body: `${view.name} não está recebendo pedidos por este aplicativo no momento.`,
        offlineNotice,
      };
    case "offline":
      return {
        screen: "store",
        title: view.name,
        body: "Não foi possível confirmar se a loja está aberta.",
        offlineNotice,
      };
  }
}
