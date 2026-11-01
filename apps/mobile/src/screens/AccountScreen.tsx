import {
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { Alert, Linking, Text, TextInput, View } from "react-native";
import type { LegalDocument } from "@whiteoven/contracts";
import { announce } from "../a11y/useAnnouncement.ts";
import { useTheme } from "../brand/theme.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { InlineMessage } from "../components/Feedback.tsx";
import { Body, Button, Field, FormPage } from "../components/Form.tsx";
import { IconButton } from "../components/Icon.tsx";
import { LegalSheet } from "../components/LegalSheet.tsx";
import { ListRow, Section } from "../components/ListRow.tsx";
import { ScreenHeader, StickyFooter } from "../components/Screen.tsx";
import { initialAuthStep } from "../customer/auth-flow.ts";
import type { Address } from "../customer/client.ts";
import {
  acceptedVersions,
  type LegalState,
  type StoreLegal,
} from "../customer/legal.ts";
import type { PushModel } from "../customer/push.ts";
import { AuthFlow } from "./AuthScreens.tsx";

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

export function AccountScreen({
  model,
  state,
  push,
  notice,
  legal,
  storeName,
  logoUrl,
  heroImageUrl,
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
  /** A photo of one of the store's pizzas for the welcome, when the menu has one. */
  heroImageUrl: string | null;
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
  const addressRefs = useRef<(InputRef | null)[]>([]);
  const disabled = state.busy || !state.ready;
  const legalReady = legal.status === "ready";
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

  // ----- Signed out: welcome, sign in or sign up -----
  return (
    <AuthFlow
      model={model}
      state={state}
      initial={initialAuthStep({
        returnsSomewhere: !!backTo,
        hasNotice: !!notice,
      })}
      legal={legal}
      storeName={storeName}
      logoUrl={logoUrl}
      heroImageUrl={heroImageUrl}
      backTo={backTo}
      notice={notice}
      problems={sessionProblems}
      onReloadLegal={onReloadLegal}
      onExit={backTo ? onBack : undefined}
    />
  );
}
