import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { announce } from "../a11y/useAnnouncement.ts";
import { useTheme } from "../brand/theme.tsx";
import {
  type CheckoutDetails,
  CART_QUANTITY_LIMIT,
  cartUnits,
  changeQuantity,
  removeLine,
} from "../cart/cart.ts";
import { checkoutAction } from "../cart/checkout-flow.ts";
import {
  type CommerceModel,
  type CommerceState,
  retryAllowed,
} from "../cart/model.ts";
import {
  type CheckoutSettings,
  cartSummary,
  moneyInput,
} from "../cart/summary.ts";
import { Choice } from "../components/Choice.tsx";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button, Field, Heading } from "../components/Form.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import { plural } from "../components/layout.ts";
import { ListRow, Section } from "../components/ListRow.tsx";
import { QuantityStepper } from "../components/QuantityStepper.tsx";
import { Screen, ScreenHeader, StickyFooter } from "../components/Screen.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { TotalRow } from "../components/TotalRow.tsx";
import { type PublicMenu, formatCents } from "../menu/menu.ts";

const payments = {
  CASH: "Dinheiro",
  CARD_ON_DELIVERY: "Cartão na entrega ou retirada",
  PIX_ON_DELIVERY: "Pix presencial",
} as const;

/**
 * What the customer filled in the bag. The app keeps it while the bag is closed (to sign in or to
 * add an address), so coming back does not start the form over (UX audit P1-3).
 */
export interface CheckoutDraft {
  fulfillment: CheckoutDetails["fulfillment"];
  paymentMethod: CheckoutDetails["paymentMethod"];
  addressId: string | null;
  change: string;
  notes: string;
}
export const EMPTY_DRAFT: CheckoutDraft = {
  fulfillment: "PICKUP",
  paymentMethod: "CASH",
  addressId: null,
  change: "",
  notes: "",
};

export function CheckoutScreen({
  model,
  state,
  menu,
  settings,
  canOrder,
  recoveryOnly,
  stale,
  draft,
  onDraft,
  onBack,
  onAccount,
  onAddAddress,
  onTrackOrder,
  onRefresh,
}: {
  model: CommerceModel;
  state: CommerceState;
  menu: PublicMenu | null;
  settings: CheckoutSettings | null;
  canOrder: boolean;
  /** The store is unavailable: only a pending confirmation may be recovered (ADR 0022). */
  recoveryOnly: boolean;
  stale: boolean;
  draft: CheckoutDraft;
  onDraft: (draft: CheckoutDraft) => void;
  /** Back to the menu. */
  onBack: () => void;
  onAccount: () => void;
  onAddAddress: () => void;
  onTrackOrder: (orderId: string) => void;
  onRefresh: () => void;
}) {
  const theme = useTheme();
  const [inputError, setInputError] = useState<string | null>(null);
  const summary = useMemo(
    () => cartSummary(state.cart, menu),
    [state.cart, menu],
  );
  const subtotal = summary.reduce(
    (sum, line) => sum + (line.totalCents ?? 0),
    0,
  );
  const unavailableItems = summary.some((line) => line.totalCents === null);
  const locked = state.busy || !state.ready || !!state.pending;
  const selectedMode = settings?.fulfillmentModes.includes(draft.fulfillment)
    ? draft.fulfillment
    : (settings?.fulfillmentModes[0] ?? draft.fulfillment);
  const selectedPayment = settings?.acceptedPaymentMethods.includes(
    draft.paymentMethod,
  )
    ? draft.paymentMethod
    : (settings?.acceptedPaymentMethods[0] ?? draft.paymentMethod);
  const validAddress = state.addresses.some(
    (address) => address.id === draft.addressId,
  );
  const receipt =
    state.receipt?.customerId === state.profile?.id ? state.receipt : null;
  // The only address is chosen for the customer, such as the one just added from here.
  const onlyAddress =
    state.addresses.length === 1 ? state.addresses[0]!.id : null;
  useEffect(() => {
    if (selectedMode === "DELIVERY" && !validAddress && onlyAddress)
      onDraft({ ...draft, addressId: onlyAddress });
  }, [selectedMode, validAddress, onlyAddress]);

  // Speak the store's total when it arrives: it appears in the footer, away from the button tapped.
  const quotedTotal = state.quote?.totals.totalCents ?? null;
  const lastQuoted = useRef<number | null>(null);
  useEffect(() => {
    if (quotedTotal !== null && quotedTotal !== lastQuoted.current)
      announce(
        `Total confirmado pela loja: ${formatCents(quotedTotal)}. Toque em Confirmar pedido para enviar.`,
      );
    lastQuoted.current = quotedTotal;
  }, [quotedTotal]);

  const change = (patch: Partial<CheckoutDraft>) => {
    model.invalidateQuote();
    setInputError(null);
    onDraft({ ...draft, ...patch });
  };
  const quote = () => {
    try {
      const details: CheckoutDetails = {
        fulfillment: selectedMode,
        paymentMethod: selectedPayment,
        addressId: selectedMode === "DELIVERY" ? draft.addressId : null,
        changeForCents:
          selectedPayment === "CASH" ? moneyInput(draft.change) : null,
        notes: draft.notes,
      };
      void model.quote(
        details,
        subtotal +
          (selectedMode === "DELIVERY" ? settings!.deliveryFeeCents : 0),
      );
    } catch (error) {
      setInputError(
        error instanceof Error ? error.message : "Confira os dados.",
      );
    }
  };
  const header = <ScreenHeader title="Sacola" large />;
  const problems = (
    <>
      {!state.ready ? (
        <InlineMessage
          tone="error"
          title="Não foi possível abrir a sacola"
          action={
            <Button
              label="Tentar de novo"
              size="small"
              disabled={state.busy}
              onPress={() => void model.init()}
            />
          }
        />
      ) : null}
      {state.ready && state.session === "failed" ? (
        <InlineMessage
          tone="warning"
          title="Não foi possível restaurar a sessão"
          action={
            <Button
              label="Tentar de novo"
              size="small"
              disabled={state.busy}
              onPress={() => void model.init()}
            />
          }
        />
      ) : null}
      {state.error ? (
        <InlineMessage tone="error">{state.error}</InlineMessage>
      ) : null}
    </>
  );

  // ----- A pending confirmation: recover it before anything else (ADR 0022). -----
  if (state.pending) {
    const sameAccount = state.profile?.id === state.pending.customerId;
    const canRetry = sameAccount && retryAllowed(state.pending, Date.now());
    return (
      <Screen
        header={header}
        footer={
          <StickyFooter>
            {canRetry ? (
              <Button
                label="Recuperar resultado do pedido"
                variant="primary"
                loading={state.busy}
                disabled={state.busy || !state.ready}
                onPress={() => void model.confirm()}
              />
            ) : !sameAccount ? (
              <Button
                label="Entrar na conta do pedido"
                variant="primary"
                onPress={onAccount}
              />
            ) : null}
          </StickyFooter>
        }
      >
        {problems}
        <InlineMessage tone="warning" title="Confirmação pendente">
          {recoveryOnly
            ? "A resposta do pedido não foi confirmada e a loja está indisponível. Tentar recuperar usa a mesma confirmação, sem criar outro pedido; se a loja não puder responder, confira o resultado diretamente com a pizzaria."
            : "A resposta do pedido não foi confirmada. Recupere o resultado antes de montar outro pedido."}
        </InlineMessage>
        {!sameAccount ? (
          <Body>
            Entre na mesma conta usada na confirmação para recuperar o
            resultado.
          </Body>
        ) : !canRetry ? (
          <Body alert>
            O prazo de recuperação terminou. Confira com a pizzaria se o pedido
            foi recebido.
          </Body>
        ) : null}
        <Button
          label="Já conferi o pedido com a pizzaria"
          variant="ghost"
          disabled={state.busy || !state.ready || !sameAccount}
          onPress={() =>
            Alert.alert(
              "Você confirmou o resultado com a pizzaria?",
              "Liberar o carrinho não cancela um pedido recebido. Só continue depois de conferir com a loja para evitar duplicidade.",
              [
                { text: "Voltar", style: "cancel" },
                {
                  text: "Conferi com a loja; liberar",
                  onPress: () => void model.acknowledgePending(),
                },
              ],
            )
          }
        />
      </Screen>
    );
  }

  // ----- Order received: its own success state (UX audit P2-8). -----
  if (receipt && summary.length === 0)
    return (
      <Screen
        header={header}
        footer={
          <StickyFooter>
            <Button
              label="Acompanhar pedido"
              icon="receipt-outline"
              variant="primary"
              onPress={() => onTrackOrder(receipt.id)}
            />
            <Button
              label="Voltar ao cardápio"
              variant="ghost"
              onPress={onBack}
            />
          </StickyFooter>
        }
        contentStyle={{ flexGrow: 1, justifyContent: "center" }}
      >
        <View style={{ alignItems: "center", gap: theme.spacing(3) }}>
          <View
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: theme.colors.primaryLight,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              name="checkmark-circle"
              size={48}
              color={theme.colors.success}
            />
          </View>
          <Heading level="h2" centered>
            Pedido #{receipt.number} recebido
          </Heading>
          <Body muted centered>
            Total de {formatCents(receipt.totalCents)}. A pizzaria vai confirmar
            o pedido; o pagamento é feito na entrega ou retirada.
          </Body>
        </View>
      </Screen>
    );

  // ----- Store unavailable: nothing to do in the bag. -----
  if (recoveryOnly)
    return (
      <Screen header={header}>
        <InlineMessage tone="warning" title="Loja indisponível">
          Novos pedidos e alterações na sacola ficam bloqueados até a loja
          voltar a atender.
        </InlineMessage>
      </Screen>
    );

  // ----- Empty bag. -----
  if (summary.length === 0)
    return (
      <Screen
        header={header}
        contentStyle={{ flexGrow: 1, justifyContent: "center" }}
      >
        {problems}
        <View style={{ alignItems: "center", gap: theme.spacing(3) }}>
          <Icon
            name="bag-handle-outline"
            size={56}
            color={theme.colors.accentText}
          />
          <Heading level="h2" centered>
            Sua sacola está vazia
          </Heading>
          <Body muted centered>
            Monte uma pizza ou escolha uma bebida no cardápio.
          </Body>
          <Button
            label="Ver o cardápio"
            icon="restaurant-outline"
            variant="primary"
            onPress={onBack}
          />
        </View>
      </Screen>
    );

  // ----- The bag and the checkout. -----
  const action = checkoutAction(
    {
      ready: state.ready,
      busy: state.busy,
      pending: false,
      empty: false,
      unavailableItems,
      stale,
      canOrder,
      settingsLoaded: !!settings,
      signedIn: !!state.profile,
      delivery: selectedMode === "DELIVERY",
      addressChosen: validAddress,
    },
    !!state.quote,
  );
  const fee =
    selectedMode === "DELIVERY" ? (settings?.deliveryFeeCents ?? 0) : 0;
  const quoteTotals = state.quote?.totals ?? null;
  return (
    <Screen
      keyboard
      header={header}
      footer={
        <StickyFooter>
          {action.kind === "blocked" ? (
            <View
              style={{ flexDirection: "row", gap: 6, alignItems: "center" }}
            >
              <Icon
                name="information-circle"
                size={18}
                color={theme.colors.accentText}
              />
              <Text
                style={{
                  flex: 1,
                  color: theme.colors.text,
                  fontSize: theme.typography.bodySmall.fontSize,
                  lineHeight: theme.typography.bodySmall.lineHeight,
                  fontWeight: "600",
                }}
              >
                {action.reason}
              </Text>
            </View>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing(3),
            }}
          >
            <View style={{ flexShrink: 1 }}>
              <Body small muted>
                {quoteTotals ? "Total confirmado" : "Total estimado"}
              </Body>
              <Text
                style={{
                  color: theme.colors.text,
                  fontSize: theme.typography.price.fontSize,
                  lineHeight: theme.typography.price.lineHeight,
                  fontWeight: "800",
                }}
              >
                {formatCents(quoteTotals?.totalCents ?? subtotal + fee)}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              {action.kind === "sign-in" ? (
                <Button
                  label="Entrar para pedir"
                  icon="person-circle-outline"
                  variant="primary"
                  onPress={onAccount}
                />
              ) : action.kind === "confirm" ? (
                <Button
                  label="Confirmar pedido"
                  icon="checkmark"
                  variant="primary"
                  loading={state.busy}
                  accessibilityLabel={`Confirmar pedido de ${formatCents(quoteTotals!.totalCents)}`}
                  onPress={() => void model.confirm()}
                />
              ) : (
                <Button
                  label="Revisar total"
                  variant="primary"
                  loading={state.busy}
                  disabled={action.kind === "blocked"}
                  accessibilityHint={
                    action.kind === "blocked"
                      ? action.reason
                      : "A loja confere preços e disponibilidade antes da confirmação"
                  }
                  onPress={quote}
                />
              )}
            </View>
          </View>
        </StickyFooter>
      }
    >
      {problems}
      {inputError ? (
        <InlineMessage tone="error">{inputError}</InlineMessage>
      ) : null}
      {receipt ? (
        <InlineMessage
          tone="success"
          title={`Pedido #${receipt.number} recebido`}
          action={
            <Button
              label="Acompanhar pedido"
              size="small"
              onPress={() => onTrackOrder(receipt.id)}
            />
          }
        />
      ) : null}
      {stale || !canOrder ? (
        <InlineMessage
          tone="warning"
          action={
            <Button
              label="Atualizar loja e cardápio"
              icon="refresh"
              size="small"
              disabled={state.busy}
              onPress={onRefresh}
            />
          }
        >
          {stale
            ? "O cardápio está desatualizado. Atualize antes de pedir."
            : "A loja precisa estar aberta e conectada para confirmar um novo pedido."}
        </InlineMessage>
      ) : null}

      <Section
        title={`Itens · ${plural(cartUnits(state.cart), "unidade", "unidades")}`}
      >
        {summary.map((line, index) => (
          <View
            key={line.id}
            style={{
              padding: theme.spacing(4),
              gap: theme.spacing(2),
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: theme.colors.border,
            }}
          >
            <View style={{ flexDirection: "row", gap: theme.spacing(3) }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  style={{
                    color: theme.colors.text,
                    fontSize: theme.typography.body.fontSize,
                    lineHeight: theme.typography.body.lineHeight,
                    fontWeight: "700",
                  }}
                >
                  {line.name}
                </Text>
                {line.details.map((detail, at) => (
                  <Body key={at} small muted>
                    {detail}
                  </Body>
                ))}
              </View>
              <Text
                style={{
                  color: theme.colors.text,
                  fontSize: theme.typography.body.fontSize,
                  lineHeight: theme.typography.body.lineHeight,
                  fontWeight: "700",
                }}
              >
                {line.totalCents === null ? "—" : formatCents(line.totalCents)}
              </Text>
            </View>
            {line.totalCents === null ? (
              <Body alert small>
                Item indisponível: remova ou monte novamente.
              </Body>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <QuantityStepper
                value={line.quantity}
                min={1}
                max={CART_QUANTITY_LIMIT}
                itemName={line.name}
                disabled={locked}
                onChange={(next) =>
                  void model.changeCart((lines) =>
                    changeQuantity(lines, line.id, next),
                  )
                }
              />
              <IconButton
                name="trash-outline"
                tone="danger"
                accessibilityLabel={`Remover ${line.name} da sacola`}
                disabled={locked}
                onPress={() =>
                  Alert.alert("Remover da sacola?", line.name, [
                    { text: "Manter", style: "cancel" },
                    {
                      text: "Remover",
                      style: "destructive",
                      onPress: () =>
                        void model
                          .changeCart((lines) => removeLine(lines, line.id))
                          .then(
                            (ok) => ok && announce(`${line.name} removido.`),
                          ),
                    },
                  ])
                }
              />
            </View>
          </View>
        ))}
        <ListRow
          icon="add-circle-outline"
          title="Adicionar mais itens"
          onPress={onBack}
        />
      </Section>

      {settings ? (
        <>
          <View style={{ gap: theme.spacing(3) }}>
            <Heading level="h3">Como receber</Heading>
            {settings.fulfillmentModes.length > 1 ? (
              <SegmentedControl
                options={settings.fulfillmentModes.map((mode) => ({
                  value: mode,
                  label: mode === "DELIVERY" ? "Entrega" : "Retirada",
                }))}
                value={selectedMode}
                disabled={locked}
                onChange={(mode) => change({ fulfillment: mode })}
              />
            ) : null}
            {selectedMode === "DELIVERY" ? (
              <>
                <Body small muted>
                  Área de entrega:{" "}
                  {settings.deliveryAreaDescription
                    ? `${settings.deliveryAreaDescription.replace(/[.\s]+$/, "")}.`
                    : "confirme a área atendida com a pizzaria."}{" "}
                  Taxa fixa de {formatCents(settings.deliveryFeeCents)}.
                </Body>
                {state.addresses.map((address) => (
                  <Choice
                    key={address.id}
                    kind="radio"
                    label={`${address.label}: ${address.street}, ${address.number}`}
                    detail={[
                      address.complement,
                      address.district,
                      `${address.city}/${address.state}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    selected={draft.addressId === address.id}
                    disabled={locked}
                    onPress={() => change({ addressId: address.id })}
                  />
                ))}
                {state.profile && state.addresses.length < 10 ? (
                  <Button
                    label="Adicionar endereço"
                    icon="add-circle-outline"
                    size="medium"
                    disabled={locked}
                    onPress={onAddAddress}
                  />
                ) : null}
              </>
            ) : (
              <ListRow
                first
                icon="storefront-outline"
                title="Retirar na pizzaria"
                subtitle={
                  settings.pickupAddress ??
                  "Confirme o endereço com a pizzaria."
                }
              />
            )}
          </View>

          <View style={{ gap: theme.spacing(3) }}>
            <Heading level="h3">Pagamento</Heading>
            <Body small muted>
              O pagamento é feito na entrega ou retirada.
            </Body>
            <View
              accessibilityRole="radiogroup"
              style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
            >
              {settings.acceptedPaymentMethods.map((method) => (
                <Choice
                  key={method}
                  kind="radio"
                  label={payments[method]}
                  selected={selectedPayment === method}
                  disabled={locked}
                  onPress={() => change({ paymentMethod: method })}
                />
              ))}
            </View>
            {selectedPayment === "CASH" ? (
              <Field
                label="Troco para (opcional)"
                helper="Em reais, por exemplo 100,00."
                value={draft.change}
                keyboardType="decimal-pad"
                doneBar
                maxLength={10}
                editable={!locked}
                onChangeText={(value) => change({ change: value })}
              />
            ) : null}
            <Field
              label="Observações (opcional)"
              helper="Ex.: interfone com defeito, cortar em 12 pedaços."
              value={draft.notes}
              multiline
              maxLength={280}
              editable={!locked}
              onChangeText={(value) => change({ notes: value })}
            />
          </View>
        </>
      ) : null}

      <View
        style={[
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.large,
            padding: theme.spacing(4),
            gap: theme.spacing(2),
          },
          theme.shadow,
        ]}
      >
        <Heading level="h3">Resumo</Heading>
        {quoteTotals?.priceChanged ? (
          <InlineMessage tone="warning">
            O preço mudou em relação à estimativa. Confira o novo total.
          </InlineMessage>
        ) : null}
        <TotalRow
          label="Itens"
          value={formatCents(quoteTotals?.itemsSubtotalCents ?? subtotal)}
        />
        <TotalRow
          label="Entrega"
          value={formatCents(quoteTotals?.deliveryFeeCents ?? fee)}
        />
        {quoteTotals?.discountCents ? (
          <TotalRow
            label="Desconto"
            value={`− ${formatCents(quoteTotals.discountCents)}`}
          />
        ) : null}
        <TotalRow
          strong
          label={quoteTotals ? "Total confirmado" : "Total estimado"}
          value={formatCents(quoteTotals?.totalCents ?? subtotal + fee)}
        />
        {settings ? (
          <Body small muted>
            Pedido mínimo em itens: {formatCents(settings.minimumOrderCents)}.
            {quoteTotals
              ? ""
              : " Em “Revisar total”, a loja confere preços e disponibilidade."}
          </Body>
        ) : null}
      </View>
    </Screen>
  );
}
