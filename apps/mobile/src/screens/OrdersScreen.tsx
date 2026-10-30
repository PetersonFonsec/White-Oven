import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { Button, Body, FormPage, Heading } from "../components/Form.tsx";
import { customerMessage } from "../customer/client.ts";
import { createOrderDetailLoader } from "../customer/order-detail-loader.ts";
import {
  type CustomerOrderDetail,
  type CustomerOrderSummary,
  reorderLines,
  statusLabel,
} from "../customer/orders.ts";
import { randomUUID } from "../customer/native.ts";
import type { PublicMenu } from "../menu/menu.ts";
import { formatCents } from "../menu/menu.ts";

const paymentLabel = {
  CASH: "Dinheiro",
  CARD_ON_DELIVERY: "Cartão na entrega ou retirada",
  PIX_ON_DELIVERY: "Pix presencial",
} as const;

export function OrdersScreen({
  model,
  state,
  menu,
  menuStale,
  storeUnavailable,
  orderId,
  backLabel,
  onBack,
  onAccount,
  onOpenOrder,
  onOpenCart,
}: {
  model: CommerceModel;
  state: CommerceState;
  menu: PublicMenu | null;
  menuStale: boolean;
  storeUnavailable: boolean;
  orderId: string | null;
  backLabel: string;
  onBack: () => void;
  onAccount: () => void;
  onOpenOrder: (orderId: string) => void;
  onOpenCart: () => void;
}) {
  const theme = useTheme();
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [appActive, setAppActive] = useState(
    AppState.currentState === "active",
  );
  const [canceling, setCanceling] = useState(false);
  const selectedOrderId = useRef(orderId);
  selectedOrderId.current = orderId;
  const modelRef = useRef(model);
  modelRef.current = model;
  const refreshOnForeground = useRef<string | null>(null);
  const detailLoader = useRef<ReturnType<
    typeof createOrderDetailLoader<CustomerOrderDetail>
  > | null>(null);
  if (!detailLoader.current) {
    detailLoader.current = createOrderDetailLoader({
      load: (id, signal) => modelRef.current.getCustomerOrder(id, signal),
      onStart: (id) => {
        if (selectedOrderId.current !== id) return;
        setDetailLoading(true);
        setDetailError(null);
      },
      onSuccess: (id, value) => {
        if (selectedOrderId.current === id) setDetail(value);
      },
      onError: (id, cause) => {
        if (
          selectedOrderId.current === id &&
          !(cause instanceof Error && cause.name === "AbortError")
        )
          setDetailError(customerMessage(cause));
      },
      onSettled: (id) => {
        if (selectedOrderId.current !== id) return;
        setDetailLoading(false);
        if (refreshOnForeground.current === id) {
          refreshOnForeground.current = null;
          void loadDetailRef.current?.();
        }
      },
    });
  }
  const loadDetailRef = useRef<(() => Promise<void> | undefined) | null>(null);

  const loadPage = useCallback(
    async (next: number | null, replace: boolean) => {
      if (!state.profile) return;
      setLoading(true);
      setError(null);
      try {
        const page = await model.listCustomerOrders(next);
        setOrders((current) => {
          if (replace) return page.orders;
          const seen = new Set(current.map((order) => order.id));
          return [
            ...current,
            ...page.orders.filter((order) => !seen.has(order.id)),
          ];
        });
        setCursor(page.nextCursor);
      } catch (cause) {
        setError(customerMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [model, state.profile],
  );

  const loadDetail = useCallback(() => {
    if (!orderId || !state.profile) return;
    return detailLoader.current?.load(orderId);
  }, [orderId, state.profile]);
  loadDetailRef.current = loadDetail;

  useEffect(() => {
    if (orderId) {
      setDetail(null);
      void loadDetail();
    } else {
      setOrders([]);
      setCursor(null);
      void loadPage(null, true);
    }
  }, [orderId, loadDetail, loadPage]);

  useEffect(
    () => () => {
      if (orderId) detailLoader.current?.cancel(orderId);
      refreshOnForeground.current = null;
    },
    [orderId],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const active = next === "active";
      setAppActive(active);
      if (active && orderId) {
        if (detailLoader.current?.isLoading(orderId))
          refreshOnForeground.current = orderId;
        else void loadDetail();
      }
    });
    return () => subscription.remove();
  }, [loadDetail, orderId]);

  useEffect(() => {
    if (
      !orderId ||
      !appActive ||
      !state.profile ||
      !detail ||
      terminal(detail.status)
    )
      return;
    const timer = setInterval(() => void loadDetail(), 20_000);
    return () => clearInterval(timer);
  }, [appActive, detail?.status, loadDetail, orderId, state.profile]);

  const cancelOrder = () => {
    if (!detail || detail.status !== "PLACED") return;
    Alert.alert(
      "Cancelar pedido?",
      `Pedido #${detail.number}. A pizzaria ainda não confirmou o preparo.`,
      [
        { text: "Manter pedido", style: "cancel" },
        {
          text: "Cancelar pedido",
          style: "destructive",
          onPress: async () => {
            setCanceling(true);
            setDetailError(null);
            try {
              await model.cancelCustomerOrder(detail.id, randomUUID());
              await loadDetail();
            } catch (cause) {
              await loadDetail();
              setDetailError(customerMessage(cause));
            } finally {
              setCanceling(false);
            }
          },
        },
      ],
    );
  };

  const reorder = () => {
    if (!detail || !menu || menuStale || storeUnavailable || !state.profile)
      return;
    try {
      const result = reorderLines(detail, menu, randomUUID);
      if (!result.lines.length) {
        Alert.alert(
          "Itens indisponíveis",
          "Nenhum item deste pedido pode ser recriado com o cardápio atual.",
        );
        return;
      }
      const replace = async () => {
        const saved = await model.replaceCart(result.lines);
        if (saved) onOpenCart();
      };
      const title = result.skipped
        ? "Alguns itens mudaram"
        : state.cart.length
          ? "Trocar o carrinho atual?"
          : "Montar este pedido novamente?";
      const message = result.skipped
        ? `${result.skipped} item(ns) indisponível(is) ou alterado(s) serão ignorados. O carrinho atual será substituído pelos itens válidos.`
        : state.cart.length
          ? "Os itens atuais serão substituídos pelos deste pedido, com preços calculados de novo no cardápio atual."
          : "Os itens serão revalidados no cardápio atual. Preços e disponibilidade podem ter mudado.";
      Alert.alert(title, message, [
        { text: "Voltar", style: "cancel" },
        { text: "Montar carrinho", onPress: () => void replace() },
      ]);
    } catch (cause) {
      setDetailError(customerMessage(cause));
    }
  };

  if (!state.profile)
    return (
      <FormPage>
        <Button label={orderId ? backLabel : "Voltar"} onPress={onBack} />
        <Heading>Meus pedidos</Heading>
        <Body>Entre na conta desta pizzaria para ver seus pedidos.</Body>
        <Button label="Entrar ou criar conta" onPress={onAccount} />
      </FormPage>
    );

  if (orderId)
    return (
      <FormPage>
        <Button label={backLabel} onPress={onBack} />
        <Heading>
          {detail ? `Pedido #${detail.number}` : "Acompanhamento"}
        </Heading>
        <Button label="Minha conta" onPress={onAccount} />
        {state.error ? <Body alert>{state.error}</Body> : null}
        {detailError ? <Body alert>{detailError}</Body> : null}
        {detailLoading && !detail ? <Body>Carregando pedido…</Body> : null}
        {!detail && !detailLoading ? (
          <Button label="Tentar novamente" onPress={() => void loadDetail()} />
        ) : null}
        {detail ? (
          <>
            <View
              accessibilityLiveRegion="polite"
              style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radius.card,
                borderWidth: 1,
                gap: 8,
                padding: theme.spacing(4),
              }}
            >
              <Heading>
                {statusLabel(detail.status, detail.fulfillment)}
              </Heading>
              <Body>
                {detail.fulfillment === "DELIVERY" ? "Entrega" : "Retirada"} ·
                Pedido em {dateTime(detail.placedAt)}
              </Body>
              {detail.estimate && !terminal(detail.status) ? (
                <Body>
                  Previsão aproximada da loja: {estimateAt(detail)}. Não é
                  rastreamento em tempo real.
                </Body>
              ) : null}
              {detail.status !== "PLACED" && !terminal(detail.status) ? (
                <Body>
                  Para solicitar uma alteração ou cancelamento, fale com a
                  pizzaria
                  {detail.contactPhone
                    ? ` pelo telefone ${detail.contactPhone}`
                    : " diretamente"}
                  .
                </Body>
              ) : null}
              <Body>
                Atualização automática a cada 20 segundos enquanto esta tela
                estiver aberta.
              </Body>
            </View>
            <Button
              label={detailLoading ? "Atualizando…" : "Atualizar agora"}
              disabled={detailLoading}
              onPress={() => void loadDetail()}
            />
            <Heading>Linha do tempo</Heading>
            {detail.history.map((change, index) => (
              <View
                key={`${change.at}-${index}`}
                style={{ gap: 4, paddingLeft: 8 }}
              >
                <Body>{statusLabel(change.to, detail.fulfillment)}</Body>
                <Body>{dateTime(change.at)}</Body>
                {change.reasonCode ? (
                  <Body>{reasonLabel(change.reasonCode)}</Body>
                ) : null}
              </View>
            ))}
            <Heading>Itens</Heading>
            {detail.items.map((item, index) => (
              <View key={`${item.kind}-${index}`} style={{ gap: 4 }}>
                <Body>
                  {itemName(item)} · {item.quantity} un.
                </Body>
                <Body>{formatCents(item.totalCents)}</Body>
              </View>
            ))}
            <Heading>Resumo</Heading>
            <Body>Itens: {formatCents(detail.itemsSubtotalCents)}</Body>
            <Body>Taxa de entrega: {formatCents(detail.deliveryFeeCents)}</Body>
            <Body>Desconto: {formatCents(detail.discountCents)}</Body>
            <Body>Total: {formatCents(detail.totalCents)}</Body>
            <Body>Pagamento: {paymentLabel[detail.paymentMethod]}</Body>
            {detail.changeForCents !== null ? (
              <Body>Troco para: {formatCents(detail.changeForCents)}</Body>
            ) : null}
            {detail.notes ? <Body>Observações: {detail.notes}</Body> : null}
            {detail.status === "PLACED" ? (
              <Button
                label={canceling ? "Cancelando…" : "Cancelar pedido"}
                disabled={canceling}
                onPress={cancelOrder}
              />
            ) : null}
            <Button
              label="Pedir novamente"
              disabled={
                !menu ||
                menuStale ||
                storeUnavailable ||
                state.busy ||
                !!state.pending
              }
              onPress={reorder}
            />
            {storeUnavailable ? (
              <Body>
                A loja está indisponível; tente pedir novamente quando ela
                voltar a atender.
              </Body>
            ) : null}
            {menuStale ? (
              <Body alert>
                Atualize o cardápio antes de pedir novamente; disponibilidade e
                preços podem ter mudado.
              </Body>
            ) : null}
            {state.pending ? (
              <Body alert>
                Recupere a confirmação pendente antes de montar outro pedido.
              </Body>
            ) : null}
          </>
        ) : null}
      </FormPage>
    );

  return (
    <FormPage>
      <Button label="Voltar" onPress={onBack} />
      <Heading>Meus pedidos</Heading>
      <Button label="Minha conta" onPress={onAccount} />
      {state.error ? <Body alert>{state.error}</Body> : null}
      {error ? <Body alert>{error}</Body> : null}
      {loading && orders.length === 0 ? <Body>Carregando pedidos…</Body> : null}
      {!loading && !error && orders.length === 0 ? (
        <Body>Você ainda não fez pedidos nesta pizzaria.</Body>
      ) : null}
      {orders.map((order) => (
        <View
          key={order.id}
          style={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.card,
            borderWidth: 1,
            gap: 8,
            padding: theme.spacing(4),
          }}
        >
          <Heading>Pedido #{order.number}</Heading>
          <Body>{statusLabel(order.status, order.fulfillment)}</Body>
          <Body>{dateTime(order.placedAt)}</Body>
          <Body>
            {order.fulfillment === "DELIVERY" ? "Entrega" : "Retirada"} ·{" "}
            {formatCents(order.totalCents)}
          </Body>
          <Button label="Ver pedido" onPress={() => onOpenOrder(order.id)} />
        </View>
      ))}
      <Button
        label={loading ? "Carregando…" : "Atualizar lista"}
        disabled={loading}
        onPress={() => void loadPage(null, true)}
      />
      {cursor !== null ? (
        <Button
          label={loading ? "Carregando…" : "Carregar mais"}
          disabled={loading}
          onPress={() => void loadPage(cursor, false)}
        />
      ) : null}
    </FormPage>
  );
}

function dateTime(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString("pt-BR")} às ${date.toLocaleTimeString(
    "pt-BR",
    {
      hour: "2-digit",
      minute: "2-digit",
    },
  )}`;
}

function estimateAt(order: CustomerOrderDetail) {
  const minutes =
    order.estimate!.prepMinutes +
    (order.fulfillment === "DELIVERY" ? order.estimate!.deliveryMinutes : 0);
  return new Date(
    Date.parse(order.placedAt) + minutes * 60_000,
  ).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function terminal(status: CustomerOrderDetail["status"]) {
  return (
    status === "COMPLETED" || status === "REJECTED" || status === "CANCELED"
  );
}

function itemName(item: CustomerOrderDetail["items"][number]) {
  const snapshot = item.snapshot;
  if (item.kind === "PRODUCT") {
    const product = snapshot["product"] as { name?: unknown } | undefined;
    return typeof product?.name === "string" ? product.name : "Produto";
  }
  const flavors = snapshot["flavors"] as
    Record<string, { name?: unknown }> | undefined;
  const names = flavors
    ? Object.values(flavors)
        .map((flavor) => flavor.name)
        .filter((name): name is string => typeof name === "string")
    : [];
  return names.length ? `Pizza ${names.join(" / ")}` : "Pizza";
}

function reasonLabel(reason: string) {
  const labels: Record<string, string> = {
    CUSTOMER_REQUEST: "Solicitação do cliente",
    ITEM_UNAVAILABLE: "Item indisponível",
    STORE_TOO_BUSY: "Pizzaria sem capacidade no momento",
    OUT_OF_DELIVERY_AREA: "Endereço fora da área atendida",
    CUSTOMER_UNREACHABLE: "Não foi possível falar com o cliente",
    NOT_PICKED_UP: "Pedido não retirado",
    SUSPECTED_FRAUD: "Pedido não confirmado pela pizzaria",
    ACCEPT_TIMEOUT: "A pizzaria não confirmou dentro do prazo",
    STORE_SUSPENDED: "A loja está temporariamente indisponível",
    OTHER: "Atualização da pizzaria",
  };
  return labels[reason] ?? "Atualização do pedido";
}
