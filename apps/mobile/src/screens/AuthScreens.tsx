import {
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  BackHandler,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LegalDocument } from "@whiteoven/contracts";
import { announce } from "../a11y/useAnnouncement.ts";
import { useReducedMotion } from "../a11y/useReducedMotion.ts";
import { useTheme } from "../brand/theme.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button, Field } from "../components/Form.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import { LegalSheet } from "../components/LegalSheet.tsx";
import { Screen, StickyFooter } from "../components/Screen.tsx";
import { PAGE_GUTTER } from "../components/layout.ts";
import {
  type AuthStack,
  type AuthStep,
  WELCOME_SLIDES,
  authBack,
  authForward,
  brandNameParts,
  slideAt,
} from "../customer/auth-flow.ts";
import {
  type AuthErrors,
  type AuthField,
  type AuthMode,
  errorSummary,
  firstError,
  passwordRules,
  validateAuthForm,
} from "../customer/auth-form.ts";
import {
  acceptedVersions,
  type LegalState,
  type StoreLegal,
} from "../customer/legal.ts";
import { normalizeCustomerPhone } from "../customer/registration.ts";

type InputRef = ComponentRef<typeof TextInput>;

// ----- Shared pieces -----

/**
 * The store's mark over its name, in two tones. Never WhiteOven's: the app is the store's (ADR
 * 0020). Without a logo, a pizza drawn in the store's colors stands in.
 */
export function BrandMark({
  name,
  logoUrl,
  compact = false,
}: {
  name: string;
  logoUrl: string | null;
  compact?: boolean;
}) {
  const theme = useTheme();
  const { lead, tail } = brandNameParts(name);
  const mark = compact ? 56 : 72;
  return (
    <View style={{ alignItems: "center", gap: theme.spacing(2) }}>
      {logoUrl ? (
        <Image
          source={{ uri: logoUrl }}
          accessible={false}
          resizeMode="contain"
          style={{ width: mark, height: mark, borderRadius: mark / 4 }}
        />
      ) : (
        <View
          accessible={false}
          style={{
            width: mark,
            height: mark,
            borderRadius: mark / 2,
            backgroundColor: theme.colors.primaryLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name="pizza-outline"
            size={mark * 0.55}
            color={theme.colors.accentText}
          />
        </View>
      )}
      <Text
        accessibilityRole="header"
        accessibilityLabel={name}
        numberOfLines={2}
        style={{
          color: theme.colors.text,
          fontSize: compact ? 26 : 30,
          lineHeight: compact ? 32 : 36,
          fontWeight: "800",
          textAlign: "center",
          letterSpacing: -0.5,
        }}
      >
        {lead}
        {tail ? (
          <Text style={{ color: theme.colors.accentText }}>{tail}</Text>
        ) : null}
      </Text>
    </View>
  );
}

/** The bar on top of the signed-out screens: back on the left, an action on the right. */
function AuthHeader({
  onBack,
  backTo,
  backDisabled,
  right,
}: {
  onBack?: () => void;
  backTo?: string | null;
  backDisabled?: boolean;
  right?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing(1),
        paddingLeft: theme.spacing(2) + insets.left,
        paddingRight: theme.spacing(2) + insets.right,
        minHeight: insets.top + 52,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      {/* The soft brand shape in the corner, as on the mockup. Decorative. */}
      <View
        pointerEvents="none"
        accessible={false}
        style={{
          position: "absolute",
          top: -140,
          right: -110,
          width: 260,
          height: 260,
          borderRadius: 130,
          backgroundColor: theme.colors.primaryLight,
        }}
      />
      {onBack ? (
        <IconButton
          name="arrow-back"
          size={26}
          accessibilityLabel={backTo ? `Voltar para ${backTo}` : "Voltar"}
          disabled={backDisabled}
          onPress={onBack}
        />
      ) : (
        <View />
      )}
      {right ?? <View />}
    </View>
  );
}

/** A tappable word inside a sentence, such as "Criar conta gratuita". At least 44 pt tall. */
function TextLink({
  label,
  onPress,
  disabled = false,
  underline = true,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  underline?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          color: theme.colors.accentText,
          fontSize: theme.typography.body.fontSize,
          lineHeight: theme.typography.body.lineHeight,
          fontWeight: "700",
          textDecorationLine: underline ? "underline" : "none",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Title({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(2), alignItems: "center" }}>
      <Text
        accessibilityRole="header"
        style={{
          color: theme.colors.text,
          fontSize: theme.typography.h1.fontSize,
          lineHeight: theme.typography.h1.lineHeight,
          fontWeight: "800",
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      <Body muted centered>
        {subtitle}
      </Body>
    </View>
  );
}

/** "Ainda não tem conta? Criar conta gratuita", centered under the form. */
function SwitchPrompt({
  question,
  action,
  onPress,
  disabled,
}: {
  question: string;
  action: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: 6,
      }}
    >
      <Body muted>{question}</Body>
      <TextLink label={action} onPress={onPress} disabled={disabled} />
    </View>
  );
}

const pill = { borderRadius: 999 };

// ----- Welcome -----

/** A pizza drawn in Views for the welcome, when the store has no photo to show. Decorative. */
function DrawnPizza({ size }: { size: number }) {
  const toppings = [
    [0.3, 0.28],
    [0.58, 0.22],
    [0.68, 0.5],
    [0.42, 0.52],
    [0.24, 0.62],
    [0.55, 0.74],
    [0.75, 0.3],
  ];
  const dot = size * 0.13;
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: "#E9A65E",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: size * 0.86,
          height: size * 0.86,
          borderRadius: size * 0.43,
          backgroundColor: "#F6C453",
          borderWidth: size * 0.025,
          borderColor: "#D9481C",
        }}
      />
      {toppings.map(([x, y], index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            left: size * x! - dot / 2 + size * 0.05,
            top: size * y! - dot / 2 + size * 0.05,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: "#B3261E",
          }}
        />
      ))}
    </View>
  );
}

function WelcomeHero({
  width,
  imageUrl,
}: {
  width: number;
  imageUrl: string | null;
}) {
  const theme = useTheme();
  const height = Math.min(260, Math.round(width * 0.72));
  const pizza = Math.round(height * 1.02);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width, height, overflow: "hidden", borderRadius: 28 }}
    >
      <View
        style={{
          position: "absolute",
          left: -width * 0.15,
          top: height * 0.32,
          width: width * 1.3,
          height: width * 1.3,
          borderRadius: width * 0.65,
          backgroundColor: theme.colors.primary,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: -pizza * 0.18,
          top: (height - pizza) / 2 + 6,
        }}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            accessible={false}
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            style={{
              width: pizza,
              height: pizza,
              borderRadius: pizza / 2,
              borderWidth: 6,
              borderColor: theme.colors.surface,
            }}
          />
        ) : (
          <DrawnPizza size={pizza} />
        )}
      </View>
    </View>
  );
}

export function WelcomeScreen({
  storeName,
  logoUrl,
  heroImageUrl,
  onRegister,
  onLogin,
  onSkip,
  disabled,
  problems,
}: {
  storeName: string;
  logoUrl: string | null;
  /** A photo of one of the store's pizzas, when the menu has one. */
  heroImageUrl: string | null;
  onRegister: () => void;
  onLogin: () => void;
  /** Browse the menu signed out; absent when the welcome was opened from the profile tab. */
  onSkip?: () => void;
  disabled: boolean;
  problems: ReactNode;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = window.width - 2 * PAGE_GUTTER - insets.left - insets.right;
  const [slide, setSlide] = useState(0);
  const carousel = useRef<ComponentRef<typeof ScrollView>>(null);
  const goTo = (index: number) => {
    setSlide(index);
    carousel.current?.scrollTo({ x: index * width, animated: !reduceMotion });
  };
  return (
    <Screen
      gap={theme.spacing(5)}
      header={
        <AuthHeader
          right={
            onSkip ? (
              <Button
                label="Ver cardápio"
                variant="ghost"
                size="small"
                accessibilityHint="Abre o cardápio sem entrar na conta"
                onPress={onSkip}
              />
            ) : undefined
          }
        />
      }
      footer={
        <StickyFooter>
          <Button
            label="Criar conta gratuita"
            variant="primary"
            disabled={disabled}
            onPress={onRegister}
            style={pill}
          />
          <Button
            label="Entrar na minha conta"
            variant="outline"
            disabled={disabled}
            onPress={onLogin}
            style={pill}
          />
        </StickyFooter>
      }
    >
      <BrandMark name={storeName} logoUrl={logoUrl} />
      {problems}
      <View style={{ gap: theme.spacing(4) }}>
        <ScrollView
          ref={carousel}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={32}
          onMomentumScrollEnd={(event) =>
            setSlide(
              slideAt(
                event.nativeEvent.contentOffset.x,
                width,
                WELCOME_SLIDES.length,
              ),
            )
          }
        >
          {WELCOME_SLIDES.map((item, index) => (
            <View
              key={index}
              style={{ width, gap: theme.spacing(4) }}
              accessible
              accessibilityLabel={`${item.title}${item.highlight}. ${item.body} Destaque ${index + 1} de ${WELCOME_SLIDES.length}.`}
            >
              <Text
                style={{
                  color: theme.colors.text,
                  fontSize: theme.typography.display.fontSize,
                  lineHeight: theme.typography.display.lineHeight,
                  fontWeight: "800",
                  letterSpacing: -0.5,
                }}
              >
                {item.title}
                <Text style={{ color: theme.colors.accentText }}>
                  {item.highlight}
                </Text>
              </Text>
              <Body muted>{item.body}</Body>
              <WelcomeHero width={width} imageUrl={heroImageUrl} />
            </View>
          ))}
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
          }}
        >
          {WELCOME_SLIDES.map((_, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={`Mostrar destaque ${index + 1} de ${WELCOME_SLIDES.length}`}
              accessibilityState={{ selected: slide === index }}
              onPress={() => goTo(index)}
              style={{
                width: 32,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View
                style={{
                  width: slide === index ? 20 : 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor:
                    slide === index
                      ? theme.colors.primary
                      : theme.colors.border,
                }}
              />
            </Pressable>
          ))}
        </View>
      </View>
    </Screen>
  );
}

// ----- E-mail confirmation -----

/** An envelope with a check, in the store's colors. Decorative. */
function EnvelopeArt() {
  const theme = useTheme();
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: 168, height: 150, alignItems: "center" }}
    >
      <View
        style={{
          position: "absolute",
          bottom: 0,
          width: 160,
          height: 104,
          borderRadius: 18,
          backgroundColor: theme.colors.primary,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 4,
          width: 120,
          height: 108,
          borderRadius: 12,
          backgroundColor: theme.colors.surface,
          alignItems: "center",
          justifyContent: "center",
          ...theme.shadow,
        }}
      >
        <Icon name="checkmark-circle" size={52} color={theme.colors.success} />
      </View>
      <View
        style={{
          position: "absolute",
          bottom: 0,
          width: 160,
          height: 58,
          borderBottomLeftRadius: 18,
          borderBottomRightRadius: 18,
          backgroundColor: theme.colors.primaryHover,
        }}
      />
    </View>
  );
}

/**
 * "Confirme seu e-mail". The API does not send a confirmation link yet (sign-up signs the customer
 * in at once, ADR 0017), so the flow does not open this screen; it is ready for when it does.
 */
export function ConfirmEmailScreen({
  email,
  onOpenMail,
  onResend,
  onBack,
  resendDisabled = false,
}: {
  email: string;
  onOpenMail: () => void;
  onResend: () => void;
  onBack?: () => void;
  resendDisabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Screen
      header={<AuthHeader onBack={onBack} />}
      contentStyle={{ alignItems: "center", paddingTop: theme.spacing(6) }}
    >
      <EnvelopeArt />
      <Title
        title="Confirme seu e-mail"
        subtitle={
          <>
            Enviamos um link de confirmação para{" "}
            <Text style={{ color: theme.colors.text, fontWeight: "700" }}>
              {email}
            </Text>
            . Clique no link para ativar sua conta.
          </>
        }
      />
      <Button
        label="Abrir meu e-mail"
        variant="outline"
        icon="open-outline"
        onPress={onOpenMail}
        style={{ ...pill, alignSelf: "stretch" }}
      />
      <View style={{ alignItems: "center" }}>
        <Body muted>Não recebeu o e-mail?</Body>
        <TextLink
          label="Reenviar link"
          onPress={onResend}
          disabled={resendDisabled}
        />
      </View>
    </Screen>
  );
}

// ----- Sign-in and sign-up -----

function SocialButtons({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: (provider: "Google" | "Apple") => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(3) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }}
        />
        <Body muted small>
          ou continue com
        </Body>
        <View
          style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }}
        />
      </View>
      <Button
        label="Google"
        accessibilityLabel="Continuar com Google"
        icon="logo-google"
        variant="neutral"
        disabled={disabled}
        onPress={() => onPress("Google")}
        style={pill}
      />
      <Button
        label="Apple"
        accessibilityLabel="Continuar com Apple"
        icon="logo-apple"
        variant="neutral"
        disabled={disabled}
        onPress={() => onPress("Apple")}
        style={pill}
      />
    </View>
  );
}

/** The live checklist under the new password. Each line says whether it is met, also in words. */
function PasswordChecklist({ password }: { password: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4, marginTop: -4, paddingHorizontal: 4 }}>
      {passwordRules(password).map((rule) => (
        <View
          key={rule.id}
          accessible
          accessibilityLabel={`${rule.label}: ${rule.met ? "atendido" : "pendente"}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Icon
            name={rule.met ? "checkmark-circle" : "ellipse-outline"}
            size={18}
            color={rule.met ? theme.colors.success : theme.colors.textSecondary}
          />
          <Text
            style={{
              color: rule.met
                ? theme.colors.success
                : theme.colors.textSecondary,
              fontSize: theme.typography.bodySmall.fontSize,
              lineHeight: theme.typography.bodySmall.lineHeight,
              fontWeight: rule.met ? "600" : "400",
            }}
          >
            {rule.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** "Aceito os Termos de Uso e a Política de Privacidade", with each document one tap away. */
function LegalConsent({
  legal,
  accepted,
  error,
  disabled,
  onToggle,
  onOpen,
  onReload,
}: {
  legal: LegalState;
  accepted: boolean;
  error?: string;
  disabled: boolean;
  onToggle: () => void;
  onOpen: (title: string, document: LegalDocument) => void;
  onReload: () => void;
}) {
  const theme = useTheme();
  if (legal.status === "loading")
    return (
      <InlineMessage tone="info">
        Carregando os termos de uso e a política de privacidade…
      </InlineMessage>
    );
  if (legal.status !== "ready")
    return (
      <InlineMessage
        tone="error"
        title={
          legal.status === "unavailable"
            ? "Cadastro indisponível"
            : "Termos não carregados"
        }
        action={
          <Button
            label="Tentar carregar de novo"
            size="small"
            disabled={disabled}
            onPress={onReload}
          />
        }
      >
        {legal.status === "unavailable"
          ? "O cadastro fica disponível quando a loja publicar os termos de uso e a política de privacidade."
          : "Não foi possível carregar os termos de uso e a política de privacidade."}
      </InlineMessage>
    );
  const link = (label: string, title: string, document: LegalDocument) => (
    <Text
      accessibilityRole="link"
      accessibilityHint="Abre o documento"
      onPress={() => onOpen(title, document)}
      suppressHighlighting={false}
      style={{
        color: theme.colors.accentText,
        fontWeight: "700",
        textDecorationLine: "underline",
      }}
    >
      {label}
    </Text>
  );
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel="Aceito os termos de uso e a política de privacidade"
          accessibilityHint={error}
          accessibilityState={{ checked: accepted, disabled }}
          disabled={disabled}
          onPress={onToggle}
          hitSlop={4}
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: -8,
          }}
        >
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              borderWidth: 2,
              borderColor: error
                ? theme.colors.error
                : accepted
                  ? theme.colors.primary
                  : theme.colors.inputBorder,
              backgroundColor: accepted
                ? theme.colors.primary
                : theme.colors.surface,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {accepted ? (
              <Icon name="checkmark" size={18} color={theme.colors.onPrimary} />
            ) : null}
          </View>
        </Pressable>
        <Text
          style={{
            flex: 1,
            color: theme.colors.text,
            fontSize: theme.typography.bodySmall.fontSize,
            lineHeight: 22,
          }}
        >
          Aceito os{" "}
          {link("Termos de Uso", "Termos de uso", legal.legal.termsOfUse)} e a{" "}
          {link(
            "Política de Privacidade",
            "Política de privacidade",
            legal.legal.privacyPolicy,
          )}
          .
        </Text>
      </View>
      {error ? (
        <Body alert small>
          {error}
        </Body>
      ) : null}
    </View>
  );
}

const sameVersions = (a: LegalState, b: LegalState) =>
  a.status === "ready" &&
  b.status === "ready" &&
  a.legal.privacyPolicy.version === b.legal.privacyPolicy.version &&
  a.legal.termsOfUse.version === b.legal.termsOfUse.version;

/**
 * The signed-out screens of the account (welcome, sign-in, sign-up). The rules stay those of ADR
 * 0017 and ADR 0030: e-mail and password, the API decides, and sign-up sends the versions of the
 * terms and privacy policy the customer was shown.
 */
export function AuthFlow({
  model,
  state,
  initial,
  legal,
  storeName,
  logoUrl,
  heroImageUrl,
  backTo,
  notice,
  problems,
  onReloadLegal,
  onExit,
  onSkip,
}: {
  model: CommerceModel;
  state: CommerceState;
  initial: AuthStep;
  legal: LegalState;
  storeName: string;
  logoUrl: string | null;
  heroImageUrl: string | null;
  /** The screen the first step's back button returns to, such as "Sacola". */
  backTo: string | null;
  notice?: string | null;
  /** Problems opening the saved data or session, with their retry buttons. */
  problems: ReactNode;
  onReloadLegal: () => Promise<LegalState>;
  /** Closes the flow from its first step; absent when there is nowhere to go back to. */
  onExit?: () => void;
  /** On the welcome: browse the menu without an account. */
  onSkip?: () => void;
}) {
  const theme = useTheme();
  const [stack, setStack] = useState<AuthStack>([initial]);
  const step = stack[stack.length - 1]!;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<AuthErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [openDocument, setOpenDocument] = useState<{
    title: string;
    document: LegalDocument;
  } | null>(null);
  const refs = {
    name: useRef<InputRef>(null),
    phone: useRef<InputRef>(null),
    email: useRef<InputRef>(null),
    password: useRef<InputRef>(null),
  };
  const disabled = state.busy || !state.ready;
  const legalReady = legal.status === "ready";
  const mode: AuthMode = step === "register" ? "register" : "login";
  const values = { name, phone, email, password, accepted };

  // Sign-up needs the store's current terms (ADR 0030): read them when the form opens.
  useEffect(() => {
    if (step === "register" && legal.status !== "ready") void onReloadLegal();
  }, [step]);

  const go = (next: AuthStep) => {
    setStack((current) => authForward(current, next));
    setPassword("");
    setErrors({});
    setSubmitted(false);
    setInfo(null);
  };
  const back = () => {
    const previous = authBack(stack);
    setPassword("");
    setErrors({});
    setSubmitted(false);
    setInfo(null);
    if (previous) setStack(previous);
    else onExit?.();
  };
  const canGoBack = stack.length > 1 || !!onExit;
  // Android's back button walks the flow first; from its first step the app decides.
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    if (stack.length < 2) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (!state.busy) backRef.current();
        return true;
      },
    );
    return () => subscription.remove();
  }, [stack.length, state.busy]);
  const backLabel = stack.length > 1 ? null : backTo;

  // After the first submit, errors follow the typing, so a fixed field loses its message.
  const revalidate = (patch: Partial<typeof values>) => {
    if (submitted)
      setErrors(validateAuthForm(mode, { ...values, ...patch }, legalReady));
  };
  const submit = async () => {
    setSubmitted(true);
    setInfo(null);
    const found = validateAuthForm(mode, values, legalReady);
    setErrors(found);
    const first = firstError(found);
    if (first) {
      announce(errorSummary(found)!);
      if (first !== "legal")
        refs[first as Exclude<AuthField, "legal">].current?.focus();
      return;
    }
    const body =
      mode === "login"
        ? { email: email.trim(), password }
        : {
            name: name.trim(),
            email: email.trim(),
            password,
            phone: normalizeCustomerPhone(phone),
            ...acceptedVersions((legal as { legal: StoreLegal }).legal),
          };
    setPassword("");
    const ok = await model.signIn(mode, body);
    // A new version published meanwhile (409 LEGAL_VERSION_OUTDATED) must be read again.
    if (!ok && mode === "register") {
      const fresh = await onReloadLegal();
      if (!sameVersions(fresh, legal)) setAccepted(false);
    }
  };
  const explain = (message: string) => {
    setInfo(message);
    announce(message);
  };

  const sheet = (
    <LegalSheet
      title={openDocument?.title ?? ""}
      document={openDocument?.document ?? null}
      onClose={() => setOpenDocument(null)}
    />
  );
  const header = (
    <AuthHeader
      onBack={canGoBack ? back : undefined}
      backTo={backLabel}
      backDisabled={state.busy}
    />
  );
  const messages = (
    <>
      {notice ? <InlineMessage tone="info">{notice}</InlineMessage> : null}
      {problems}
      {info ? <InlineMessage tone="info">{info}</InlineMessage> : null}
      {state.error ? (
        <InlineMessage tone="error">{state.error}</InlineMessage>
      ) : null}
    </>
  );

  if (step === "welcome")
    return (
      <WelcomeScreen
        storeName={storeName}
        logoUrl={logoUrl}
        heroImageUrl={heroImageUrl}
        disabled={disabled}
        problems={problems}
        onRegister={() => go("register")}
        onLogin={() => go("login")}
        onSkip={onSkip}
      />
    );

  if (step === "confirm-email")
    return (
      <ConfirmEmailScreen
        email={email.trim()}
        onBack={back}
        onOpenMail={() =>
          explain("Abra o aplicativo de e-mail do celular para ver o link.")
        }
        onResend={() => explain("O reenvio do link ainda não está disponível.")}
      />
    );

  if (step === "login")
    return (
      <Screen keyboard header={header} gap={theme.spacing(4)}>
        <BrandMark name={storeName} logoUrl={logoUrl} compact />
        <Title
          title="Entrar na sua conta"
          subtitle="Acesse seu perfil e continue pedindo suas pizzas favoritas."
        />
        {messages}
        <Field
          ref={refs.email}
          inlineLabel
          icon="mail-outline"
          label="E-mail"
          value={email}
          error={errors.email}
          onChangeText={(value) => {
            setEmail(value);
            revalidate({ email: value });
          }}
          autoComplete="email"
          textContentType="username"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          maxLength={254}
          returnKeyType="next"
          onSubmitEditing={() => refs.password.current?.focus()}
          editable={!disabled}
        />
        <Field
          ref={refs.password}
          inlineLabel
          icon="lock-closed-outline"
          label="Senha"
          value={password}
          error={errors.password}
          onChangeText={(value) => {
            setPassword(value);
            revalidate({ password: value });
          }}
          password
          textContentType="password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={256}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!disabled}
        />
        <View style={{ alignItems: "flex-end", marginTop: -8 }}>
          <TextLink
            label="Esqueceu sua senha?"
            underline={false}
            disabled={disabled}
            onPress={() =>
              explain(
                `A recuperação de senha pelo app ainda não está disponível. Fale com ${storeName} para recuperar o acesso.`,
              )
            }
          />
        </View>
        <Button
          label="Entrar"
          variant="primary"
          loading={state.busy}
          disabled={disabled}
          onPress={() => void submit()}
          style={pill}
        />
        <SocialButtons
          disabled={disabled}
          // The API has no Google or Apple sign-in yet (customer accounts are e-mail and
          // password, ADR 0017): the buttons are drawn and say so until it does.
          onPress={(provider) =>
            explain(
              `Entrar com ${provider} ainda não está disponível. Use seu e-mail e senha.`,
            )
          }
        />
        <SwitchPrompt
          question="Ainda não tem conta?"
          action="Criar conta gratuita"
          disabled={state.busy}
          onPress={() => go("register")}
        />
      </Screen>
    );

  // step === "register"
  return (
    <Screen keyboard header={header} gap={theme.spacing(3)}>
      {sheet}
      <BrandMark name={storeName} logoUrl={logoUrl} compact />
      <Title
        title="Criar sua conta"
        subtitle="É rápido e grátis. Faça seu cadastro para começar a pedir."
      />
      {messages}
      <Field
        ref={refs.name}
        inlineLabel
        icon="person-outline"
        label="Nome completo"
        value={name}
        error={errors.name}
        onChangeText={(value) => {
          setName(value);
          revalidate({ name: value });
        }}
        maxLength={120}
        autoComplete="name"
        textContentType="name"
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => refs.email.current?.focus()}
        editable={!disabled}
      />
      <Field
        ref={refs.email}
        inlineLabel
        icon="mail-outline"
        label="E-mail"
        value={email}
        error={errors.email}
        onChangeText={(value) => {
          setEmail(value);
          revalidate({ email: value });
        }}
        autoComplete="email"
        textContentType="emailAddress"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        maxLength={254}
        returnKeyType="next"
        onSubmitEditing={() => refs.phone.current?.focus()}
        editable={!disabled}
      />
      <Field
        ref={refs.phone}
        inlineLabel
        icon="call-outline"
        label="Celular (opcional)"
        value={phone}
        error={errors.phone}
        onChangeText={(value) => {
          setPhone(value);
          revalidate({ phone: value });
        }}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        autoComplete="tel"
        helper={
          phone
            ? "Com DDD. A pizzaria usa para falar sobre o pedido."
            : undefined
        }
        maxLength={24}
        doneBar={Platform.OS === "ios"}
        returnKeyType="next"
        onSubmitEditing={() => refs.password.current?.focus()}
        editable={!disabled}
      />
      <Field
        ref={refs.password}
        inlineLabel
        icon="lock-closed-outline"
        label="Senha"
        value={password}
        error={errors.password}
        onChangeText={(value) => {
          setPassword(value);
          revalidate({ password: value });
        }}
        password
        textContentType="newPassword"
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={256}
        returnKeyType="done"
        editable={!disabled}
      />
      <PasswordChecklist password={password} />
      <LegalConsent
        legal={legal}
        accepted={accepted}
        error={errors.legal}
        disabled={disabled}
        onToggle={() => {
          setAccepted(!accepted);
          revalidate({ accepted: !accepted });
        }}
        onOpen={(title, document) => setOpenDocument({ title, document })}
        onReload={() => void onReloadLegal()}
      />
      <Button
        label="Criar conta"
        variant="primary"
        loading={state.busy}
        disabled={disabled}
        onPress={() => void submit()}
        style={pill}
      />
      <SwitchPrompt
        question="Já tem uma conta?"
        action="Entrar"
        disabled={state.busy}
        onPress={() => go("login")}
      />
    </Screen>
  );
}
