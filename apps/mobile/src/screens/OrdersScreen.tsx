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
  Image,
  Linking,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { announce } from "../a11y/useAnnouncement.ts";
import { useTheme } from "../brand/theme.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button } from "../components/Form.tsx";
import { Icon, IconButton, type IconName } from "../components/Icon.tsx";
import { PAGE_GUTTER } from "../components/layout.ts";
import { AppBar, CartButton, FilterChips } from "../components/AppBar.tsx";
import {
  ORDER_FILTERS,
  type OrderFilter,
  emptyFilterMessage,
  filterOrders,
  orderDateTime,
  orderItemView,
  orderWhen,
} from "../customer/order-view.ts";
import { ListRow, Section } from "../components/ListRow.tsx";
import { Screen } from "../components/Screen.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { TotalRow } from "../components/TotalRow.tsx";
import {
  type ProgressStep,
  orderProgress,
  progressSummary,
  statusTone,
  stepDescription,
  trackingLabel,
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
  storeName,
  logoUrl,
  cartCount,
  imageUrl,
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
  storeName: string;
  logoUrl: string | null;
  /** Units in the bag, on the badge of the bag button. */
  cartCount: number;
  /** The public picture route of the menu's images (ADR 0021). */
  imageUrl: (imageId: string) => string;
}) {
  const theme = useTheme();
  const [filter, setFilter] = useState<OrderFilter>("all");
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

  const tracking = !!orderId && !!detail && !terminal(detail.status);
  const header = tracking ? (
    <TrackingHeader onBack={onBack} backTo={backTo} />
  ) : orderId ? (
    <DetailHeader
      title={detail ? `Pedido #${detail.number}` : "Pedido"}
      onBack={onBack}
      backTo={backTo}
    />
  ) : (
    <AppBar
      storeName={storeName}
      logoUrl={logoUrl}
      right={<CartButton count={cartCount} onPress={onOpenCart} />}
    />
  );

  if (!state.profile)
    return (
      <Screen header={header}>
        {orderId ? null : <PageTitle />}
        <EmptyState
          icon="receipt-outline"
          title="Seus pedidos aparecem aqui"
          body="Entre na sua conta desta pizzaria para acompanhar pedidos e pedir de novo."
          action={
            <Button
              label="Entrar ou criar conta"
              variant="primary"
              onPress={onAccount}
              style={pill}
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
      <Screen refreshControl={refreshControl} header={header}>
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
            {progress && tracking ? (
              <Card>
                <View style={{ gap: 2 }}>
                  <Text
                    accessibilityRole="header"
                    style={{ color: theme.colors.text, ...theme.typography.h3 }}
                  >
                    Pedido #{detail.number}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.textSecondary,
                      ...theme.typography.bodySmall,
                    }}
                  >
                    {detail.fulfillment === "DELIVERY" ? "Entrega" : "Retirada"}{" "}
                    · realizado {orderWhen(detail.placedAt)}
                  </Text>
                </View>
                {detail.estimate ? (
                  <View
                    style={{
                      flexDirection: "row",
                      gap: theme.spacing(2),
                      alignItems: "center",
                      padding: theme.spacing(3),
                      borderRadius: theme.radius.medium,
                      backgroundColor: theme.colors.orangeSoft,
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
                <ProgressSteps
                  steps={progress}
                  fulfillment={detail.fulfillment}
                  summary={progressSummary(detail.status, detail.fulfillment)}
                />
                <TrackingArt fulfillment={detail.fulfillment} />
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    ...theme.typography.bodySmall,
                  }}
                >
                  A previsão é aproximada, não é rastreamento em tempo real.
                  Esta tela se atualiza sozinha a cada 20 segundos.
                </Text>
              </Card>
            ) : (
              <StatusHero order={detail} />
            )}

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

            <View style={{ gap: theme.spacing(3) }}>
              <SectionTitle>Itens do pedido</SectionTitle>
              <Card gap={0} padding={0}>
                {detail.items.map((item, index) => {
                  const view = orderItemView(item, menu);
                  return (
                    <View
                      key={`${item.kind}-${index}`}
                      accessible
                      accessibilityLabel={`${item.quantity} ${view.title}${view.lines.length ? `, ${view.lines.join(", ")}` : ""}, ${formatCents(item.totalCents)}`}
                      style={{
                        flexDirection: "row",
                        gap: theme.spacing(3),
                        padding: theme.spacing(4),
                        borderTopWidth: index ? 1 : 0,
                        borderTopColor: theme.colors.border,
                      }}
                    >
                      <ItemThumb
                        kind={item.kind}
                        imageUrls={view.imageIds.map(imageUrl)}
                      />
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text
                          style={{
                            color: theme.colors.text,
                            ...theme.typography.body,
                            fontWeight: "700",
                          }}
                        >
                          {view.title}
                        </Text>
                        {view.lines.map((line, lineIndex) => (
                          <Text
                            key={lineIndex}
                            style={{
                              color: theme.colors.textSecondary,
                              ...theme.typography.bodySmall,
                            }}
                          >
                            {line}
                          </Text>
                        ))}
                      </View>
                      <View style={{ alignItems: "flex-end", gap: 4 }}>
                        <Text
                          style={{
                            color: theme.colors.text,
                            ...theme.typography.bodySmall,
                            fontWeight: "600",
                          }}
                        >
                          {item.quantity}x
                        </Text>
                        <Text
                          style={{
                            color: theme.colors.text,
                            ...theme.typography.body,
                            fontWeight: "700",
                          }}
                        >
                          {formatCents(item.totalCents)}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </Card>
            </View>

            <Card>
              <TotalRow
                label="Subtotal"
                value={formatCents(detail.itemsSubtotalCents)}
              />
              {detail.fulfillment === "DELIVERY" || detail.deliveryFeeCents ? (
                <TotalRow
                  label="Taxa de entrega"
                  value={formatCents(detail.deliveryFeeCents)}
                />
              ) : null}
              {detail.discountCents ? (
                <TotalRow
                  label="Desconto"
                  value={`− ${formatCents(detail.discountCents)}`}
                />
              ) : null}
              <View
                style={{ height: 1, backgroundColor: theme.colors.border }}
              />
              <View
                accessible
                accessibilityLabel={`Total ${formatCents(detail.totalCents)}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text
                  style={{ color: theme.colors.text, ...theme.typography.h3 }}
                >
                  Total
                </Text>
                <Text
                  style={{
                    color: theme.colors.accentText,
                    ...theme.typography.h3,
                    fontWeight: "800",
                  }}
                >
                  {formatCents(detail.totalCents)}
                </Text>
              </View>
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
              {detail.notes ? (
                <Body small muted>
                  Observações: {detail.notes}
                </Body>
              ) : null}
            </Card>

            {tracking ? null : (
              <View
                style={{
                  backgroundColor: theme.colors.orangeSoft,
                  borderRadius: theme.radius.xl,
                  padding: theme.spacing(4),
                  gap: theme.spacing(4),
                }}
              >
                <View style={{ flexDirection: "row", gap: theme.spacing(3) }}>
                  <Icon
                    name="refresh"
                    size={30}
                    color={theme.colors.accentText}
                  />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text
                      accessibilityRole="header"
                      style={{
                        color: theme.colors.text,
                        ...theme.typography.h3,
                      }}
                    >
                      Pedir novamente
                    </Text>
                    <Body small muted>
                      Coloca os itens deste pedido na sacola, com os preços de
                      agora do cardápio.
                    </Body>
                  </View>
                </View>
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
                  label="Pedir novamente"
                  icon="bag-handle-outline"
                  variant="primary"
                  disabled={reorderBlocked}
                  onPress={reorder}
                  style={pill}
                />
              </View>
            )}

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
                style={pill}
              />
            ) : null}

            {detail.history.length ? (
              <Section title="Histórico do pedido">
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
                        {orderDateTime(change.at)}
                        {change.reasonCode
                          ? ` · ${reasonLabel(change.reasonCode)}`
                          : ""}
                      </Text>
                    </View>
                  ))}
                </View>
              </Section>
            ) : null}
          </>
        ) : null}
      </Screen>
    );
  }

  const visible = filterOrders(orders, filter);
  return (
    <Screen refreshControl={refreshControl} header={header}>
      <PageTitle />
      <FilterChips
        options={ORDER_FILTERS}
        value={filter}
        onChange={setFilter}
      />
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
              style={pill}
            />
          }
        />
      ) : null}
      {orders.length > 0 && visible.length === 0 ? (
        <Body muted centered>
          {emptyFilterMessage(filter)}
        </Body>
      ) : null}
      <View style={{ gap: theme.spacing(3) }}>
        {visible.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            onPress={() => onOpenOrder(order.id)}
          />
        ))}
      </View>
      {cursor !== null ? (
        <Button
          label="Carregar mais pedidos"
          loading={loading}
          disabled={loading}
          onPress={() => void loadPage(cursor, false)}
          style={pill}
        />
      ) : null}
      {orders.some((order) => order.status === "COMPLETED") ? (
        <ReorderTip />
      ) : null}
    </Screen>
  );
}

const pill = { borderRadius: 999 };

function PageTitle() {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(1) }}>
      <Text
        accessibilityRole="header"
        style={{
          color: theme.colors.text,
          fontSize: theme.typography.h1.fontSize,
          lineHeight: theme.typography.h1.lineHeight,
          fontWeight: "800",
        }}
      >
        Meus Pedidos
      </Text>
      <Body muted>
        Acompanhe seu histórico e peça novamente seus favoritos.
      </Body>
    </View>
  );
}

function Card({
  children,
  gap,
  padding,
}: {
  children: ReactNode;
  gap?: number;
  padding?: number;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.xl,
          gap: gap ?? theme.spacing(3),
          padding: padding ?? theme.spacing(4),
          overflow: "hidden",
        },
        theme.shadow,
      ]}
    >
      {children}
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: theme.colors.text, ...theme.typography.h3 }}
    >
      {children}
    </Text>
  );
}

/**
 * A pizza's picture: one photo, or two halves side by side when each half has one. Without a
 * photo, a tile with an icon. Decorative: the row's label says what the item is.
 */
function ItemThumb({
  kind,
  imageUrls,
  size = 64,
}: {
  kind: "PIZZA" | "PRODUCT";
  imageUrls: string[];
  size?: number;
}) {
  const theme = useTheme();
  const round = kind === "PIZZA";
  const frame = {
    width: size,
    height: size,
    borderRadius: round ? size / 2 : theme.radius.medium,
    overflow: "hidden" as const,
    backgroundColor: theme.colors.orangeSoft,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  if (!imageUrls.length)
    return (
      <View accessible={false} style={frame}>
        <Icon
          name={kind === "PIZZA" ? "pizza-outline" : "restaurant-outline"}
          size={size * 0.45}
          color={theme.colors.accentText}
        />
      </View>
    );
  return (
    <View
      accessible={false}
      style={[frame, { flexDirection: "row", justifyContent: "flex-start" }]}
    >
      {imageUrls.slice(0, 2).map((uri, index, list) => (
        <View
          key={index}
          style={{
            width: size / list.length,
            height: size,
            overflow: "hidden",
          }}
        >
          <Image
            source={{ uri }}
            accessible={false}
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            style={{
              width: size,
              height: size,
              marginLeft: index ? -size / 2 : 0,
            }}
          />
        </View>
      ))}
    </View>
  );
}

const statusIcons = {
  progress: "time-outline",
  success: "checkmark",
  error: "close",
} as const;

/** The order's status on top of its detail, in the tone of the status, never in color alone. */
function StatusHero({ order }: { order: CustomerOrderDetail }) {
  const theme = useTheme();
  const tone = statusTone(order.status);
  const tint = {
    progress: {
      surface: theme.colors.orangeSoft,
      strong: theme.colors.primary,
      onStrong: theme.colors.onPrimary,
      title: theme.colors.accentText,
    },
    success: {
      surface: theme.colors.successSurface,
      strong: theme.colors.success,
      onStrong: "#FFFFFF",
      title: theme.colors.success,
    },
    error: {
      surface: theme.colors.errorSurface,
      strong: theme.colors.errorText,
      onStrong: "#FFFFFF",
      title: theme.colors.errorText,
    },
  }[tone];
  const kind = order.fulfillment === "DELIVERY" ? "Entrega" : "Retirada";
  return (
    <View
      accessible
      accessibilityLabel={`${statusLabel(order.status, order.fulfillment)}. ${kind}, pedido feito em ${orderDateTime(order.placedAt)}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing(3),
        padding: theme.spacing(4),
        borderRadius: theme.radius.xl,
        backgroundColor: tint.surface,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: tint.strong,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={statusIcons[tone]} size={26} color={tint.onStrong} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: tint.title,
            ...theme.typography.h3,
            fontWeight: "800",
          }}
        >
          {statusLabel(order.status, order.fulfillment)}
        </Text>
        <Text
          style={{
            color: theme.colors.textSecondary,
            ...theme.typography.bodySmall,
          }}
        >
          {kind} · {orderDateTime(order.placedAt)}
        </Text>
      </View>
      <Icon name="bag-handle-outline" size={40} color={tint.title} />
    </View>
  );
}

/** "Peça de novo com um toque!": where reordering lives, under the list. */
function ReorderTip() {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        gap: theme.spacing(3),
        alignItems: "flex-start",
        padding: theme.spacing(4),
        borderRadius: theme.radius.xl,
        backgroundColor: theme.colors.orangeSoft,
      }}
    >
      <Icon name="heart-outline" size={28} color={theme.colors.accentText} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: theme.colors.text,
            ...theme.typography.title,
            fontWeight: "700",
          }}
        >
          Peça de novo com um toque!
        </Text>
        <Body small muted>
          Abra um pedido concluído e toque em "Pedir novamente" para montar a
          sacola com os mesmos itens.
        </Body>
      </View>
    </View>
  );
}

/** The bar of an order's detail: a raised back button and the order number. */
function DetailHeader({
  title,
  onBack,
  backTo,
}: {
  title: string;
  onBack: () => void;
  backTo: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing(1),
        paddingBottom: theme.spacing(2),
        paddingLeft: PAGE_GUTTER + insets.left,
        paddingRight: PAGE_GUTTER + insets.right,
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: theme.colors.background,
      }}
    >
      <IconButton
        name="arrow-back"
        tone="filled"
        size={24}
        accessibilityLabel={`Voltar para ${backTo}`}
        onPress={onBack}
        style={{ borderRadius: theme.radius.medium, width: 48, height: 48 }}
      />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        maxFontSizeMultiplier={1.4}
        style={{
          flex: 1,
          textAlign: "center",
          color: theme.colors.text,
          ...theme.typography.h3,
          fontWeight: "800",
        }}
      >
        {title}
      </Text>
      <View style={{ width: 48 }} />
    </View>
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
      accessibilityLabel={`Pedido ${order.number}, ${statusLabel(order.status, order.fulfillment)}, ${kind}, ${orderDateTime(order.placedAt)}, ${formatCents(order.totalCents)}`}
      accessibilityHint="Abre os detalhes do pedido"
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.xl,
          gap: theme.spacing(3),
          padding: theme.spacing(3),
          opacity: pressed ? 0.85 : 1,
        },
        theme.shadow,
      ]}
    >
      <ItemThumb kind="PIZZA" imageUrls={[]} size={64} />
      <View style={{ flex: 1, gap: theme.spacing(1) }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
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
        <Text
          style={{
            color: theme.colors.textSecondary,
            ...theme.typography.bodySmall,
          }}
        >
          {orderDateTime(order.placedAt)}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: theme.spacing(2),
          }}
        >
          <StatusBadge status={order.status} fulfillment={order.fulfillment} />
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
      </View>
    </Pressable>
  );
}

/**
 * The order's steps, top to bottom: done ones carry a check, the current one a ring and a line
 * saying what happens now, the next ones are gray. Each one also says its state in words.
 */
function ProgressSteps({
  steps,
  fulfillment,
  summary,
}: {
  steps: ProgressStep[];
  fulfillment: CustomerOrderDetail["fulfillment"];
  summary: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={summary}
      style={{ paddingTop: theme.spacing(1) }}
    >
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const done = step.state === "done";
        const current = step.state === "current";
        const description = current
          ? stepDescription(step.status, fulfillment)
          : null;
        return (
          <View
            key={step.status}
            style={{ flexDirection: "row", gap: theme.spacing(3) }}
          >
            <View style={{ alignItems: "center", width: 28 }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: done
                    ? theme.colors.primary
                    : theme.colors.surface,
                  borderWidth: done ? 0 : current ? 3 : 2,
                  borderColor: current
                    ? theme.colors.primary
                    : theme.colors.inputBorder,
                }}
              >
                {done ? (
                  <Icon
                    name="checkmark"
                    size={18}
                    color={theme.colors.onPrimary}
                  />
                ) : current ? (
                  <View
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      backgroundColor: theme.colors.primary,
                    }}
                  />
                ) : null}
              </View>
              {!last ? (
                <View
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 20,
                    backgroundColor: done
                      ? theme.colors.primary
                      : theme.colors.border,
                  }}
                />
              ) : null}
            </View>
            <View
              style={{
                flex: 1,
                paddingTop: 3,
                paddingBottom: last ? 0 : theme.spacing(4),
                gap: 2,
              }}
            >
              <Text
                style={{
                  color:
                    step.state === "upcoming"
                      ? theme.colors.textSecondary
                      : theme.colors.text,
                  ...theme.typography.body,
                  fontWeight: done || current ? "700" : "400",
                }}
              >
                {trackingLabel(step)}
              </Text>
              {description ? (
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    ...theme.typography.bodySmall,
                  }}
                >
                  {description}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The orange bar of the tracking screen. */
function TrackingHeader({
  onBack,
  backTo,
}: {
  onBack: () => void;
  backTo: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing(2),
        paddingBottom: theme.spacing(4),
        paddingLeft: theme.spacing(2) + insets.left,
        paddingRight: PAGE_GUTTER + insets.right,
        backgroundColor: theme.colors.primary,
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing(1),
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Voltar para ${backTo}`}
        onPress={onBack}
        hitSlop={4}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name="arrow-back" size={26} color={theme.colors.onPrimary} />
      </Pressable>
      <Text
        accessibilityRole="header"
        style={{
          flex: 1,
          color: theme.colors.onPrimary,
          ...theme.typography.h3,
          fontWeight: "800",
        }}
      >
        Acompanhar pedido
      </Text>
    </View>
  );
}

/** A soft hill with a delivery bike or the store, under the steps. Decorative. */
function TrackingArt({
  fulfillment,
}: {
  fulfillment: CustomerOrderDetail["fulfillment"];
}) {
  const theme = useTheme();
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 120,
        borderRadius: theme.radius.large,
        overflow: "hidden",
        backgroundColor: theme.colors.surfaceSecondary,
        alignItems: "center",
        justifyContent: "flex-end",
      }}
    >
      <View
        style={{
          position: "absolute",
          bottom: -140,
          width: 420,
          height: 200,
          borderRadius: 210,
          backgroundColor: theme.colors.primaryLight,
        }}
      />
      <View style={{ marginBottom: theme.spacing(3) }}>
        <Icon
          name={fulfillment === "DELIVERY" ? "bicycle" : "storefront-outline"}
          size={72}
          color={theme.colors.primary}
        />
      </View>
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
