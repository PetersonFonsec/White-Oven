import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { announce } from "../a11y/useAnnouncement.ts";
import { useTheme } from "../brand/theme.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button } from "../components/Form.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { ListRow, Section } from "../components/ListRow.tsx";
import { Screen, ScreenHeader } from "../components/Screen.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TotalRow } from "../components/TotalRow.tsx";
import {
  type ProgressStep,
  orderProgress,
  progressSummary,
} from "../customer/order-progress.ts";
import { customerMessage } from "../customer/client.ts";
import {
  createCustomerOrderListLoader,
  createOrderDetailLoader,
  createOrderSessionFence,
} from "../customer/order-detail-loader.ts";
import {
  type CustomerOrderPage,
  type CustomerOrderDetail,
  type CustomerOrderSummary,
  orderDetailMessage,
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
  backTo,
  onBack,
  onAccount,
  onOpenOrder,
  onOpenCart,
  onOpenMenu,
}: {
  model: CommerceModel;
  state: CommerceState;
  menu: PublicMenu | null;
  menuStale: boolean;
  storeUnavailable: boolean;
  orderId: string | null;
  /** The screen an open order returns to ("Pedidos", "Sacola"), named on its back button. */
  backTo: string;
  onBack: () => void;
  onAccount: () => void;
  onOpenOrder: (orderId: string) => void;
  onOpenCart: () => void;
  onOpenMenu: () => void;
}) {
  const theme = useTheme();
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [appActive, setAppActive] = useState(
    AppState.currentState === "active",
  );
  const [canceling, setCanceling] = useState(false);
  const selectedOrderId = useRef(orderId);
  selectedOrderId.current = orderId;
  const modelRef = useRef(model);
  modelRef.current = model;
  const refreshOnForeground = useRef<string | null>(null);
  // CommerceModel is scoped to the API URL and store slug, per ADR 0022.
  const profileId = state.profile?.id ?? null;
  const sessionFence = useRef<ReturnType<
    typeof createOrderSessionFence<CommerceModel>
  > | null>(null);
  if (!sessionFence.current)
    sessionFence.current = createOrderSessionFence<CommerceModel>();
  const listLoader = useRef<ReturnType<
    typeof createCustomerOrderListLoader<CustomerOrderPage>
  > | null>(null);
  if (!listLoader.current) {
    listLoader.current = createCustomerOrderListLoader({
      load: (cursor, signal) =>
        modelRef.current.listCustomerOrders(cursor, signal),
      onStart: (generation) => {
        if (!sessionFence.current!.isCurrent(generation)) return;
        setLoading((current) =>
          sessionFence.current!.isCurrent(generation) ? true : current,
        );
        setError((current) =>
          sessionFence.current!.isCurrent(generation) ? null : current,
        );
      },
      onSuccess: (generation, page, replace) => {
        if (!sessionFence.current!.isCurrent(generation)) return;
        setOrders((current) => {
          if (!sessionFence.current!.isCurrent(generation)) return current;
          if (replace) return page.orders;
          const seen = new Set(current.map((order) => order.id));
          return [
            ...current,
            ...page.orders.filter((order) => !seen.has(order.id)),
          ];
        });
        setCursor((current) =>
          sessionFence.current!.isCurrent(generation)
            ? page.nextCursor
            : current,
        );
      },
      onError: (generation, cause) => {
        if (sessionFence.current!.isCurrent(generation))
          setError((current) =>
            sessionFence.current!.isCurrent(generation)
              ? customerMessage(cause)
              : current,
          );
      },
      onSettled: (generation) => {
        if (sessionFence.current!.isCurrent(generation))
          setLoading((current) =>
            sessionFence.current!.isCurrent(generation) ? false : current,
          );
      },
    });
  }
  const detailLoader = useRef<ReturnType<
    typeof createOrderDetailLoader<CustomerOrderDetail>
  > | null>(null);
  if (!detailLoader.current) {
    detailLoader.current = createOrderDetailLoader({
      load: (id, signal) => modelRef.current.getCustomerOrder(id, signal),
      onStart: (id, generation) => {
        if (
          selectedOrderId.current !== id ||
          !sessionFence.current!.isCurrent(generation)
        )
          return;
        setDetailLoading((current) =>
          sessionFence.current!.isCurrent(generation) ? true : current,
        );
        setDetailError((current) =>
          sessionFence.current!.isCurrent(generation) ? null : current,
        );
      },
      onSuccess: (id, generation, value) => {
        if (
          selectedOrderId.current === id &&
          sessionFence.current!.isCurrent(generation)
        )
          setDetail((current) =>
            sessionFence.current!.isCurrent(generation) ? value : current,
          );
      },
      onError: (id, generation, cause) => {
        if (
          selectedOrderId.current === id &&
          sessionFence.current!.isCurrent(generation) &&
          !(cause instanceof Error && cause.name === "AbortError")
        )
          setDetailError((current) =>
            sessionFence.current!.isCurrent(generation)
              ? orderDetailMessage(cause)
              : current,
          );
      },
      onSettled: (id, generation) => {
        if (
          selectedOrderId.current !== id ||
          !sessionFence.current!.isCurrent(generation)
        )
          return;
        setDetailLoading((current) =>
          sessionFence.current!.isCurrent(generation) ? false : current,
        );
        if (refreshOnForeground.current === id) {
          refreshOnForeground.current = null;
          void loadDetailRef.current?.();
        }
      },
    });
  }
  const loadDetailRef = useRef<(() => Promise<void> | undefined) | null>(null);

  useLayoutEffect(() => {
    sessionFence.current!.activate();
    return () => {
      sessionFence.current!.dispose();
      listLoader.current?.cancel();
      detailLoader.current?.cancel();
    };
  }, []);

  useLayoutEffect(() => {
    const { generation, changed } = sessionFence.current!.update(
      model,
      profileId,
    );
    if (!changed) return;
    listLoader.current?.cancel();
    detailLoader.current?.cancel();
    refreshOnForeground.current = null;
    setOrders([]);
    setCursor(null);
    setDetail(null);
    setLoading(false);
    setError(null);
    setDetailLoading(false);
    setDetailError(null);
    setCanceling(false);
    setSessionGeneration(generation);
  }, [model, profileId]);

  const loadPage = useCallback(
    (next: number | null, replace: boolean) => {
      if (
        !sessionFence.current!.isCurrent(sessionGeneration) ||
        !sessionFence.current!.isIdentity(model, profileId)
      )
        return;
      return listLoader.current!.load(next, replace, sessionGeneration);
    },
    [model, profileId, sessionGeneration],
  );

  const loadDetail = useCallback(() => {
    if (
      !orderId ||
      !sessionFence.current!.isCurrent(sessionGeneration) ||
      !sessionFence.current!.isIdentity(model, profileId)
    )
      return;
    return detailLoader.current?.load(orderId, sessionGeneration);
  }, [model, orderId, profileId, sessionGeneration]);
  loadDetailRef.current = loadDetail;

  useEffect(() => {
    if (orderId) {
      setDetail(null);
      setDetailError(null);
      void loadDetail();
    } else {
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
        const generation = sessionFence.current!.currentGeneration();
        if (detailLoader.current?.isLoading(orderId, generation))
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

  // A status the 20-second refresh brings is spoken: the customer may be looking away.
  const spokenStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!detail) {
      spokenStatus.current = null;
      return;
    }
    const key = `${detail.id}:${detail.status}`;
    if (
      spokenStatus.current &&
      spokenStatus.current.startsWith(`${detail.id}:`) &&
      spokenStatus.current !== key
    )
      announce(
        `Pedido ${detail.number}: ${statusLabel(detail.status, detail.fulfillment)}`,
      );
    spokenStatus.current = key;
  }, [detail]);

  const cancelOrder = () => {
    if (
      !detail ||
      detail.status !== "PLACED" ||
      !sessionFence.current!.isIdentity(model, profileId)
    )
      return;
    const generation = sessionFence.current!.currentGeneration();
    Alert.alert(
      "Cancelar pedido?",
      `Pedido #${detail.number}. A pizzaria ainda não confirmou o preparo.`,
      [
        { text: "Manter pedido", style: "cancel" },
        {
          text: "Cancelar pedido",
          style: "destructive",
          onPress: async () => {
            if (!sessionFence.current!.isCurrent(generation)) return;
            setCanceling((current) =>
              sessionFence.current!.isCurrent(generation) ? true : current,
            );
            setDetailError((current) =>
              sessionFence.current!.isCurrent(generation) ? null : current,
            );
            try {
              await model.cancelCustomerOrder(detail.id, randomUUID());
              if (!sessionFence.current!.isCurrent(generation)) return;
              await loadDetail();
            } catch (cause) {
              if (!sessionFence.current!.isCurrent(generation)) return;
              await loadDetail();
              if (!sessionFence.current!.isCurrent(generation)) return;
              setDetailError((current) =>
                sessionFence.current!.isCurrent(generation)
                  ? customerMessage(cause)
                  : current,
              );
            } finally {
              setCanceling((current) =>
                sessionFence.current!.isCurrent(generation) ? false : current,
              );
            }
          },
        },
      ],
    );
  };

  const reorder = () => {
    if (
      !detail ||
      !menu ||
      menuStale ||
      storeUnavailable ||
      !sessionFence.current!.isIdentity(model, profileId)
    )
      return;
    const generation = sessionFence.current!.currentGeneration();
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
        if (!sessionFence.current!.isCurrent(generation)) return;
        const saved = await model.replaceCart(result.lines);
        if (saved && sessionFence.current!.isCurrent(generation)) onOpenCart();
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
      setDetailError((current) =>
        sessionFence.current!.isCurrent(generation)
          ? customerMessage(cause)
          : current,
      );
    }
  };

  const refresh = () => void (orderId ? loadDetail() : loadPage(null, true));
  const refreshControl = state.profile ? (
    <RefreshControl
      refreshing={
        orderId ? detailLoading && !!detail : loading && orders.length > 0
      }
      onRefresh={refresh}
      tintColor={theme.colors.accentText}
      accessibilityLabel={orderId ? "Atualizar pedido" : "Atualizar pedidos"}
    />
  ) : undefined;

  if (!state.profile)
    return (
      <Screen
        header={
          orderId ? (
            <ScreenHeader title="Pedido" onBack={onBack} backTo={backTo} />
          ) : (
            <ScreenHeader title="Pedidos" large />
          )
        }
      >
        <EmptyState
          icon="receipt-outline"
          title="Seus pedidos aparecem aqui"
          body="Entre na sua conta desta pizzaria para acompanhar pedidos e pedir de novo."
          action={
            <Button
              label="Entrar ou criar conta"
              variant="primary"
              onPress={onAccount}
            />
          }
        />
      </Screen>
    );

  if (orderId) {
    const progress = detail
      ? orderProgress(detail.status, detail.fulfillment)
      : null;
    const reorderBlocked =
      !menu || menuStale || storeUnavailable || state.busy || !!state.pending;
    return (
      <Screen
        refreshControl={refreshControl}
        header={
          <ScreenHeader
            title={detail ? `Pedido #${detail.number}` : "Pedido"}
            onBack={onBack}
            backTo={backTo}
          />
        }
      >
        {state.error ? (
          <InlineMessage tone="error">{state.error}</InlineMessage>
        ) : null}
        {detailError ? (
          <InlineMessage
            tone="error"
            action={
              <Button
                label="Tentar novamente"
                icon="refresh"
                disabled={detailLoading}
                onPress={() => void loadDetail()}
              />
            }
          >
            {detailError}
          </InlineMessage>
        ) : null}
        {detailLoading && !detail ? (
          <Loading label="Carregando pedido…" />
        ) : null}
        {!detail && !detailLoading && !detailError ? (
          <Button
            label="Tentar novamente"
            icon="refresh"
            onPress={() => void loadDetail()}
          />
        ) : null}
        {detail ? (
          <>
            <View
              style={[
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.large,
                  gap: theme.spacing(3),
                  padding: theme.spacing(4),
                },
                theme.shadow,
              ]}
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: theme.colors.text,
                  ...theme.typography.h3,
                }}
              >
                {statusLabel(detail.status, detail.fulfillment)}
              </Text>
              <Body>
                {detail.fulfillment === "DELIVERY" ? "Entrega" : "Retirada"} ·
                feito em {dateTime(detail.placedAt)}
              </Body>
              {detail.estimate && !terminal(detail.status) ? (
                <View
                  style={{
                    flexDirection: "row",
                    gap: theme.spacing(2),
                    alignItems: "center",
                  }}
                >
                  <Icon
                    name="time-outline"
                    size={20}
                    color={theme.colors.accentText}
                  />
                  <Text
                    style={{
                      flex: 1,
                      color: theme.colors.text,
                      ...theme.typography.body,
                      fontWeight: "600",
                    }}
                  >
                    Previsão da pizzaria: {estimateAt(detail)}
                  </Text>
                </View>
              ) : null}
              {progress ? (
                <ProgressSteps
                  steps={progress}
                  summary={progressSummary(detail.status, detail.fulfillment)}
                />
              ) : null}
              {!terminal(detail.status) ? (
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    ...theme.typography.bodySmall,
                  }}
                >
                  A previsão é aproximada, não é rastreamento em tempo real.
                  Esta tela se atualiza sozinha a cada 20 segundos.
                </Text>
              ) : null}
            </View>

            {detail.contactPhone || !terminal(detail.status) ? (
              <Section
                footer={
                  detail.status !== "PLACED" && !terminal(detail.status)
                    ? "O preparo já começou: para alterar ou cancelar, fale com a pizzaria."
                    : undefined
                }
              >
                {detail.contactPhone ? (
                  <ListRow
                    first
                    icon="call-outline"
                    title="Ligar para a pizzaria"
                    subtitle={detail.contactPhone}
                    accessibilityHint="Abre o telefone"
                    onPress={() =>
                      void Linking.openURL(
                        `tel:${detail.contactPhone!.replace(/[^\d+]/g, "")}`,
                      )
                    }
                  />
                ) : (
                  <ListRow
                    first
                    icon="storefront-outline"
                    title="Fale diretamente com a pizzaria"
                    subtitle="A loja não informou um telefone."
                  />
                )}
              </Section>
            ) : null}

            <Section title="Itens">
              <View
                style={{ padding: theme.spacing(4), gap: theme.spacing(3) }}
              >
                {detail.items.map((item, index) => (
                  <View
                    key={`${item.kind}-${index}`}
                    accessible
                    accessibilityLabel={`${item.quantity} ${itemName(item)}, ${formatCents(item.totalCents)}`}
                    style={{ flexDirection: "row", gap: theme.spacing(3) }}
                  >
                    <Text
                      style={{
                        color: theme.colors.accentText,
                        ...theme.typography.body,
                        fontWeight: "700",
                        minWidth: 28,
                      }}
                    >
                      {item.quantity}×
                    </Text>
                    <Text
                      style={{
                        flex: 1,
                        color: theme.colors.text,
                        ...theme.typography.body,
                      }}
                    >
                      {itemName(item)}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.text,
                        ...theme.typography.body,
                        fontWeight: "600",
                      }}
                    >
                      {formatCents(item.totalCents)}
                    </Text>
                  </View>
                ))}
              </View>
            </Section>

            <Section title="Resumo">
              <View
                style={{ padding: theme.spacing(4), gap: theme.spacing(2) }}
              >
                <TotalRow
                  label="Itens"
                  value={formatCents(detail.itemsSubtotalCents)}
                />
                <TotalRow
                  label="Entrega"
                  value={formatCents(detail.deliveryFeeCents)}
                />
                {detail.discountCents ? (
                  <TotalRow
                    label="Desconto"
                    value={`− ${formatCents(detail.discountCents)}`}
                  />
                ) : null}
                <TotalRow
                  strong
                  label="Total"
                  value={formatCents(detail.totalCents)}
                />
                <TotalRow
                  label="Pagamento"
                  value={paymentLabel[detail.paymentMethod]}
                />
                {detail.changeForCents !== null ? (
                  <TotalRow
                    label="Troco para"
                    value={formatCents(detail.changeForCents)}
                  />
                ) : null}
                {detail.notes ? <Body>Observações: {detail.notes}</Body> : null}
              </View>
            </Section>

            {detail.history.length ? (
              <Section title="Histórico">
                <View
                  style={{ padding: theme.spacing(4), gap: theme.spacing(3) }}
                >
                  {detail.history.map((change, index) => (
                    <View
                      key={`${change.at}-${index}`}
                      accessible
                      style={{ gap: 2 }}
                    >
                      <Text
                        style={{
                          color: theme.colors.text,
                          ...theme.typography.body,
                          fontWeight: "600",
                        }}
                      >
                        {statusLabel(change.to, detail.fulfillment)}
                      </Text>
                      <Text
                        style={{
                          color: theme.colors.textSecondary,
                          ...theme.typography.bodySmall,
                        }}
                      >
                        {dateTime(change.at)}
                        {change.reasonCode
                          ? ` · ${reasonLabel(change.reasonCode)}`
                          : ""}
                      </Text>
                    </View>
                  ))}
                </View>
              </Section>
            ) : null}

            {storeUnavailable ? (
              <InlineMessage tone="info">
                A pizzaria está indisponível agora. Peça de novo quando ela
                voltar a atender.
              </InlineMessage>
            ) : menuStale ? (
              <InlineMessage tone="warning">
                Atualize o cardápio antes de pedir de novo: preços e
                disponibilidade podem ter mudado.
              </InlineMessage>
            ) : state.pending ? (
              <InlineMessage tone="warning">
                Recupere o pedido pendente na sacola antes de montar outro.
              </InlineMessage>
            ) : null}
            <Button
              label="Pedir de novo"
              icon="refresh"
              variant="primary"
              disabled={reorderBlocked}
              onPress={reorder}
            />
            {detail.status === "PLACED" ? (
              <Button
                label="Cancelar pedido"
                variant="destructive"
                loading={canceling}
                disabled={canceling}
                accessibilityLabel={
                  canceling ? "Cancelando pedido" : "Cancelar pedido"
                }
                onPress={cancelOrder}
              />
            ) : null}
          </>
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen
      refreshControl={refreshControl}
      header={<ScreenHeader title="Pedidos" large />}
    >
      {state.error ? (
        <InlineMessage tone="error">{state.error}</InlineMessage>
      ) : null}
      {error ? (
        <InlineMessage
          tone="error"
          action={
            <Button
              label="Tentar novamente"
              icon="refresh"
              disabled={loading}
              onPress={() => void loadPage(null, true)}
            />
          }
        >
          {error}
        </InlineMessage>
      ) : null}
      {loading && orders.length === 0 ? (
        <Loading label="Carregando pedidos…" />
      ) : null}
      {!loading && !error && orders.length === 0 ? (
        <EmptyState
          icon="pizza-outline"
          title="Nenhum pedido ainda"
          body="Quando você pedir nesta pizzaria, o pedido aparece aqui para acompanhar."
          action={
            <Button
              label="Ver o cardápio"
              variant="primary"
              onPress={onOpenMenu}
            />
          }
        />
      ) : null}
      {orders.map((order) => (
        <OrderCard
          key={order.id}
          order={order}
          onPress={() => onOpenOrder(order.id)}
        />
      ))}
      {cursor !== null ? (
        <Button
          label="Carregar mais pedidos"
          loading={loading}
          disabled={loading}
          onPress={() => void loadPage(cursor, false)}
        />
      ) : null}
    </Screen>
  );
}

function OrderCard({
  order,
  onPress,
}: {
  order: CustomerOrderSummary;
  onPress: () => void;
}) {
  const theme = useTheme();
  const kind = order.fulfillment === "DELIVERY" ? "Entrega" : "Retirada";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Pedido ${order.number}, ${statusLabel(order.status, order.fulfillment)}, ${kind}, ${dateTime(order.placedAt)}, ${formatCents(order.totalCents)}`}
      accessibilityHint="Abre o acompanhamento do pedido"
      style={({ pressed }) => [
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.large,
          gap: theme.spacing(2),
          padding: theme.spacing(4),
          opacity: pressed ? 0.85 : 1,
        },
        theme.shadow,
      ]}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing(2),
        }}
      >
        <Text
          style={{
            flex: 1,
            color: theme.colors.text,
            ...theme.typography.title,
            fontWeight: "700",
          }}
        >
          Pedido #{order.number}
        </Text>
        <Icon name="chevron-forward" size={20} color={theme.colors.muted} />
      </View>
      <StatusBadge status={order.status} fulfillment={order.fulfillment} />
      <View style={{ flexDirection: "row", gap: theme.spacing(3) }}>
        <Text
          style={{
            flex: 1,
            color: theme.colors.textSecondary,
            ...theme.typography.bodySmall,
          }}
        >
          {kind} · {dateTime(order.placedAt)}
        </Text>
        <Text
          style={{
            color: theme.colors.text,
            ...theme.typography.body,
            fontWeight: "700",
          }}
        >
          {formatCents(order.totalCents)}
        </Text>
      </View>
    </Pressable>
  );
}

/** The order's steps, top to bottom. Each one says in words whether it is done, current or next. */
function ProgressSteps({
  steps,
  summary,
}: {
  steps: ProgressStep[];
  summary: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={summary}
      style={{ gap: 0, paddingTop: theme.spacing(1) }}
    >
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const done = step.state === "done";
        const current = step.state === "current";
        return (
          <View
            key={step.status}
            style={{ flexDirection: "row", gap: theme.spacing(3) }}
          >
            <View style={{ alignItems: "center", width: 24 }}>
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: done
                    ? theme.colors.success
                    : current
                      ? theme.colors.primary
                      : theme.colors.surface,
                  borderWidth: done || current ? 0 : 2,
                  borderColor: theme.colors.inputBorder,
                }}
              >
                {done ? (
                  <Icon name="checkmark" size={16} color="#FFFFFF" />
                ) : current ? (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: theme.colors.onPrimary,
                    }}
                  />
                ) : null}
              </View>
              {!last ? (
                <View
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 16,
                    backgroundColor: done
                      ? theme.colors.success
                      : theme.colors.border,
                  }}
                />
              ) : null}
            </View>
            <View
              style={{ flex: 1, paddingBottom: last ? 0 : theme.spacing(3) }}
            >
              <Text
                style={{
                  color:
                    step.state === "upcoming"
                      ? theme.colors.textSecondary
                      : theme.colors.text,
                  ...theme.typography.body,
                  fontWeight: current ? "700" : "400",
                }}
              >
                {step.label}
              </Text>
              {current ? (
                <Text
                  style={{
                    color: theme.colors.accentText,
                    ...theme.typography.caption,
                    fontWeight: "700",
                  }}
                >
                  AGORA
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Loading({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        alignItems: "center",
        gap: theme.spacing(3),
        paddingVertical: theme.spacing(7),
      }}
    >
      <ActivityIndicator color={theme.colors.accentText} />
      <Body>{label}</Body>
    </View>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        alignItems: "center",
        gap: theme.spacing(3),
        paddingVertical: theme.spacing(7),
        paddingHorizontal: theme.spacing(4),
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: theme.colors.orangeSoft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={34} color={theme.colors.accentText} />
      </View>
      <Text
        accessibilityRole="header"
        style={{
          textAlign: "center",
          color: theme.colors.text,
          ...theme.typography.h3,
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          textAlign: "center",
          color: theme.colors.textSecondary,
          ...theme.typography.body,
        }}
      >
        {body}
      </Text>
      <View style={{ alignSelf: "stretch" }}>{action}</View>
    </View>
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
