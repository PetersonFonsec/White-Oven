import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  PIZZA_QUANTITY_MAX,
  PIZZA_QUANTITY_MIN,
  type HalfSide,
  type PizzaConfiguration,
} from "@whiteoven/contracts";
import { announce } from "../a11y/useAnnouncement.ts";
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
  type SizeChange,
  changeSize,
  startBuilder,
  toggleExtra,
  toggleRemoval,
} from "../builder/builder.ts";
import {
  type BuilderStep,
  STEP_LABELS,
  builderChanged,
  builderSteps,
  blockerBefore,
  builderBack,
  canOpenStep,
  runBuilderBack,
  editedSide,
  footerState,
  sideAfterFlavor,
} from "../builder/flow.ts";
import { PAGE_GUTTER } from "../components/layout.ts";
import { formatCents } from "../menu/menu.ts";
import { Choice } from "../components/Choice.tsx";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button, Heading } from "../components/Form.tsx";
import { Icon } from "../components/Icon.tsx";
import { PizzaVisual } from "../components/PizzaVisual.tsx";
import { QuantityStepper } from "../components/QuantityStepper.tsx";
import { Screen, ScreenHeader, StickyFooter } from "../components/Screen.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { MENU_STALE_NOTICE } from "./store-messages.ts";

interface Props {
  addingDisabled: boolean;
  addError: string | null;
  builder: BuilderMenu;
  /**
   * Filled by the builder with its back action, so Android's back button (one listener, in App)
   * does exactly what the header arrow does: previous step, or leave asking first.
   */
  backRef: RefObject<(() => void) | null>;
  flavorId: string;
  flavorImageUrl: (imageId: string) => string;
  /** The menu could not be reloaded: prices and availability may be old. */
  menuStale: boolean;
  onBack: () => void;
  onAdd: (pizza: PizzaConfiguration) => void;
}

/**
 * The Pizza Builder (M5.2, ADR 0021). Every choice goes through `pizza-pricing`, the same
 * pipeline the API runs; the price shown is an estimate the order confirms (M5.3).
 *
 * For half-and-half, one half is edited at a time: a sticky bar says which one (in words and with
 * a check mark, not only color), the pizza dims the other half, and the single flavor list,
 * extras and removals all apply to it. The footer is always there: the total and the add button,
 * or what is still missing.
 */
export function BuilderScreen({
  addingDisabled,
  addError,
  backRef,
  builder,
  flavorId,
  flavorImageUrl,
  menuStale,
  onBack,
  onAdd,
}: Props) {
  const theme = useTheme();
  const initial = useRef<BuilderState | null>(null);
  const [state, setState] = useState<BuilderState | null>(() => {
    initial.current = startBuilder(builder, flavorId);
    return initial.current;
  });
  const [active, setActive] = useState<HalfSide>("LEFT");
  const [step, setStep] = useState<BuilderStep>("size");
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tileWidth = Math.floor(
    (window.width -
      2 * PAGE_GUTTER -
      insets.left -
      insets.right -
      2 * theme.spacing(3)) /
      3,
  );
  /** The last size tap that was blocked or waits for confirmation; any other choice clears it. */
  const [sizeChange, setSizeChange] = useState<{
    sizeId: string;
    change: Exclude<SizeChange, { kind: "applied" }>;
  } | null>(null);
  const result = useMemo(
    () => (state ? evaluateBuilder(builder, state) : null),
    [builder, state],
  );

  /** Asks before discarding; "Continuar montando" keeps the pizza exactly as it is. */
  const confirmLeave = (discard: () => void) =>
    Alert.alert(
      "Sair sem adicionar?",
      "A pizza que você montou não vai para a sacola.",
      [
        { text: "Continuar montando", style: "cancel" },
        { text: "Sair", style: "destructive", onPress: discard },
      ],
    );
  const leave = () =>
    builderChanged(initial.current, state) ? confirmLeave(onBack) : onBack();
  // The back action of this render; Android's button reads it through `backRef`.
  const back = useRef<() => void>(leave);
  back.current = leave;
  useEffect(() => {
    backRef.current = () => back.current();
    return () => {
      backRef.current = null;
    };
  }, [backRef]);
  const header = (
    <ScreenHeader title="Monte sua pizza" onBack={leave} backTo="Cardápio" />
  );
  if (!state || !result)
    return (
      <Screen header={header}>
        <InlineMessage tone="warning" title="Sabor indisponível">
          Este sabor não está mais disponível. Volte ao cardápio e escolha
          outro.
        </InlineMessage>
        <Button label="Ver o cardápio" variant="primary" onPress={onBack} />
      </Screen>
    );

  const { menu, index } = builder;
  const update = (next: BuilderState) => {
    setSizeChange(null);
    setState(next);
  };
  const pickSize = (sizeId: string) => {
    const change = changeSize(builder, state, sizeId);
    if (change.kind === "applied") update(change.state);
    else setSizeChange({ sizeId, change });
  };
  const halves = state.mode === "HALVES";
  const side = editedSide(state, active);
  const sideName = halves ? SIDE_NAMES[side].toLowerCase() : "pizza";
  const size = menu.sizes.find((entry) => entry.id === state.sizeId);
  // What the pizzeria will make: the normalized configuration once it is valid.
  const shown =
    result.kind === "priced"
      ? result.configuration
      : previewConfiguration(state);
  const described = describePizza(builder, shown);
  const flavorOf = (id: string | null | undefined) =>
    menu.flavors.find((flavor) => flavor.id === id) ?? null;
  const flavorImage = (id: string | null | undefined) => {
    const imageId = flavorOf(id)?.imageId;
    return imageId ? flavorImageUrl(imageId) : null;
  };
  const flavorsAt = menu.flavors.filter(
    (flavor) => index.flavorPrice(flavor.id, state.sizeId) !== undefined,
  );
  const crusts = menu.crusts.filter(
    (crust) => index.crustPrice(crust.id, state.sizeId) !== undefined,
  );
  const extras = menu.extras.filter(
    (extra) => index.extraPrice(extra.id, state.sizeId) !== undefined,
  );
  const removable = removableOf(builder, state.flavors[side]);
  const footer = footerState(result, addingDisabled);
  const row = {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: theme.spacing(2),
  };
  const pickFlavor = (id: string) => {
    const next = setFlavor(state, side, id);
    update(next);
    const after = sideAfterFlavor(state, side);
    if (after !== side) {
      setActive(after);
      announce(
        `${flavorOf(id)?.name ?? "Sabor"} na metade esquerda. Agora escolha o sabor da metade direita.`,
      );
    }
  };

  const steps = builderSteps(crusts.length > 0);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const current = steps[stepIndex]!;
  const last = stepIndex === steps.length - 1;
  const blocker = last
    ? null
    : blockerBefore(steps, steps[stepIndex + 1]!, result);
  const missing = blocker
    ? blocker.step === current
      ? blocker.message
      : `${STEP_LABELS[blocker.step]}: ${blocker.message}`
    : null;
  const goTo = (next: BuilderStep) => {
    setStep(next);
    scroll.current?.scrollTo({ y: 0, animated: false });
    announce(
      `Etapa ${steps.indexOf(next) + 1} de ${steps.length}: ${STEP_LABELS[next]}`,
    );
  };
  // Header arrow and Android's button: previous step, or leave asking first (`builderBack`).
  const stepBack = () =>
    runBuilderBack(
      builderBack(steps, current, builderChanged(initial.current, state)),
      { goTo, leave: onBack, confirm: confirmLeave },
    );
  back.current = stepBack;
  const priceText =
    footer.totalCents === null ? null : formatCents(footer.totalCents);
  const halfPicker = halves ? (
    <HalfPicker
      active={side}
      names={{
        LEFT: flavorOf(state.flavors.LEFT)?.name ?? null,
        RIGHT: flavorOf(state.flavors.RIGHT)?.name ?? null,
      }}
      onPick={setActive}
    />
  ) : null;

  return (
    <Screen
      scrollRef={scroll}
      header={
        <ScreenHeader
          title="Monte sua pizza"
          onBack={stepBack}
          backTo={
            stepIndex > 0 ? STEP_LABELS[steps[stepIndex - 1]!] : "Cardápio"
          }
        />
      }
      footer={
        <StickyFooter>
          {addError ? (
            <Body alert small>
              {addError}
            </Body>
          ) : null}
          {(last ? !footer.ready && footer.reason : missing) ? (
            <View
              style={{ flexDirection: "row", gap: 6, alignItems: "center" }}
            >
              <Icon
                name="information-circle"
                size={18}
                color={theme.colors.accentText}
              />
              <Text
                accessibilityLiveRegion="polite"
                style={{
                  flex: 1,
                  color: theme.colors.text,
                  fontSize: theme.typography.bodySmall.fontSize,
                  lineHeight: theme.typography.bodySmall.lineHeight,
                  fontWeight: "600",
                }}
              >
                {last ? footer.reason : missing}
              </Text>
            </View>
          ) : null}
          {last ? (
            <Button
              label={`Adicionar à sacola${priceText ? ` · ${priceText}` : ""}`}
              icon="bag-handle-outline"
              variant="primary"
              disabled={!footer.ready}
              accessibilityHint={footer.reason ?? undefined}
              onPress={() =>
                result.kind === "priced" && onAdd(result.configuration)
              }
              style={{ borderRadius: 999 }}
            />
          ) : (
            <Button
              label={`Continuar${priceText ? ` · ${priceText}` : ""}`}
              icon="arrow-forward"
              variant="primary"
              disabled={!!missing}
              accessibilityHint={missing ?? undefined}
              accessibilityLabel={`Continuar para ${STEP_LABELS[steps[stepIndex + 1]!]}${priceText ? `, total estimado ${priceText}` : ""}`}
              onPress={() => goTo(steps[stepIndex + 1]!)}
              style={{ borderRadius: 999 }}
            />
          )}
        </StickyFooter>
      }
      gap={theme.spacing(5)}
    >
      <Stepper
        steps={steps}
        current={stepIndex}
        canOpen={(target) => canOpenStep(steps, target, result)}
        onOpen={goTo}
      />

      {menuStale ? (
        <InlineMessage tone="warning">{MENU_STALE_NOTICE}</InlineMessage>
      ) : null}

      <View style={{ alignItems: "center", gap: theme.spacing(3) }}>
        <PizzaVisual
          mode={shown.mode}
          size={current === "flavors" || current === "size" ? 240 : 180}
          activeSide={halves && current !== "size" ? side : null}
          description={described.map((half) => half.text).join(" ")}
          leftImageUrl={flavorImage(shown.flavors.LEFT)}
          rightImageUrl={flavorImage(shown.flavors.RIGHT)}
        />
        <Text
          style={{
            textAlign: "center",
            color: theme.colors.textSecondary,
            fontSize: theme.typography.bodySmall.fontSize,
            lineHeight: theme.typography.bodySmall.lineHeight,
          }}
        >
          {describeOrderLine(builder, shown)}
        </Text>
      </View>

      {current === "size" ? (
        <Step title="Escolha o tamanho">
          <View accessibilityRole="radiogroup" style={row}>
            {menu.sizes.map((entry) => (
              <Choice
                key={entry.id}
                kind="radio"
                label={entry.name}
                detail={`${entry.slices} fatias${entry.maxFlavors === 1 ? " · 1 sabor" : ""}`}
                selected={entry.id === state.sizeId}
                onPress={() => pickSize(entry.id)}
              />
            ))}
          </View>
          {sizeChange ? (
            <InlineMessage
              tone="warning"
              action={
                <View style={row}>
                  {sizeChange.change.kind === "confirm" ? (
                    <Button
                      label="Trocar e remover"
                      variant="primary"
                      size="small"
                      onPress={() =>
                        sizeChange.change.kind === "confirm" &&
                        update(sizeChange.change.state)
                      }
                    />
                  ) : null}
                  <Button
                    label={`Manter ${size?.name ?? "o tamanho atual"}`}
                    size="small"
                    onPress={() => setSizeChange(null)}
                  />
                </View>
              }
            >
              {sizeChange.change.message}
            </InlineMessage>
          ) : null}
        </Step>
      ) : null}

      {current === "flavors" ? (
        <>
          <SegmentedControl
            options={[
              { value: "WHOLE", label: "Inteira" },
              { value: "HALVES", label: "Meio a meio" },
            ]}
            value={state.mode}
            disabled={size?.maxFlavors === 1 && !halves}
            onChange={(mode) => {
              update(setMode(state, mode));
              setActive(mode === "HALVES" ? "RIGHT" : "LEFT");
              if (mode === "HALVES")
                announce("Meio a meio. Escolha o sabor da metade direita.");
            }}
          />
          {size?.maxFlavors === 1 ? (
            <Body small muted>
              O tamanho {size.name} é de um sabor só.
            </Body>
          ) : null}
          {halfPicker}
          <Step
            title={
              halves ? `Escolha o sabor da ${sideName}` : "Escolha o sabor"
            }
          >
            <View
              accessibilityRole="radiogroup"
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: theme.spacing(3),
              }}
            >
              {flavorsAt.map((flavor) => {
                const price = formatCents(
                  index.flavorPrice(flavor.id, state.sizeId)!,
                );
                const selected = state.flavors[side] === flavor.id;
                const other =
                  halves &&
                  state.flavors[side === "LEFT" ? "RIGHT" : "LEFT"] ===
                    flavor.id;
                return (
                  <FlavorTile
                    key={flavor.id}
                    width={tileWidth}
                    name={flavor.name}
                    price={price}
                    imageUrl={flavorImage(flavor.id)}
                    selected={selected}
                    note={other ? "Na outra metade" : null}
                    accessibilityLabel={`${flavor.name}${halves ? ` na ${sideName}` : ""}, ${price}${flavor.description ? `. ${flavor.description}` : ""}`}
                    onPress={() => pickFlavor(flavor.id)}
                  />
                );
              })}
            </View>
          </Step>
        </>
      ) : null}

      {current === "crust" ? (
        <Step title="Escolha a borda" subtitle="Vale para a pizza inteira.">
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
        </Step>
      ) : null}

      {current === "extras" ? (
        <>
          {(extras.length && menu.pricingPolicy?.maxExtrasPerHalf) ||
          removable.length ? (
            <Step
              title={halves ? `Personalizar a ${sideName}` : "Personalizar"}
              subtitle={
                halves
                  ? "Um adicional nas duas metades é cobrado como pizza inteira."
                  : undefined
              }
            >
              {halfPicker}
              {extras.length && menu.pricingPolicy?.maxExtrasPerHalf ? (
                <View style={{ gap: theme.spacing(2) }}>
                  <Text style={subheading(theme)}>
                    Adicionais · até {menu.pricingPolicy.maxExtrasPerHalf} por{" "}
                    {halves ? "metade" : "pizza"}
                  </Text>
                  <View style={row}>
                    {extras.map((extra) => {
                      const price = index.extraPrice(extra.id, state.sizeId)!;
                      const amount = `+ ${formatCents(halves ? price.halfPriceCents : price.wholePriceCents)}`;
                      const selected = state.extras[side].includes(extra.id);
                      return (
                        <Choice
                          key={extra.id}
                          kind="checkbox"
                          label={extra.name}
                          detail={amount}
                          accessibilityLabel={`${extra.name} na ${sideName}, ${amount}`}
                          selected={selected}
                          disabled={
                            extraLimitReached(menu, state, side) && !selected
                          }
                          onPress={() =>
                            update(toggleExtra(state, side, extra.id))
                          }
                        />
                      );
                    })}
                  </View>
                </View>
              ) : null}
              {removable.length ? (
                <View style={{ gap: theme.spacing(2) }}>
                  <Text style={subheading(theme)}>Retirar ingredientes</Text>
                  <View style={row}>
                    {removable.map((ingredient) => (
                      <Choice
                        key={ingredient.id}
                        kind="checkbox"
                        label={`Sem ${ingredient.name.toLowerCase()}`}
                        accessibilityLabel={`Sem ${ingredient.name} na ${sideName}`}
                        selected={state.removals[side].includes(ingredient.id)}
                        onPress={() =>
                          update(toggleRemoval(state, side, ingredient.id))
                        }
                      />
                    ))}
                  </View>
                </View>
              ) : null}
            </Step>
          ) : null}

          <Step title="Quantidade">
            <QuantityStepper
              value={state.quantity}
              min={PIZZA_QUANTITY_MIN}
              max={PIZZA_QUANTITY_MAX}
              itemName="pizzas"
              onChange={(next) => update(setQuantity(state, next))}
            />
          </Step>

          <View
            style={[
              {
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.xl,
                padding: theme.spacing(4),
                gap: theme.spacing(2),
              },
              theme.shadow,
            ]}
          >
            <Heading level="h3">Resumo</Heading>
            {described.map((half) => (
              <View key={half.title} accessible accessibilityLabel={half.text}>
                <Text style={subheading(theme)}>{half.title}</Text>
                <Body>
                  {half.flavor}
                  {half.details.length ? ` · ${half.details.join(" · ")}` : ""}
                </Body>
              </View>
            ))}
            {result.kind === "priced" ? (
              <View
                style={{ gap: theme.spacing(1), marginTop: theme.spacing(2) }}
              >
                {priceLines(builder, result).map((line) => (
                  <View
                    key={line.label}
                    style={{ flexDirection: "row", gap: theme.spacing(3) }}
                  >
                    <View style={{ flex: 1 }}>
                      <Body small>{line.label}</Body>
                    </View>
                    <Body small>{line.amount}</Body>
                  </View>
                ))}
                <Body small muted>
                  {menuStale
                    ? "Calculado com o último cardápio carregado, que pode estar desatualizado. A pizzaria confirma o valor ao receber o pedido."
                    : "Valor estimado. A pizzaria confirma ao receber o pedido."}
                </Body>
              </View>
            ) : result.kind === "invalid" ? (
              result.messages.map((message) => (
                <Body key={message} alert small>
                  {message}
                </Body>
              ))
            ) : null}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const subheading = (theme: ReturnType<typeof useTheme>) => ({
  color: theme.colors.text,
  fontSize: theme.typography.body.fontSize,
  lineHeight: theme.typography.body.lineHeight,
  fontWeight: "700" as const,
});

/** A numbered step of the builder with its title read as a header. */
function Step({
  number,
  title,
  subtitle,
  children,
}: {
  number?: number;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(3) }}>
      <View style={{ gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.h3.fontSize,
            lineHeight: theme.typography.h3.lineHeight,
            fontWeight: "800",
          }}
        >
          {number ? `${number}. ` : ""}
          {title}
        </Text>
        {subtitle ? (
          <Body small muted>
            {subtitle}
          </Body>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/**
 * Which half the controls below edit. Each option names its half, its flavor (or "escolher") and
 * carries a check mark when chosen; the edited one is raised. VoiceOver reads them as radio buttons.
 */
function HalfPicker({
  active,
  names,
  onPick,
}: {
  active: HalfSide;
  names: Record<HalfSide, string | null>;
  onPick: (side: HalfSide) => void;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{ flexDirection: "row", gap: theme.spacing(3) }}
    >
      {(["LEFT", "RIGHT"] as const).map((side) => {
        const selected = side === active;
        const flavor = names[side];
        return (
          <Pressable
            key={side}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={`Editar ${SIDE_NAMES[side].toLowerCase()}: ${flavor ?? "sabor a escolher"}`}
            onPress={() => onPick(side)}
            style={{
              flex: 1,
              minHeight: 52,
              paddingHorizontal: theme.spacing(4),
              paddingVertical: theme.spacing(2),
              borderRadius: theme.radius.pill,
              borderWidth: selected ? 2 : 1,
              borderColor: selected
                ? theme.colors.primary
                : theme.colors.border,
              backgroundColor: selected
                ? theme.colors.primaryLight
                : theme.colors.surface,
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing(2),
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: theme.colors.accentText,
                  fontSize: 11,
                  lineHeight: 14,
                  fontWeight: "800",
                }}
              >
                {selected ? "EDITANDO · " : ""}
                {side === "LEFT" ? "ESQUERDA" : "DIREITA"}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: flavor
                    ? theme.colors.text
                    : theme.colors.textSecondary,
                  fontSize: theme.typography.bodySmall.fontSize,
                  lineHeight: theme.typography.bodySmall.lineHeight,
                  fontWeight: "700",
                }}
              >
                {flavor ?? "Escolher sabor"}
              </Text>
            </View>
            <Icon
              name={selected ? "create-outline" : "chevron-down"}
              size={18}
              color={theme.colors.accentText}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** One flavor in the grid: photo, name and price; a check badge marks the chosen one. */
function FlavorTile({
  width,
  name,
  price,
  imageUrl,
  selected,
  note,
  accessibilityLabel,
  onPress,
}: {
  width: number;
  name: string;
  price: string;
  imageUrl: string | null;
  selected: boolean;
  /** The flavor is on the other half. */
  note: string | null;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const photo = width - 2 * theme.spacing(2);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={
        note ? `${accessibilityLabel}. ${note}` : accessibilityLabel
      }
      onPress={onPress}
      style={({ pressed }) => [
        {
          width,
          padding: theme.spacing(2),
          gap: theme.spacing(1),
          borderRadius: theme.radius.large,
          borderWidth: 2,
          borderColor: selected ? theme.colors.primary : "transparent",
          backgroundColor: selected
            ? theme.colors.primaryLight
            : pressed
              ? theme.colors.surfaceSecondary
              : theme.colors.surface,
          alignItems: "center",
        },
        selected ? null : theme.shadow,
      ]}
    >
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          accessible={false}
          accessibilityIgnoresInvertColors
          style={{ width: photo, height: photo, borderRadius: photo / 2 }}
        />
      ) : (
        <View
          style={{
            width: photo,
            height: photo,
            borderRadius: photo / 2,
            backgroundColor: theme.colors.primaryLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name="pizza-outline"
            size={photo * 0.42}
            color={theme.colors.accentText}
          />
        </View>
      )}
      <Text
        numberOfLines={2}
        style={{
          textAlign: "center",
          color: theme.colors.text,
          fontSize: theme.typography.bodySmall.fontSize,
          lineHeight: 18,
          fontWeight: "700",
        }}
      >
        {name}
      </Text>
      <Text
        style={{
          textAlign: "center",
          color: theme.colors.textSecondary,
          fontSize: theme.typography.caption.fontSize,
          lineHeight: theme.typography.caption.lineHeight,
        }}
      >
        {note ?? price}
      </Text>
      {selected ? (
        // Check badge: the choice does not rely on the border color alone.
        <View
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 24,
            height: 24,
            borderRadius: 12,
            backgroundColor: theme.colors.primary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="checkmark" size={16} color={theme.colors.onPrimary} />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * The steps on top of the builder: done ones carry a check, the current one is filled and
 * numbered, the next ones are gray. A step opens with a tap once the ones before it are ready.
 */
function Stepper({
  steps,
  current,
  canOpen,
  onOpen,
}: {
  steps: BuilderStep[];
  current: number;
  canOpen: (step: BuilderStep) => boolean;
  onOpen: (step: BuilderStep) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      {steps.map((step, index) => {
        const done = index < current;
        const here = index === current;
        const open = !here && canOpen(step);
        return (
          <View key={step} style={{ flex: 1, alignItems: "center" }}>
            {index > 0 ? (
              <View
                style={{
                  position: "absolute",
                  top: 15,
                  right: "50%",
                  width: "100%",
                  height: 2,
                  backgroundColor:
                    index <= current
                      ? theme.colors.primary
                      : theme.colors.border,
                }}
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Etapa ${index + 1} de ${steps.length}: ${STEP_LABELS[step]}${done ? ", concluída" : here ? ", atual" : ""}`}
              accessibilityState={{ selected: here, disabled: !open && !here }}
              disabled={!open}
              onPress={() => onOpen(step)}
              // Above the connector line on every platform.
              style={{
                alignItems: "center",
                minHeight: 44,
                gap: 4,
                position: "relative",
                zIndex: 1,
              }}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor:
                    done || here ? theme.colors.primary : theme.colors.surface,
                  borderWidth: done || here ? 0 : 2,
                  borderColor: theme.colors.border,
                }}
              >
                {done ? (
                  <Icon
                    name="checkmark"
                    size={18}
                    color={theme.colors.onPrimary}
                  />
                ) : (
                  <Text
                    style={{
                      color: here
                        ? theme.colors.onPrimary
                        : theme.colors.textSecondary,
                      fontSize: 14,
                      fontWeight: "800",
                    }}
                  >
                    {index + 1}
                  </Text>
                )}
              </View>
              <Text
                style={{
                  color:
                    done || here
                      ? theme.colors.accentText
                      : theme.colors.textSecondary,
                  ...theme.typography.caption,
                  fontWeight: here ? "800" : "600",
                }}
              >
                {STEP_LABELS[step]}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
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
