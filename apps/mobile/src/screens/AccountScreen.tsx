import { useState, useSyncExternalStore } from "react";
import { Alert, Linking, View } from "react-native";
import { Body, Button, Field, FormPage, Heading } from "../components/Form.tsx";
import { Choice } from "../components/Choice.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import type { Address } from "../customer/client.ts";
import { legalBlocks, type LegalDocument } from "@whiteoven/contracts";
import {
  acceptedVersions,
  type LegalState,
  type StoreLegal,
} from "../customer/legal.ts";
import type { PushModel } from "../customer/push.ts";

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
const addressFields = [
  ["label", "Nome do endereço", 40],
  ["postalCode", "CEP", 9],
  ["street", "Rua", 120],
  ["number", "Número", 20],
  ["complement", "Complemento (opcional)", 60],
  ["district", "Bairro", 80],
  ["city", "Cidade", 80],
  ["state", "UF", 2],
  ["reference", "Referência (opcional)", 120],
] as const;
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
  return (
    <>
      <Heading>Avisos do pedido</Heading>
      {state.status === "unavailable" ? (
        <Body>
          Os avisos do pedido não estão disponíveis nesta versão do app.
        </Body>
      ) : (
        <>
          <Body>
            Receba um aviso quando a pizzaria aceitar, preparar, enviar ou
            concluir seu pedido. O aviso mostra só o nome da loja, o número e o
            estado do pedido.
          </Body>
          {state.error ? <Body alert>{state.error}</Body> : null}
          {state.status === "unknown" ? (
            <Button
              label="Verificar avisos do pedido"
              disabled={busy}
              onPress={() => void push.refresh()}
            />
          ) : null}
          {state.status === "on" ? (
            <Body>Avisos ativados neste aparelho.</Body>
          ) : null}
          {state.status === "denied" ? (
            <>
              <Body alert>
                As notificações estão bloqueadas nos ajustes do aparelho.
                Libere-as para receber os avisos.
              </Body>
              <Button
                label="Abrir ajustes do aparelho"
                onPress={() => void Linking.openSettings()}
              />
            </>
          ) : null}
          {state.status === "off" || state.status === "denied" ? (
            <Button
              label="Ativar avisos do pedido"
              disabled={busy}
              onPress={() => void push.enable()}
            />
          ) : null}
          {state.status === "on" || state.status === "denied" ? (
            <Button
              label="Desativar avisos do pedido"
              disabled={busy}
              onPress={() => void push.disable()}
            />
          ) : null}
        </>
      )}
    </>
  );
}

/** One legal document, collapsed until asked for; the same blocks as the store's web page. */
function LegalDocumentView({
  title,
  document,
}: {
  title: string;
  document: LegalDocument;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        label={`${open ? "Ocultar" : "Ler"} ${title.toLowerCase()} (versão ${document.version})`}
        onPress={() => setOpen(!open)}
      />
      {open
        ? legalBlocks(document.body).map((block, index) =>
            block.type === "heading" ? (
              <Heading key={index}>{block.text}</Heading>
            ) : block.type === "list" ? (
              <View key={index} style={{ gap: 4 }}>
                {block.items.map((item, at) => (
                  <Body key={at}>• {item}</Body>
                ))}
              </View>
            ) : (
              <Body key={index}>{block.text}</Body>
            ),
          )
        : null}
    </>
  );
}

function LegalDocuments({ legal }: { legal: StoreLegal }) {
  return (
    <>
      <LegalDocumentView title="Termos de uso" document={legal.termsOfUse} />
      <LegalDocumentView
        title="Política de privacidade"
        document={legal.privacyPolicy}
      />
    </>
  );
}

const sameVersions = (a: LegalState, b: LegalState) =>
  a.status === "ready" &&
  b.status === "ready" &&
  a.legal.privacyPolicy.version === b.legal.privacyPolicy.version &&
  a.legal.termsOfUse.version === b.legal.termsOfUse.version;

export function AccountScreen({
  model,
  state,
  push,
  notice,
  legal,
  onReloadLegal,
  onBack,
  onOrders,
}: {
  model: CommerceModel;
  state: CommerceState;
  push: PushModel;
  /** Why the app opened this screen, such as a tapped notification while signed out. */
  notice?: string | null;
  /** The store's current privacy policy and terms (ADR 0030), loaded by the app from the API. */
  legal: LegalState;
  onReloadLegal: () => Promise<LegalState>;
  onBack: () => void;
  onOrders: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [editing, setEditing] = useState<{
    id?: string;
    address: Omit<Address, "id">;
  } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const disabled = state.busy || !state.ready;
  const signIn = async () => {
    if (mode === "register" && (legal.status !== "ready" || !accepted)) return;
    const body =
      mode === "login"
        ? { email: email.trim(), password }
        : {
            name: name.trim(),
            email: email.trim(),
            password,
            phone: phone.trim() || null,
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
  return (
    <FormPage>
      <Button label="Voltar" onPress={onBack} disabled={state.busy} />
      <Heading>Minha conta</Heading>
      {notice ? <Body alert>{notice}</Body> : null}
      {state.error ? <Body alert>{state.error}</Body> : null}
      {state.busy ? <Body>Processando…</Body> : null}
      {!state.ready ? (
        <Button
          label="Tentar restaurar os dados"
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
      {state.profile ? (
        <>
          <Button label="Meus pedidos" onPress={onOrders} disabled={disabled} />
          <Body>
            {state.profile.name} · {state.profile.email}
          </Body>
          <Button
            label="Sair da conta"
            disabled={disabled}
            onPress={() => void model.logout()}
          />
          <Heading>Termos e privacidade</Heading>
          {state.profile.legalUpdateRequired ? (
            <Body alert>
              A loja atualizou os termos de uso ou a política de privacidade.
              Leia a versão atual.
            </Body>
          ) : null}
          {legal.status === "ready" ? (
            <>
              <LegalDocuments legal={legal.legal} />
              {state.profile.legalUpdateRequired ? (
                <Button
                  label="Li e aceito a versão atual"
                  disabled={disabled}
                  onPress={() =>
                    void model
                      .acceptLegal(acceptedVersions(legal.legal))
                      .then((ok) => {
                        if (!ok) void onReloadLegal();
                      })
                  }
                />
              ) : null}
            </>
          ) : legal.status === "loading" ? (
            <Body>Carregando os documentos da loja…</Body>
          ) : (
            <Button
              label="Carregar termos e privacidade"
              onPress={() => void onReloadLegal()}
            />
          )}
          <OrderNotifications push={push} disabled={disabled} />
          <Heading>Endereços</Heading>
          <Button
            label="Atualizar endereços"
            disabled={disabled}
            onPress={() => void model.refreshAccount()}
          />
          {state.addresses.map((address) => (
            <View key={address.id} style={{ gap: 8 }}>
              <Body>
                {address.label}: {address.street}, {address.number}
                {address.complement ? `, ${address.complement}` : ""} ·{" "}
                {address.district} · {address.city}/{address.state} ·{" "}
                {address.postalCode}
              </Body>
              <Button
                label={`Editar ${address.label}`}
                disabled={disabled || !!state.pending}
                onPress={() => {
                  const { id, ...fields } = address;
                  setEditing({ id, address: fields });
                }}
              />
              <Button
                label={`Remover ${address.label}`}
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
          ))}
          {!editing ? (
            <Button
              label="Adicionar endereço"
              disabled={
                disabled || !!state.pending || state.addresses.length >= 10
              }
              onPress={() => setEditing({ address: { ...emptyAddress } })}
            />
          ) : (
            <>
              <Heading>
                {editing.id ? "Editar endereço" : "Novo endereço"}
              </Heading>
              {addressFields.map(([key, label, max]) => (
                <Field
                  key={key}
                  label={label}
                  value={editing.address[key] ?? ""}
                  maxLength={max}
                  editable={!disabled}
                  autoCapitalize={key === "state" ? "characters" : "words"}
                  keyboardType={key === "postalCode" ? "number-pad" : "default"}
                  onChangeText={(value) =>
                    setEditing({
                      ...editing,
                      address: {
                        ...editing.address,
                        [key]: key === "state" ? value.toUpperCase() : value,
                      },
                    })
                  }
                />
              ))}
              <Button
                label="Salvar endereço"
                disabled={disabled || !!state.pending}
                onPress={() =>
                  void model
                    .saveAddress(editing.address, editing.id)
                    .then((saved) => {
                      if (saved) setEditing(null);
                    })
                }
              />
              <Button
                label="Cancelar edição"
                disabled={disabled}
                onPress={() => setEditing(null)}
              />
            </>
          )}
          <Heading>Excluir conta</Heading>
          <Body>
            A exclusão apaga nome, e-mail, telefone, senha, endereços e
            aparelhos cadastrados, tira esses dados dos seus pedidos e encerra
            as sessões. A loja mantém os pedidos e registros internos sem esses
            dados; a página de exclusão da loja detalha o que fica guardado.
          </Body>
          {state.pending ? (
            <Body>Confira primeiro o resultado do pedido pendente.</Body>
          ) : null}
          <Field
            label="Senha para excluir a conta"
            value={deletePassword}
            onChangeText={setDeletePassword}
            secureTextEntry
            autoCapitalize="none"
            maxLength={256}
            editable={!disabled}
          />
          <Button
            label="Excluir minha conta"
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
        </>
      ) : (
        <>
          <Body>
            Sua conta pertence a esta pizzaria. Entre para confirmar o pedido.
          </Body>
          <Choice
            kind="radio"
            label="Já tenho conta"
            selected={mode === "login"}
            disabled={disabled}
            onPress={() => {
              setMode("login");
              setPassword("");
            }}
          />
          <Choice
            kind="radio"
            label="Criar conta"
            selected={mode === "register"}
            disabled={disabled}
            onPress={() => {
              setMode("register");
              setPassword("");
            }}
          />
          {mode === "register" ? (
            <>
              <Field
                label="Nome"
                value={name}
                onChangeText={setName}
                maxLength={120}
                editable={!disabled}
              />
              <Field
                label="Telefone com código do país (opcional)"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                maxLength={16}
                editable={!disabled}
              />
            </>
          ) : null}
          <Field
            label="E-mail"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            maxLength={254}
            editable={!disabled}
          />
          <Field
            label={
              mode === "register" ? "Senha (10 a 256 caracteres)" : "Senha"
            }
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={256}
            editable={!disabled}
          />
          {mode === "register" ? (
            legal.status === "ready" ? (
              <>
                <Heading>Termos e privacidade</Heading>
                <Body>
                  Leia os termos de uso e a política de privacidade desta
                  pizzaria antes de criar a conta.
                </Body>
                <LegalDocuments legal={legal.legal} />
                <Choice
                  kind="checkbox"
                  label="Li e aceito os termos de uso e a política de privacidade"
                  selected={accepted}
                  disabled={disabled}
                  onPress={() => setAccepted(!accepted)}
                />
              </>
            ) : legal.status === "loading" ? (
              <Body>Carregando os termos e a política de privacidade…</Body>
            ) : (
              <>
                <Body alert>
                  {legal.status === "unavailable"
                    ? "O cadastro está indisponível até a loja publicar os termos de uso e a política de privacidade."
                    : "Não foi possível carregar os termos de uso e a política de privacidade."}
                </Body>
                <Button
                  label="Tentar carregar de novo"
                  disabled={disabled}
                  onPress={() => void onReloadLegal()}
                />
              </>
            )
          ) : null}
          <Button
            label={mode === "register" ? "Criar conta" : "Entrar"}
            onPress={() => void signIn()}
            disabled={
              disabled ||
              !email.trim() ||
              !password ||
              (mode === "register" &&
                (!name.trim() ||
                  password.length < 10 ||
                  !accepted ||
                  legal.status !== "ready"))
            }
          />
        </>
      )}
    </FormPage>
  );
}
