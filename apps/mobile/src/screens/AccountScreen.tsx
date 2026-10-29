import { useState } from "react";
import { Alert, View } from "react-native";
import { Body, Button, Field, FormPage, Heading } from "../components/Form.tsx";
import { Choice } from "../components/Choice.tsx";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import type { Address } from "../customer/client.ts";
import type { CustomerPrivacyPolicy } from "../config/manifest.ts";

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
export function AccountScreen({
  model,
  state,
  policy,
  onBack,
}: {
  model: CommerceModel;
  state: CommerceState;
  policy?: CustomerPrivacyPolicy;
  onBack: () => void;
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
    if (mode === "register" && (!policy || !accepted)) return;
    const body =
      mode === "login"
        ? { email: email.trim(), password }
        : {
            name: name.trim(),
            email: email.trim(),
            password,
            phone: phone.trim() || null,
            privacyPolicyVersion: policy!.version,
          };
    setPassword("");
    await model.signIn(mode, body);
  };
  return (
    <FormPage>
      <Button label="Voltar" onPress={onBack} disabled={state.busy} />
      <Heading>Minha conta</Heading>
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
          <Body>
            {state.profile.name} · {state.profile.email}
          </Body>
          <Button
            label="Sair da conta"
            disabled={disabled}
            onPress={() => void model.logout()}
          />
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
            A exclusão remove seus dados pessoais e endereços e encerra as
            sessões. Pedidos são mantidos sem o vínculo com seus dados de
            cadastro.
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
            policy ? (
              <>
                <Heading>Privacidade</Heading>
                <Body>{policy.text}</Body>
                <Body>Versão: {policy.version}</Body>
                <Choice
                  kind="checkbox"
                  label="Li e aceito o aviso de privacidade"
                  selected={accepted}
                  disabled={disabled}
                  onPress={() => setAccepted(!accepted)}
                />
              </>
            ) : (
              <Body alert>
                O cadastro está indisponível até a loja configurar o aviso de
                privacidade.
              </Body>
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
                (!name.trim() || password.length < 10 || !accepted || !policy))
            }
          />
        </>
      )}
    </FormPage>
  );
}
