import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  PIZZA_QUANTITY_MAX,
  PIZZA_QUANTITY_MIN,
  type HalfSide,
} from "@whiteoven/contracts";
import { useTheme } from "../brand/theme.tsx";
import {
  type BuilderMenu,
  type BuilderState,
  SIDE_NAMES,
  describeOrderLine,
  describePizza,
  evaluateBuilder,
  extraLimitReached,
  previewConfiguration,
  priceLines,
  setCrust,
  setFlavor,
  setMode,
  setQuantity,
  setSize,
  startBuilder,
  toggleExtra,
  toggleRemoval,
} from "../builder/builder.ts";
import { formatCents } from "../menu/menu.ts";
import { Choice } from "../components/Choice.tsx";
import { PizzaVisual } from "../components/PizzaVisual.tsx";

interface Props {
  builder: BuilderMenu;
  flavorId: string;
  onBack: () => void;
}

/**
 * The Pizza Builder (M5.2, ADR 0021). Every choice goes through `pizza-pricing`, the same
 * pipeline the API runs; the price shown is an estimate the order confirms (M5.3).
 */
export function BuilderScreen({ builder, flavorId, onBack }: Props) {
  const theme = useTheme();
  const [state, setState] = useState<BuilderState | null>(() =>
    startBuilder(builder, flavorId),
  );
  const result = useMemo(
    () => (state ? evaluateBuilder(builder, state) : null),
    [builder, state],
  );

  const back = (
    <Pressable
      accessibilityRole="button"
      onPress={onBack}
      style={[styles.back, { borderRadius: theme.radius.pill }]}
    >
      <Text style={[styles.backText, { color: theme.colors.accentText }]}>
        ← Voltar ao cardápio
      </Text>
    </Pressable>
  );
  if (!state || !result)
    return (
      <View
        style={[
          styles.fill,
          { backgroundColor: theme.colors.cream, padding: theme.spacing(4) },
        ]}
      >
        {back}
        <Text style={[styles.body, { color: theme.colors.text }]}>
          Este sabor não está mais disponível.
        </Text>
      </View>
    );

  const { menu, index } = builder;
  const update = (next: BuilderState) => setState(next);
  const size = menu.sizes.find((entry) => entry.id === state.sizeId);
  const sides: HalfSide[] =
    state.mode === "HALVES" ? ["LEFT", "RIGHT"] : ["LEFT"];
  const sideTitle = (side: HalfSide) =>
    state.mode === "HALVES" ? SIDE_NAMES[side] : "Pizza inteira";
  // What the pizzeria will make: the normalized configuration once it is valid.
  const shown =
    result.kind === "priced"
      ? result.configuration
      : previewConfiguration(state);
  const halves = describePizza(builder, shown);
  const flavorsAt = menu.flavors.filter(
    (flavor) => index.flavorPrice(flavor.id, state.sizeId) !== undefined,
  );
  const crusts = menu.crusts.filter(
    (crust) => index.crustPrice(crust.id, state.sizeId) !== undefined,
  );
  const extras = menu.extras.filter(
    (extra) => index.extraPrice(extra.id, state.sizeId) !== undefined,
  );

  const heading = (text: string) => (
    <Text
      accessibilityRole="header"
      style={[styles.heading, { color: theme.colors.text }]}
    >
      {text}
    </Text>
  );
  const row = {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: theme.spacing(2),
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.cream }}
      contentContainerStyle={{
        padding: theme.spacing(4),
        gap: theme.spacing(4),
      }}
    >
      {back}
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: theme.colors.accentText }]}
      >
        Monte sua pizza
      </Text>

      <PizzaVisual
        mode={shown.mode}
        description={halves.map((half) => half.text).join(" ")}
      />
      <View
        accessibilityLiveRegion="polite"
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.small,
            padding: theme.spacing(3),
            gap: theme.spacing(2),
          },
        ]}
      >
        {halves.map((half) => (
          <View key={half.title} accessible accessibilityLabel={half.text}>
            <Text
              style={[styles.halfTitle, { color: theme.colors.accentText }]}
            >
              {half.title}
            </Text>
            <Text style={[styles.body, { color: theme.colors.text }]}>
              {half.flavor}
              {half.details.length ? ` · ${half.details.join(" · ")}` : ""}
            </Text>
          </View>
        ))}
        <Text style={[styles.small, { color: theme.colors.muted }]}>
          {describeOrderLine(builder, shown)}
        </Text>
      </View>

      {heading("Tamanho")}
      <View accessibilityRole="radiogroup" style={row}>
        {menu.sizes.map((entry) => (
          <Choice
            key={entry.id}
            kind="radio"
            label={entry.name}
            detail={`${entry.slices} fatias${entry.maxFlavors === 1 ? " · 1 sabor" : ""}`}
            selected={entry.id === state.sizeId}
            onPress={() => update(setSize(builder, state, entry.id))}
          />
        ))}
      </View>

      {heading("Sabores")}
      <View accessibilityRole="radiogroup" style={row}>
        <Choice
          kind="radio"
          label="Um sabor"
          selected={state.mode === "WHOLE"}
          onPress={() => update(setMode(state, "WHOLE"))}
        />
        <Choice
          kind="radio"
          label="Meio a meio"
          detail={
            size?.maxFlavors === 1 ? "não disponível neste tamanho" : undefined
          }
          selected={state.mode === "HALVES"}
          disabled={size?.maxFlavors === 1 && state.mode !== "HALVES"}
          onPress={() => update(setMode(state, "HALVES"))}
        />
      </View>
      {sides.map((side) => (
        <View key={side} style={{ gap: theme.spacing(2) }}>
          <Text style={[styles.halfTitle, { color: theme.colors.text }]}>
            {state.mode === "HALVES"
              ? `Sabor da ${SIDE_NAMES[side].toLowerCase()}`
              : "Sabor"}
          </Text>
          <View accessibilityRole="radiogroup" style={row}>
            {flavorsAt.map((flavor) => (
              <Choice
                key={flavor.id}
                kind="radio"
                label={flavor.name}
                detail={formatCents(
                  index.flavorPrice(flavor.id, state.sizeId)!,
                )}
                accessibilityLabel={`${flavor.name} na ${sideTitle(side).toLowerCase()}, ${formatCents(index.flavorPrice(flavor.id, state.sizeId)!)}`}
                selected={state.flavors[side] === flavor.id}
                onPress={() => update(setFlavor(state, side, flavor.id))}
              />
            ))}
          </View>
        </View>
      ))}

      {crusts.length ? (
        <>
          {heading("Borda")}
          <View accessibilityRole="radiogroup" style={row}>
            <Choice
              kind="radio"
              label="Sem borda recheada"
              selected={state.crustId === null}
              onPress={() => update(setCrust(state, null))}
            />
            {crusts.map((crust) => (
              <Choice
                key={crust.id}
                kind="radio"
                label={crust.name}
                detail={`+ ${formatCents(index.crustPrice(crust.id, state.sizeId)!)}`}
                selected={state.crustId === crust.id}
                onPress={() => update(setCrust(state, crust.id))}
              />
            ))}
          </View>
        </>
      ) : null}

      {extras.length && menu.pricingPolicy?.maxExtrasPerHalf ? (
        <>
          {heading("Adicionais")}
          <Text style={[styles.small, { color: theme.colors.muted }]}>
            Até {menu.pricingPolicy.maxExtrasPerHalf} por{" "}
            {state.mode === "HALVES"
              ? "metade. Escolhido nas duas metades, é cobrado como pizza inteira."
              : "pizza."}
          </Text>
          {sides.map((side) => {
            const full = extraLimitReached(menu, state, side);
            return (
              <View key={side} style={{ gap: theme.spacing(2) }}>
                {state.mode === "HALVES" ? (
                  <Text
                    style={[styles.halfTitle, { color: theme.colors.text }]}
                  >
                    {SIDE_NAMES[side]}
                  </Text>
                ) : null}
                <View style={row}>
                  {extras.map((extra) => {
                    const price = index.extraPrice(extra.id, state.sizeId)!;
                    const amount = `+ ${formatCents(state.mode === "HALVES" ? price.halfPriceCents : price.wholePriceCents)}`;
                    const selected = state.extras[side].includes(extra.id);
                    return (
                      <Choice
                        key={extra.id}
                        kind="checkbox"
                        label={extra.name}
                        detail={amount}
                        accessibilityLabel={`${extra.name} na ${sideTitle(side).toLowerCase()}, ${amount}`}
                        selected={selected}
                        disabled={full && !selected}
                        onPress={() =>
                          update(toggleExtra(state, side, extra.id))
                        }
                      />
                    );
                  })}
                </View>
              </View>
            );
          })}
        </>
      ) : null}

      {sides.some(
        (side) => removableOf(builder, state.flavors[side]).length,
      ) ? (
        <>
          {heading("Retirar ingredientes")}
          {sides.map((side) => {
            const removable = removableOf(builder, state.flavors[side]);
            if (!removable.length) return null;
            return (
              <View key={side} style={{ gap: theme.spacing(2) }}>
                {state.mode === "HALVES" ? (
                  <Text
                    style={[styles.halfTitle, { color: theme.colors.text }]}
                  >
                    {SIDE_NAMES[side]}
                  </Text>
                ) : null}
                <View style={row}>
                  {removable.map((ingredient) => (
                    <Choice
                      key={ingredient.id}
                      kind="checkbox"
                      label={`Sem ${ingredient.name}`}
                      accessibilityLabel={`Sem ${ingredient.name} na ${sideTitle(side).toLowerCase()}`}
                      selected={state.removals[side].includes(ingredient.id)}
                      onPress={() =>
                        update(toggleRemoval(state, side, ingredient.id))
                      }
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </>
      ) : null}

      {heading("Quantidade")}
      <View style={[row, { alignItems: "center" }]}>
        <Step
          label="−"
          accessibilityLabel="Diminuir quantidade"
          disabled={state.quantity <= PIZZA_QUANTITY_MIN}
          onPress={() => update(setQuantity(state, state.quantity - 1))}
        />
        <Text
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Quantidade: ${state.quantity}`}
          style={[styles.quantity, { color: theme.colors.text }]}
        >
          {state.quantity}
        </Text>
        <Step
          label="+"
          accessibilityLabel="Aumentar quantidade"
          disabled={state.quantity >= PIZZA_QUANTITY_MAX}
          onPress={() => update(setQuantity(state, state.quantity + 1))}
        />
      </View>

      <View
        accessibilityLiveRegion="polite"
        style={[
          styles.card,
          {
            backgroundColor:
              result.kind === "invalid"
                ? theme.colors.errorSurface
                : theme.colors.surface,
            borderColor:
              result.kind === "invalid"
                ? theme.colors.error
                : theme.colors.border,
            borderRadius: theme.radius.small,
            padding: theme.spacing(3),
            gap: theme.spacing(2),
          },
        ]}
      >
        {result.kind === "priced" ? (
          <>
            {priceLines(builder, result).map((line) => (
              <View key={line.label} style={styles.line}>
                <Text
                  style={[
                    styles.body,
                    styles.lineLabel,
                    { color: theme.colors.text },
                  ]}
                >
                  {line.label}
                </Text>
                <Text style={[styles.body, { color: theme.colors.text }]}>
                  {line.amount}
                </Text>
              </View>
            ))}
            <View style={styles.line}>
              <Text
                style={[
                  styles.total,
                  styles.lineLabel,
                  { color: theme.colors.text },
                ]}
              >
                Total estimado
              </Text>
              <Text style={[styles.total, { color: theme.colors.accentText }]}>
                {formatCents(result.price.totalCents)}
              </Text>
            </View>
            <Text style={[styles.small, { color: theme.colors.muted }]}>
              A pizzaria confirma o valor ao receber o pedido.
            </Text>
          </>
        ) : result.kind === "invalid" ? (
          <View accessibilityRole="alert" style={{ gap: theme.spacing(1) }}>
            {result.messages.map((message) => (
              <Text
                key={message}
                style={[styles.body, { color: theme.colors.error }]}
              >
                {message}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={[styles.body, { color: theme.colors.text }]}>
            {result.message}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

function Step(props: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.step,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: pressed
            ? theme.colors.primaryPressed
            : theme.colors.primary,
          opacity: props.disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text style={[styles.stepText, { color: theme.colors.onPrimary }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Ingredients of the flavor that the customer may take out (PB-12). */
function removableOf({ menu }: BuilderMenu, flavorId: string | null) {
  const flavor = menu.flavors.find((entry) => entry.id === flavorId);
  if (!flavor) return [];
  return menu.ingredients.filter(
    (ingredient) =>
      ingredient.removable && flavor.ingredientIds.includes(ingredient.id),
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, gap: 16 },
  back: { minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  backText: { fontSize: 16, fontWeight: "700" },
  title: { fontSize: 28, fontWeight: "800", lineHeight: 34 },
  heading: { fontSize: 20, fontWeight: "800" },
  halfTitle: { fontSize: 16, fontWeight: "800" },
  card: { borderWidth: 1 },
  body: { fontSize: 16, lineHeight: 24 },
  small: { fontSize: 14, lineHeight: 20 },
  step: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 22, fontWeight: "800" },
  quantity: {
    fontSize: 20,
    fontWeight: "800",
    minWidth: 32,
    textAlign: "center",
  },
  line: { flexDirection: "row", gap: 12 },
  lineLabel: { flex: 1 },
  total: { fontSize: 18, fontWeight: "800" },
});
