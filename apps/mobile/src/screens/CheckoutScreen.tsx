import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { Body, Button, Field, FormPage, Heading } from "../components/Form.tsx";
import { Choice } from "../components/Choice.tsx";
import {
  type CommerceModel,
  type CommerceState,
  retryAllowed,
} from "../cart/model.ts";
import {
  type CheckoutDetails,
  changeQuantity,
  removeLine,
} from "../cart/cart.ts";
import {
  type CheckoutSettings,
  cartSummary,
  moneyInput,
} from "../cart/summary.ts";
import { type PublicMenu, formatCents } from "../menu/menu.ts";

const payments = {
  CASH: "Dinheiro",
  CARD_ON_DELIVERY: "Cartão na entrega ou retirada",
  PIX_ON_DELIVERY: "Pix presencial",
} as const;
export function CheckoutScreen({
  model,
  state,
  menu,
  settings,
  canOrder,
  stale,
  onBack,
  onAccount,
  onRefresh,
}: {
  model: CommerceModel;
  state: CommerceState;
  menu: PublicMenu | null;
  settings: CheckoutSettings | null;
  canOrder: boolean;
  stale: boolean;
  onBack: () => void;
  onAccount: () => void;
  onRefresh: () => void;
}) {
  const [fulfillment, setFulfillment] =
    useState<CheckoutDetails["fulfillment"]>("PICKUP");
  const [paymentMethod, setPayment] =
    useState<CheckoutDetails["paymentMethod"]>("CASH");
  const [addressId, setAddress] = useState<string | null>(null);
  const [change, setChange] = useState("");
  const [notes, setNotes] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const summary = useMemo(
    () => cartSummary(state.cart, menu),
    [state.cart, menu],
  );
  const subtotal = summary.reduce(
    (sum, line) => sum + (line.totalCents ?? 0),
    0,
  );
  const validItems =
    summary.length > 0 && summary.every((line) => line.totalCents !== null);
  const disabled = state.busy || !state.ready;
  const locked = disabled || !!state.pending;
  const selectedMode = settings?.fulfillmentModes.includes(fulfillment)
    ? fulfillment
    : (settings?.fulfillmentModes[0] ?? fulfillment);
  const selectedPayment = settings?.acceptedPaymentMethods.includes(
    paymentMethod,
  )
    ? paymentMethod
    : (settings?.acceptedPaymentMethods[0] ?? paymentMethod);
  const validAddress = state.addresses.some(
    (address) => address.id === addressId,
  );
  const eligible =
    canOrder &&
    !stale &&
    !!settings &&
    validItems &&
    !!state.profile &&
    !locked &&
    (selectedMode === "PICKUP" || validAddress);
  const receipt =
    state.receipt?.customerId === state.profile?.id ? state.receipt : null;
  const invalidate = () => {
    model.invalidateQuote();
    setInputError(null);
  };
  const quote = () => {
    try {
      const details: CheckoutDetails = {
        fulfillment: selectedMode,
        paymentMethod: selectedPayment,
        addressId: selectedMode === "DELIVERY" ? addressId : null,
        changeForCents: selectedPayment === "CASH" ? moneyInput(change) : null,
        notes,
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
  return (
    <FormPage>
      <Button
        label="Voltar ao cardápio"
        onPress={onBack}
        disabled={state.busy}
      />
      <Heading>Carrinho e checkout</Heading>
      {state.error || inputError ? (
        <Body alert>{inputError ?? state.error}</Body>
      ) : null}
      {state.busy ? <Body>Processando…</Body> : null}
      {!state.ready ? (
        <Button
          label="Tentar restaurar o carrinho"
          onPress={() => void model.init()}
          disabled={state.busy}
        />
      ) : null}
      {state.ready && state.session === "failed" ? (
        <Button
          label="Tentar restaurar a sessão"
          onPress={() => void model.init()}
          disabled={state.busy}
        />
      ) : null}
      <Button
        label={
          state.profile
            ? `Minha conta · ${state.profile.name}`
            : "Entrar ou criar conta"
        }
        disabled={disabled}
        onPress={onAccount}
      />
      {receipt ? (
        <>
          <Heading>Pedido #{receipt.number} recebido</Heading>
          <Body>
            Total: {formatCents(receipt.totalCents)}. Aguarde a confirmação da
            pizzaria. O pagamento será feito na entrega ou retirada.
          </Body>
        </>
      ) : null}
      {state.pending ? (
        <>
          <Heading>Confirmação pendente</Heading>
          <Body>
            A resposta ainda não foi confirmada. Recupere este pedido antes de
            montar outro.
          </Body>
          {state.profile?.id !== state.pending.customerId ? (
            <Body>
              Entre na mesma conta usada na confirmação para recuperar o
              resultado.
            </Body>
          ) : retryAllowed(state.pending, Date.now()) ? (
            <Button
              label="Recuperar resultado do pedido"
              disabled={disabled}
              onPress={() => void model.confirm()}
            />
          ) : (
            <Body alert>
              O prazo de recuperação terminou. Confira com a pizzaria se o
              pedido foi recebido.
            </Body>
          )}
          <Button
            label="Já conferi o pedido com a pizzaria"
            disabled={
              disabled || state.profile?.id !== state.pending.customerId
            }
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
        </>
      ) : (
        <>
          {stale ? (
            <Body alert>
              O cardápio está desatualizado. Atualize antes de pedir.
            </Body>
          ) : null}
          {!canOrder ? (
            <Body>
              A loja precisa estar aberta e conectada para confirmar um novo
              pedido.
            </Body>
          ) : null}
          {!settings ? (
            <Body>
              As opções de entrega e pagamento ainda não foram carregadas.
            </Body>
          ) : null}
          <Button
            label="Atualizar loja e cardápio"
            onPress={onRefresh}
            disabled={disabled}
          />
          {summary.length === 0 ? (
            <Body>Seu carrinho está vazio.</Body>
          ) : (
            summary.map((line) => (
              <View key={line.id} style={{ gap: 8 }}>
                <Heading>{line.name}</Heading>
                {line.details.map((detail, index) => (
                  <Body key={index}>{detail}</Body>
                ))}
                <Body>
                  {line.quantity} un. ·{" "}
                  {line.totalCents === null
                    ? "Item indisponível — remova ou monte novamente"
                    : `Estimativa: ${formatCents(line.totalCents)}`}
                </Body>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  <Button
                    label={`Diminuir ${line.name}`}
                    disabled={locked || line.quantity <= 1}
                    onPress={() =>
                      void model.changeCart((lines) =>
                        changeQuantity(lines, line.id, line.quantity - 1),
                      )
                    }
                  />
                  <Button
                    label={`Aumentar ${line.name}`}
                    disabled={locked || line.quantity >= 20}
                    onPress={() =>
                      void model.changeCart((lines) =>
                        changeQuantity(lines, line.id, line.quantity + 1),
                      )
                    }
                  />
                  <Button
                    label={`Remover ${line.name}`}
                    disabled={locked}
                    onPress={() =>
                      void model.changeCart((lines) =>
                        removeLine(lines, line.id),
                      )
                    }
                  />
                </View>
              </View>
            ))
          )}
          {summary.length > 0 && settings ? (
            <>
              <Heading>Recebimento</Heading>
              {settings.fulfillmentModes.map((mode) => (
                <Choice
                  key={mode}
                  kind="radio"
                  label={mode === "DELIVERY" ? "Entrega" : "Retirada"}
                  selected={selectedMode === mode}
                  disabled={locked}
                  onPress={() => {
                    invalidate();
                    setFulfillment(mode);
                  }}
                />
              ))}
              {selectedMode === "DELIVERY" ? (
                <>
                  <Body>
                    Área de entrega:{" "}
                    {settings.deliveryAreaDescription ??
                      "Confirme a área atendida com a pizzaria."}
                  </Body>
                  <Body>
                    Taxa fixa: {formatCents(settings.deliveryFeeCents)}
                  </Body>
                  {state.addresses.map((address) => (
                    <Choice
                      key={address.id}
                      kind="radio"
                      label={`${address.label}: ${address.street}, ${address.number}`}
                      detail={`${address.complement ?? ""} ${address.district} · ${address.city}/${address.state} · ${address.postalCode}`}
                      selected={addressId === address.id}
                      disabled={locked}
                      onPress={() => {
                        invalidate();
                        setAddress(address.id);
                      }}
                    />
                  ))}
                  {!validAddress ? (
                    <Body>
                      Selecione um endereço. Cadastre ou edite endereços em
                      Minha conta.
                    </Body>
                  ) : null}
                </>
              ) : (
                <Body>
                  Retirada em:{" "}
                  {settings.pickupAddress ??
                    "Confirme o endereço com a pizzaria."}
                </Body>
              )}
              <Body>
                Pedido mínimo em itens:{" "}
                {formatCents(settings.minimumOrderCents)}
              </Body>
              <Heading>Pagamento</Heading>
              <Body>O pagamento é realizado na entrega ou retirada.</Body>
              {settings.acceptedPaymentMethods.map((method) => (
                <Choice
                  key={method}
                  kind="radio"
                  label={payments[method]}
                  selected={selectedPayment === method}
                  disabled={locked}
                  onPress={() => {
                    invalidate();
                    setPayment(method);
                  }}
                />
              ))}
              {selectedPayment === "CASH" ? (
                <Field
                  label="Troco para (R$, opcional)"
                  value={change}
                  keyboardType="decimal-pad"
                  maxLength={10}
                  editable={!locked}
                  onChangeText={(value) => {
                    invalidate();
                    setChange(value);
                  }}
                />
              ) : null}
              <Field
                label="Observações (opcional)"
                value={notes}
                multiline
                maxLength={280}
                editable={!locked}
                onChangeText={(value) => {
                  invalidate();
                  setNotes(value);
                }}
              />
              <Button
                label="Calcular total na loja"
                disabled={!eligible}
                onPress={quote}
              />
              {state.quote ? (
                <>
                  <Heading>Confira antes de confirmar</Heading>
                  {state.quote.totals.priceChanged ? (
                    <Body alert>
                      O preço mudou em relação à estimativa. Confira o novo
                      total abaixo.
                    </Body>
                  ) : null}
                  <Body>
                    Itens: {formatCents(state.quote.totals.itemsSubtotalCents)}
                  </Body>
                  <Body>
                    Entrega: {formatCents(state.quote.totals.deliveryFeeCents)}
                  </Body>
                  <Heading>
                    Total: {formatCents(state.quote.totals.totalCents)}
                  </Heading>
                  <Button
                    label={`Confirmar pedido de ${formatCents(state.quote.totals.totalCents)}`}
                    disabled={!eligible}
                    onPress={() => void model.confirm()}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </FormPage>
  );
}
