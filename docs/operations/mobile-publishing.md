# M5.6 — Publicação do app de uma pizzaria

**Preparação, sem publicação real.** Nenhuma conta, projeto EAS ou ficha de loja foi criada por este marco. A primeira execução completa é a da pizzaria piloto (M7.5). Decisões em [ADR 0028](../adr/0028-mobile-build-publishing.md); push em [ADR 0027](../adr/0027-order-push-notifications.md).

Regra geral (Q-09): o app sai na conta da pizzaria, e o WhiteOven opera como usuário convidado. Ninguém do WhiteOven usa a senha do titular. Credenciais vão para o EAS ou para os consoles, nunca para o repositório, para o chat ou para e-mail.

Prazos e preços das lojas mudam; confira nas páginas oficiais da Apple e do Google antes de passar valores à pizzaria.

## 1. Uma vez, no WhiteOven

- [ ] Organização Expo do WhiteOven criada, com MFA em todos os membros.
- [ ] Dois robôs na organização: um para builds de preview e outro para builds de loja. Os tokens vão para os ambientes `mobile-preview` e `mobile-store` do GitHub como `EXPO_TOKEN`. O robô precisa ler as variáveis de ambiente dos projetos, porque o pré-voo do workflow confere a `WHITEOVEN_API_URL` antes do build.
- [ ] Ambiente `mobile-store` do GitHub com revisores obrigatórios.
- [ ] "Enhanced push security" ligado na organização, com o token de acesso só no `EXPO_ACCESS_TOKEN` da API (ADR 0027).

## 2. Contas da pizzaria (começar cedo: levam dias)

- [ ] CNPJ ativo e número D-U-N-S da empresa (gratuito, pedido pelo site da Apple; pode levar dias úteis).
- [ ] **Apple Developer Program** como organização (não pessoa física), pago anualmente pela pizzaria. O titular (Account Holder) é alguém da pizzaria.
- [ ] **Google Play Console** como organização, com taxa única paga pela pizzaria. Conta de organização evita a exigência de teste fechado com testadores, que vale para contas pessoais novas.
- [ ] Titular convida o operador do WhiteOven:
  - App Store Connect: papel **Admin** (precisa criar chaves e o app);
  - Play Console: permissão de administrador do app (ou da conta, para criar o app).
- [ ] Projeto **Firebase** da pizzaria (para o FCM do Android), com o operador como membro.

## 3. Repositório

- [ ] Manifesto `apps/mobile/manifests/{slug}.json`, com `name` (até 30 caracteres), `version`, `ios.bundleIdentifier` e `android.package` definitivos. Esses ids não mudam depois do primeiro envio.
- [ ] Ícone `apps/mobile/assets/tenants/{slug}/icon.png`: PNG 1024 x 1024 **sem transparência**.
- [ ] Projeto EAS criado na organização: em `apps/mobile`, com `WHITEOVEN_TENANT={slug}`, rodar `eas init` e copiar o id para `easProjectId`; `expoOwner` recebe o nome da organização.
- [ ] Perfis `{slug}-preview` e `{slug}-production` no `eas.json` (o teste exige).
- [ ] Aviso de privacidade aprovado no manifesto (M7.2). O texto demonstrativo bloqueia o build de loja.
- [ ] `pnpm mobile:release-check {slug} store` sem pendências. Com o EAS CLI logado, `--eas` também confere a URL da API no ambiente do EAS, e `--submit --platform ios|android|all` confere o perfil de submit.

## 4. Projeto EAS da loja

- [ ] Variável `WHITEOVEN_API_URL` (texto simples, HTTPS) nos ambientes `preview` e `production` do projeto.
- [ ] **iOS:** no primeiro build, deixar o EAS gerar certificado de distribuição e perfil de provisionamento com a conta da pizzaria (`eas credentials`, login como o operador convidado).
- [ ] **APNs:** chave `.p8` criada na conta da pizzaria e enviada ao EAS (`eas credentials` → Push Notifications).
- [ ] **Android:** keystore de upload gerada e guardada pelo EAS. Ativar a assinatura de apps do Google Play no primeiro envio.
- [ ] **FCM:** chave de conta de serviço do Firebase (FCM V1) enviada ao EAS (`eas credentials` → Google Service Account → push).
- [ ] **Submissão:** chave de API do App Store Connect (papel App Manager) e conta de serviço do Google Play com acesso ao app, as duas enviadas ao EAS. Apagar as cópias locais depois do envio.

## 5. Builds

1. **Preview:** Actions → _Mobile build_ → loja, `preview`, plataforma. Instalar o APK e o build ad hoc (os iPhones precisam estar registrados com `eas device:create`). Testar cardápio, pedido, push e exclusão de conta contra a API real.
2. **Primeiro envio ao Google Play:** a API do Google não aceita o primeiro AAB de um app novo. Rodar o build `store` sem envio e subir o AAB à mão na trilha de teste interno.
3. **Perfil de submit** `{slug}` no `eas.json`, com `extends: "production"` e `ios.ascAppId` (o id numérico do app no App Store Connect). Só o iOS precisa dele: enviar só o Android usa o perfil `production`.
4. **Builds seguintes:** _Mobile build_ com `store` e "submit" marcado. O Android chega como rascunho na trilha interna, e o iOS no TestFlight. A promoção para produção e o envio à revisão são feitos nos consoles.

## 6. Fichas das lojas

- [ ] Nome, descrição curta e completa, categoria _Comida e bebida_, classificação etária.
- [ ] Capturas de tela da loja real (iPhone de 6,9" e Android), sem dados pessoais reais.
- [ ] URL da política de privacidade da pizzaria (M7.2).
- [ ] **Google Play:** formulário de segurança de dados e **URL para pedir a exclusão da conta** fora do app. O app já exclui a conta pela tela Minha conta, mas o Google exige também um endereço na web, que ainda não existe (M7.2).
- [ ] **Apple:** rótulos de privacidade (dados de contato, endereço, histórico de compras, identificador do aparelho para push), conta de demonstração para o revisor com dados fictícios numa loja aberta, e nota explicando que o app é o canal de pedidos da própria pizzaria.
- [ ] Contato de suporte da pizzaria.

## 7. Depois da aprovação

- [ ] Ligar `PUSH_DELIVERY=expo` na API, se ainda não estiver.
- [ ] Fazer um pedido real de ponta a ponta e conferir o aviso de push e o `BillingEntry` (M7.5).
- [ ] Registrar na ficha da pizzaria: versão publicada, commit e data de renovação da conta Apple.
- [ ] Nova versão: subir `version` no manifesto, commitar e rodar o workflow. O número de build sobe sozinho.
