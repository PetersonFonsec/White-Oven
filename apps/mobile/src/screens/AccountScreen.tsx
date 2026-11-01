import {
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { Alert, Image, Linking, Text, TextInput, View } from "react-native";
import type { LegalDocument } from "@whiteoven/contracts";
import { announce } from "../a11y/useAnnouncement.ts";
import { useTheme } from "../brand/theme.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { Choice } from "../components/Choice.tsx";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button, Field, FormPage } from "../components/Form.tsx";
import { IconButton } from "../components/Icon.tsx";
import { LegalSheet } from "../components/LegalSheet.tsx";
import { ListRow, Section } from "../components/ListRow.tsx";
import { ScreenHeader, StickyFooter } from "../components/Screen.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import {
  type AuthErrors,
  type AuthField,
  type AuthMode,
  PASSWORD_MIN,
  errorSummary,
  firstError,
  validateAuthForm,
} from "../customer/auth-form.ts";
import type { Address } from "../customer/client.ts";
import {
  acceptedVersions,
  type LegalState,
  type StoreLegal,
} from "../customer/legal.ts";
import type { PushModel } from "../customer/push.ts";
import { normalizeCustomerPhone } from "../customer/registration.ts";

type InputRef = ComponentRef<typeof TextInput>;

const emptyAddress: Omit<Address, "id"> = {
  label: "Casa",
  postalCode: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  state: "",
  reference: "",
};
/** Address fields with what iOS needs to offer the saved address (AutoFill). */
const addressFields = [
  {
    key: "label",
    label: "Nome do endereço",
    max: 40,
    helper: "Ex.: Casa, Trabalho",
  },
  {
    key: "postalCode",
    label: "CEP",
    max: 9,
    content: "postalCode",
    auto: "postal-code",
    keyboard: "number-pad",
  },
  {
    key: "street",
    label: "Rua",
    max: 120,
    content: "streetAddressLine1",
    auto: "address-line1",
  },
  {
    key: "number",
    label: "Número",
    max: 20,
    keyboard: "numbers-and-punctuation",
  },
  {
    key: "complement",
    label: "Complemento (opcional)",
    max: 60,
    content: "streetAddressLine2",
    auto: "address-line2",
  },
  { key: "district", label: "Bairro", max: 80, content: "sublocality" },
  { key: "city", label: "Cidade", max: 80, content: "addressCity" },
  {
    key: "state",
    label: "UF",
    max: 2,
    content: "addressState",
    caps: "characters",
  },
  {
    key: "reference",
    label: "Referência (opcional)",
    max: 120,
    helper: "Ajuda o entregador a achar o endereço.",
  },
] as const;

const addressLine = (address: Omit<Address, "id">) =>
  [
    `${address.street}, ${address.number}${address.complement ? `, ${address.complement}` : ""}`,
    address.district,
    `${address.city}/${address.state}`,
    address.postalCode,
  ].join(" · ");

/**
 * Order notifications of this device (M5.5, ADR 0027): off until the customer turns them on here;
 * the permission prompt appears only after that tap.
 */
function OrderNotifications({
  push,
  disabled,
}: {
  push: PushModel;
  disabled: boolean;
}) {
  const state = useSyncExternalStore(push.subscribe, push.getSnapshot);
  const busy = disabled || state.busy;
  if (state.status === "unavailable")
    return (
      <Section title="Avisos do pedido">
        <ListRow
          first
          icon="notifications-outline"
          title="Indisponíveis nesta versão do app"
        />
      </Section>
    );
  return (
    <Section
      title="Avisos do pedido"
      footer="Um aviso quando a pizzaria aceitar, preparar, enviar ou concluir seu pedido. Ele mostra só o nome da loja, o número e o estado do pedido."
    >
      <ListRow
        first
        icon="notifications-outline"
        title={
          state.status === "on"
            ? "Ativados neste aparelho"
            : state.status === "denied"
              ? "Bloqueados nos ajustes do aparelho"
              : state.status === "unknown"
                ? "Situação não verificada"
                : "Desativados"
        }
      />
      <View style={{ padding: 16, paddingTop: 0, gap: 8 }}>
        {state.error ? <Body alert>{state.error}</Body> : null}
        {state.status === "unknown" ? (
          <Button
            label="Verificar avisos"
            size="medium"
            disabled={busy}
            onPress={() => void push.refresh()}
          />
        ) : null}
        {state.status === "denied" ? (
          <Button
            label="Abrir ajustes do aparelho"
            size="medium"
            onPress={() => void Linking.openSettings()}
          />
        ) : null}
        {state.status === "off" || state.status === "denied" ? (
          <Button
            label="Ativar avisos do pedido"
            variant={state.status === "off" ? "primary" : "secondary"}
            size="medium"
            loading={state.busy}
            disabled={busy}
            onPress={() => void push.enable()}
          />
        ) : null}
        {state.status === "on" || state.status === "denied" ? (
          <Button
            label="Desativar avisos"
            variant="ghost"
            size="medium"
            disabled={busy}
            onPress={() => void push.disable()}
          />
        ) : null}
      </View>
    </Section>
  );
}

const sameVersions = (a: LegalState, b: LegalState) =>
  a.status === "ready" &&
  b.status === "ready" &&
  a.legal.privacyPolicy.version === b.legal.privacyPolicy.version &&
  a.legal.termsOfUse.version === b.legal.termsOfUse.version;

type OpenDocument = { title: string; document: LegalDocument } | null;

function LegalRows({
  legal,
  onOpen,
}: {
  legal: StoreLegal;
  onOpen: (open: OpenDocument) => void;
}) {
  return (
    <>
      <ListRow
        first
        icon="document-text-outline"
        title="Termos de uso"
        subtitle={`Versão ${legal.termsOfUse.version}`}
        accessibilityHint="Abre o documento"
        onPress={() =>
          onOpen({ title: "Termos de uso", document: legal.termsOfUse })
        }
      />
      <ListRow
        icon="shield-checkmark-outline"
        title="Política de privacidade"
        subtitle={`Versão ${legal.privacyPolicy.version}`}
        accessibilityHint="Abre o documento"
        onPress={() =>
          onOpen({
            title: "Política de privacidade",
            document: legal.privacyPolicy,
          })
        }
      />
    </>
  );
}

/** The store's mark on the sign-in screen: its logo, or its initial; never WhiteOven's. */
function StoreMark({
  name,
  logoUrl,
}: {
  name: string;
  logoUrl: string | null;
}) {
  const theme = useTheme();
  return logoUrl ? (
    <Image
      source={{ uri: logoUrl }}
      accessibilityLabel={`Logotipo de ${name}`}
      resizeMode="contain"
      style={{ width: 64, height: 64, borderRadius: 20 }}
    />
  ) : (
    <View
      accessible={false}
      style={{
        width: 64,
        height: 64,
        borderRadius: 20,
        backgroundColor: theme.colors.primaryLight,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: theme.colors.accentText,
          fontSize: 30,
          fontWeight: "800",
        }}
      >
        {name.trim().charAt(0).toUpperCase() || "?"}
      </Text>
    </View>
  );
}

export function AccountScreen({
  model,
  state,
  push,
  notice,
  legal,
  storeName,
  logoUrl,
  backTo,
  startWithAddress = false,
  onReloadLegal,
  onBack,
}: {
  model: CommerceModel;
  state: CommerceState;
  push: PushModel;
  /** Why the app opened this screen, such as a tapped notification while signed out. */
  notice?: string | null;
  /** The store's current privacy policy and terms (ADR 0030), loaded by the app from the API. */
  legal: LegalState;
  storeName: string;
  logoUrl: string | null;
  /** The screen that sent the customer here (the bag, the orders), named on the back button. */
  backTo: string | null;
  /**
   * Opens straight on a new address, as the bag asks when delivery has none. Saving or going back
   * returns to the screen that asked (`onBack`) instead of the account.
   */
  startWithAddress?: boolean;
  onReloadLegal: () => Promise<LegalState>;
  onBack: () => void;
}) {
  const theme = useTheme();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<AuthErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [openDocument, setOpenDocument] = useState<OpenDocument>(null);
  const [view, setView] = useState<"home" | "address" | "delete">(
    startWithAddress ? "address" : "home",
  );
  const [editing, setEditing] = useState<{
    id?: string;
    address: Omit<Address, "id">;
  } | null>(startWithAddress ? { address: { ...emptyAddress } } : null);
  const closeAddress = () => {
    setEditing(null);
    if (startWithAddress) onBack();
    else setView("home");
  };
  const [deletePassword, setDeletePassword] = useState("");
  const refs = {
    name: useRef<InputRef>(null),
    phone: useRef<InputRef>(null),
    email: useRef<InputRef>(null),
    password: useRef<InputRef>(null),
  };
  const addressRefs = useRef<(InputRef | null)[]>([]);
  const disabled = state.busy || !state.ready;
  const legalReady = legal.status === "ready";
  const values = { name, phone, email, password, accepted };
  // After the first submit, errors follow the typing, so a fixed field loses its message.
  const revalidate = (patch: Partial<typeof values>) => {
    if (submitted)
      setErrors(validateAuthForm(mode, { ...values, ...patch }, legalReady));
  };
  const switchMode = (next: AuthMode) => {
    setMode(next);
    setPassword("");
    setErrors({});
    setSubmitted(false);
  };
  const signIn = async () => {
    setSubmitted(true);
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
  const header = (title: string, large = true) => (
    <ScreenHeader
      title={title}
      large={large}
      onBack={backTo ? onBack : undefined}
      backTo={backTo ?? undefined}
      backDisabled={state.busy}
    />
  );
  const sessionProblems = (
    <>
      {notice ? <InlineMessage tone="info">{notice}</InlineMessage> : null}
      {!state.ready ? (
        <InlineMessage
          tone="error"
          title="Não foi possível abrir seus dados"
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
    </>
  );
  const sheet = (
    <LegalSheet
      title={openDocument?.title ?? ""}
      document={openDocument?.document ?? null}
      onClose={() => setOpenDocument(null)}
    />
  );

  // ----- Signed in: address form -----
  if (state.profile && view === "address" && editing) {
    const save = () =>
      void model.saveAddress(editing.address, editing.id).then((saved) => {
        if (saved) {
          announce("Endereço salvo.");
          closeAddress();
        }
      });
    return (
      <FormPage
        header={
          <ScreenHeader
            title={editing.id ? "Editar endereço" : "Novo endereço"}
            onBack={closeAddress}
            backTo={startWithAddress ? (backTo ?? "Conta") : "Conta"}
            backDisabled={state.busy}
          />
        }
        footer={
          <StickyFooter>
            {state.error ? <Body alert>{state.error}</Body> : null}
            <Button
              label="Salvar endereço"
              variant="primary"
              loading={state.busy}
              disabled={disabled || !!state.pending}
              onPress={save}
            />
          </StickyFooter>
        }
      >
        {addressFields.map((field, index) => (
          <Field
            key={field.key}
            ref={(input) => {
              addressRefs.current[index] = input;
            }}
            label={field.label}
            helper={"helper" in field ? field.helper : undefined}
            value={editing.address[field.key] ?? ""}
            maxLength={field.max}
            editable={!disabled}
            autoCapitalize={"caps" in field ? field.caps : "words"}
            keyboardType={"keyboard" in field ? field.keyboard : "default"}
            textContentType={"content" in field ? field.content : "none"}
            autoComplete={"auto" in field ? field.auto : "off"}
            returnKeyType={index < addressFields.length - 1 ? "next" : "done"}
            onSubmitEditing={() =>
              index < addressFields.length - 1
                ? addressRefs.current[index + 1]?.focus()
                : save()
            }
            onChangeText={(value) =>
              setEditing({
                ...editing,
                address: {
                  ...editing.address,
                  [field.key]:
                    field.key === "state" ? value.toUpperCase() : value,
                },
              })
            }
          />
        ))}
      </FormPage>
    );
  }

  // ----- Signed in: delete account -----
  if (state.profile && view === "delete")
    return (
      <FormPage
        header={
          <ScreenHeader
            title="Excluir conta"
            onBack={() => {
              setDeletePassword("");
              setView("home");
            }}
            backTo="Conta"
            backDisabled={state.busy}
          />
        }
        footer={
          <StickyFooter>
            <Button
              label="Excluir minha conta"
              variant="destructive"
              icon="trash-outline"
              loading={state.busy}
              disabled={disabled || !!state.pending || !deletePassword}
              onPress={() =>
                Alert.alert(
                  "Excluir sua conta?",
                  "Esta ação não pode ser desfeita.",
                  [
                    { text: "Manter conta", style: "cancel" },
                    {
                      text: "Excluir",
                      style: "destructive",
                      onPress: () => {
                        void model.deleteAccount(deletePassword);
                        setDeletePassword("");
                      },
                    },
                  ],
                )
              }
            />
          </StickyFooter>
        }
      >
        <InlineMessage tone="warning" title="Esta ação não pode ser desfeita">
          A exclusão apaga nome, e-mail, telefone, senha, endereços e aparelhos
          cadastrados, tira esses dados dos seus pedidos e encerra as sessões. A
          loja mantém os pedidos e registros internos sem esses dados; a página
          de exclusão da loja detalha o que fica guardado.
        </InlineMessage>
        {state.pending ? (
          <InlineMessage tone="info">
            Confira primeiro o resultado do pedido pendente na sacola.
          </InlineMessage>
        ) : null}
        {state.error ? <Body alert>{state.error}</Body> : null}
        <Field
          label="Confirme com sua senha"
          value={deletePassword}
          onChangeText={setDeletePassword}
          password
          autoCapitalize="none"
          textContentType="password"
          autoComplete="current-password"
          maxLength={256}
          editable={!disabled}
        />
      </FormPage>
    );

  // ----- Signed in: account home -----
  if (state.profile) {
    const profile = state.profile;
    return (
      <FormPage header={header("Minha conta")}>
        {sheet}
        <View style={{ gap: 2 }}>
          <Text
            style={{
              color: theme.colors.text,
              fontSize: theme.typography.title.fontSize,
              lineHeight: theme.typography.title.lineHeight,
              fontWeight: "700",
            }}
          >
            {profile.name}
          </Text>
          <Body muted>{profile.email}</Body>
        </View>
        {sessionProblems}
        {state.error ? <Body alert>{state.error}</Body> : null}
        {profile.legalUpdateRequired ? (
          <InlineMessage
            tone="warning"
            title="Termos atualizados"
            action={
              legalReady ? (
                <Button
                  label="Li e aceito a versão atual"
                  size="small"
                  variant="primary"
                  disabled={disabled}
                  onPress={() =>
                    void model
                      .acceptLegal(acceptedVersions(legal.legal))
                      .then((ok) => {
                        if (!ok) void onReloadLegal();
                      })
                  }
                />
              ) : undefined
            }
          >
            A loja atualizou os termos de uso ou a política de privacidade. Leia
            a versão atual abaixo.
          </InlineMessage>
        ) : null}

        <Section title="Endereços">
          {state.addresses.length === 0 ? (
            <ListRow
              first
              icon="location-outline"
              title="Nenhum endereço cadastrado"
              subtitle="Cadastre um endereço para pedir com entrega."
            />
          ) : (
            state.addresses.map((address, index) => (
              <ListRow
                key={address.id}
                first={index === 0}
                icon="location-outline"
                title={address.label}
                subtitle={addressLine(address)}
                trailing={
                  <View style={{ flexDirection: "row" }}>
                    <IconButton
                      name="create-outline"
                      accessibilityLabel={`Editar ${address.label}`}
                      disabled={disabled || !!state.pending}
                      onPress={() => {
                        const { id, ...fields } = address;
                        setEditing({ id, address: fields });
                        setView("address");
                      }}
                    />
                    <IconButton
                      name="trash-outline"
                      tone="danger"
                      accessibilityLabel={`Remover ${address.label}`}
                      disabled={disabled || !!state.pending}
                      onPress={() =>
                        Alert.alert("Remover endereço?", address.label, [
                          { text: "Manter", style: "cancel" },
                          {
                            text: "Remover",
                            style: "destructive",
                            onPress: () => void model.removeAddress(address.id),
                          },
                        ])
                      }
                    />
                  </View>
                }
              />
            ))
          )}
          {state.addresses.length < 10 ? (
            <ListRow
              icon="add-circle-outline"
              title="Adicionar endereço"
              disabled={disabled || !!state.pending}
              onPress={() => {
                setEditing({ address: { ...emptyAddress } });
                setView("address");
              }}
            />
          ) : null}
        </Section>

        <OrderNotifications push={push} disabled={disabled} />

        <Section title="Termos e privacidade">
          {legal.status === "ready" ? (
            <LegalRows legal={legal.legal} onOpen={setOpenDocument} />
          ) : legal.status === "loading" ? (
            <ListRow first title="Carregando os documentos da loja…" />
          ) : (
            <ListRow
              first
              icon="refresh"
              title="Carregar termos e privacidade"
              onPress={() => void onReloadLegal()}
            />
          )}
        </Section>

        <Section>
          <ListRow
            first
            icon="log-out-outline"
            title="Sair da conta"
            disabled={disabled}
            onPress={() => void model.logout()}
          />
          <ListRow
            icon="trash-outline"
            title="Excluir conta"
            destructive
            disabled={disabled}
            onPress={() => setView("delete")}
          />
        </Section>
      </FormPage>
    );
  }

  // ----- Signed out: sign in or sign up -----
  const register = mode === "register";
  return (
    <FormPage
      header={header(register ? "Criar conta" : "Entrar", !backTo)}
      footer={
        <StickyFooter>
          {state.error ? (
            <InlineMessage tone="error">{state.error}</InlineMessage>
          ) : null}
          <Button
            label={register ? "Criar conta" : "Entrar"}
            variant="primary"
            loading={state.busy}
            disabled={disabled}
            onPress={() => void signIn()}
          />
        </StickyFooter>
      }
    >
      {sheet}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <StoreMark name={storeName} logoUrl={logoUrl} />
        <View style={{ flex: 1 }}>
          <Body muted>
            {register
              ? `Crie sua conta em ${storeName} para pedir e acompanhar seus pedidos.`
              : `Entre na sua conta de ${storeName} para pedir e acompanhar seus pedidos.`}
          </Body>
        </View>
      </View>
      {sessionProblems}
      <SegmentedControl
        options={[
          { value: "login", label: "Entrar" },
          { value: "register", label: "Criar conta" },
        ]}
        value={mode}
        disabled={disabled}
        onChange={switchMode}
      />
      {register ? (
        <>
          <Field
            ref={refs.name}
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
            onSubmitEditing={() => refs.phone.current?.focus()}
            editable={!disabled}
          />
          <Field
            ref={refs.phone}
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
            placeholder="(11) 99999-9999"
            helper="Com DDD. A pizzaria usa para falar sobre o pedido."
            maxLength={24}
            returnKeyType="next"
            onSubmitEditing={() => refs.email.current?.focus()}
            editable={!disabled}
          />
        </>
      ) : null}
      <Field
        ref={refs.email}
        label="E-mail"
        value={email}
        error={errors.email}
        onChangeText={(value) => {
          setEmail(value);
          revalidate({ email: value });
        }}
        placeholder="voce@exemplo.com"
        autoComplete="email"
        textContentType={register ? "emailAddress" : "username"}
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
        label="Senha"
        value={password}
        error={errors.password}
        onChangeText={(value) => {
          setPassword(value);
          revalidate({ password: value });
        }}
        helper={
          register
            ? `Pelo menos ${PASSWORD_MIN} caracteres. Senhas comuns não são aceitas.`
            : undefined
        }
        password
        textContentType={register ? "newPassword" : "password"}
        autoComplete={register ? "new-password" : "current-password"}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={256}
        returnKeyType={register ? "next" : "go"}
        onSubmitEditing={() => {
          if (!register) void signIn();
        }}
        editable={!disabled}
      />

      {register ? (
        legal.status === "ready" ? (
          <Section title="Termos e privacidade">
            <LegalRows legal={legal.legal} onOpen={setOpenDocument} />
            <View style={{ padding: 12, gap: 8 }}>
              <Choice
                kind="checkbox"
                label="Li e aceito os termos de uso e a política de privacidade"
                selected={accepted}
                disabled={disabled}
                onPress={() => {
                  setAccepted(!accepted);
                  revalidate({ accepted: !accepted });
                }}
              />
              {errors.legal ? (
                <Body alert small>
                  {errors.legal}
                </Body>
              ) : null}
            </View>
          </Section>
        ) : legal.status === "loading" ? (
          <InlineMessage tone="info">
            Carregando os termos de uso e a política de privacidade…
          </InlineMessage>
        ) : (
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
                onPress={() => void onReloadLegal()}
              />
            }
          >
            {legal.status === "unavailable"
              ? "O cadastro fica disponível quando a loja publicar os termos de uso e a política de privacidade."
              : "Não foi possível carregar os termos de uso e a política de privacidade."}
          </InlineMessage>
        )
      ) : null}
    </FormPage>
  );
}
