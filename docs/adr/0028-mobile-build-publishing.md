# ADR 0028: build por loja no EAS e publicação nas contas da pizzaria

- **Status:** implementado em M5.6
- **Data:** 2026-10-31
- **Milestone:** M5.6

## Contexto

Cada pizzaria tem o seu próprio binário, gerado do mesmo código a partir do manifesto da loja (ADR 0020). As pastas nativas não são versionadas, e a ADR 0020 deixou para a M5.6 a decisão sobre o pipeline de build. A ADR 0027 deixou para a publicação o projeto EAS de cada loja e as credenciais de push (APNs e FCM).

Em 2026-10-30 o produto decidiu a Q-09: o app de cada pizzaria sai na conta de desenvolvedor da própria pizzaria (Apple Developer e Google Play Console), operada pelo WhiteOven. Isso também atende à regra da Apple para apps feitos a partir de template (diretriz 4.2.6): o app precisa ser enviado pela conta de quem é dono do conteúdo, a pizzaria.

O roadmap pede três coisas para a M5.6: build reproduzível a partir do manifesto, o processo documentado nas contas da pizzaria e nenhuma credencial no repositório.

## Decisão

- **Build no EAS Build, submissão no EAS Submit.** O Expo já é o fornecedor aprovado do push (Q-11), e o EAS gera iOS sem Mac próprio, guarda as credenciais de assinatura e as de push no mesmo lugar e envia às lojas. Um pipeline próprio (Fastlane em runner macOS) exigiria guardar certificados e keystores nós mesmos.
- **Um projeto EAS por loja, todos na organização Expo do WhiteOven.**
  - O manifesto ganha `expoOwner` (o nome da organização), ao lado do `easProjectId` da ADR 0027. `app.config.ts` passa a declarar `owner`, que o EAS exige quando o build roda com o token de robô da organização. `expoOwner` só é aceito junto com `easProjectId`.
  - A API tem um único `EXPO_ACCESS_TOKEN` (ADR 0027). Com todos os projetos numa organização, esse token envia os avisos de todas as lojas.
  - O que pertence à pizzaria fica na conta dela: o app nas lojas, a chave APNs, o projeto Firebase do FCM, a chave de API do App Store Connect e a conta de serviço do Google Play. O WhiteOven entra como usuário convidado e sobe essas credenciais para o EAS, nunca para o repositório.
- **Perfis do `apps/mobile/eas.json`:**
  - `base` fixa Node 22.23.2 e pnpm 11.25.0, as versões da CI e do `packageManager`.
  - `preview`: distribuição interna (APK no Android, ad hoc no iOS), ambiente `preview` do EAS e `WHITEOVEN_RELEASE=preview`.
  - `production`: distribuição na loja (AAB no Android), ambiente `production` do EAS, `autoIncrement` e `WHITEOVEN_RELEASE=store`.
  - Um par `{slug}-preview` e `{slug}-production` por manifesto, que só acrescenta `WHITEOVEN_TENANT`. O EAS não leva variáveis do shell para o worker, então a loja precisa estar no perfil.
  - `cli.appVersionSource: remote`: o número de build (iOS `buildNumber`, Android `versionCode`) é contado pelo EAS em cada projeto. A versão exibida nas lojas continua sendo o `version` do manifesto.
  - `cli.requireCommit: true`: o EAS recusa build com alterações não commitadas, então todo binário corresponde a um commit.
  - Um teste confere que cada manifesto tem os dois perfis, que nenhum perfil sobra e que o `eas.json` não tem caminhos de credencial nem variáveis além de `WHITEOVEN_TENANT` e `WHITEOVEN_RELEASE`.
- **API por variável do EAS.** `WHITEOVEN_API_URL` fica nos ambientes `preview` e `production` de cada projeto EAS, como texto simples (não é segredo). Ela não entra no `eas.json` porque nenhum ambiente de produção existe ainda; quando existir, o endereço é cadastrado uma vez por projeto.
- **Trava de release no worker.** Com `WHITEOVEN_RELEASE` definido e `EAS_BUILD=true`, `app.config.ts` recusa o build quando falta algo:
  - nos dois tipos: `easProjectId`, `expoOwner`, ícone PNG de 1024 x 1024 e `WHITEOVEN_API_URL` em HTTPS fora da máquina de desenvolvimento;
  - só no `store`: ícone sem transparência (a App Store recusa) e aviso de privacidade aprovado, nunca o texto demonstrativo (`version` começando por `demo-`, que só sai na M7.2).
  - A trava espera o worker porque o CLI avalia o config antes de baixar as variáveis do EAS: na máquina do operador a URL ainda não está presente.
  - `pnpm mobile:release-check <slug> <preview|store>` roda a mesma verificação antes de gastar um build, menos a URL quando ela não está no ambiente.
- **iOS:** `ios.config.usesNonExemptEncryption: false`. O app só usa o HTTPS do sistema, que é isento, e o App Store Connect para de perguntar sobre exportação a cada envio.
- **Submissão:** o perfil `production` de submit manda o Android para a trilha interna como rascunho e define o idioma do iOS como `pt-BR`. Cada loja ganha um perfil de submit com o nome do slug, que só acrescenta o `ascAppId` do App Store Connect (não é segredo). Nada é promovido para produção automaticamente: a revisão e a liberação ficam nos consoles.
- **Workflow manual** `.github/workflows/mobile-build.yml` (`workflow_dispatch`): loja, tipo (`preview` ou `store`), plataforma e envio opcional.
  - Roda o release check, exige o perfil de submit da loja para enviar e chama `eas build --non-interactive --no-wait` (o build roda no EAS, não no runner).
  - Usa os ambientes do GitHub `mobile-preview` e `mobile-store`, cada um com o `EXPO_TOKEN` de um robô da organização Expo. `mobile-store` deve ter revisores obrigatórios.
  - As entradas chegam aos comandos por variável de ambiente, nunca interpoladas no script.
- **Fora deste marco:** atualizações OTA (`expo-updates`), splash próprio (o primeiro quadro já usa a marca do cache, ADR 0020) e build de desenvolvimento com `expo-dev-client`. O build `preview` serve para testar push num aparelho.

O passo a passo das contas, credenciais e fichas das lojas está em [operations/mobile-publishing.md](../operations/mobile-publishing.md).

## Alternativas descartadas

- **Pipeline próprio com Fastlane:** precisa de runner macOS e de guardar certificados, perfis e keystores em segredos do GitHub. O EAS já faz isso, e o Expo já é fornecedor aprovado.
- **Conta Expo da pizzaria:** cada loja precisaria de uma conta Expo, e a API precisaria de um token de push por loja. A conta Expo é ferramenta de build do operador; o que identifica a pizzaria nas lojas são as contas Apple e Google, que continuam dela.
- **Loja por variável do EAS em vez de perfil:** o CLI precisa saber a loja antes de saber o projeto, porque o `easProjectId` vem do manifesto. A loja no perfil evita esse ciclo e fica revisável no repositório.
- **`expo prebuild` com pastas nativas versionadas:** duplicaria o projeto nativo por loja e perderia a geração a partir do manifesto (ADR 0020).

## Consequências

- Uma loja nova no app precisa de manifesto, ícone, os dois perfis no `eas.json` e, para enviar ao iOS, o perfil de submit com o `ascAppId`. O teste falha se faltar perfil.
- O texto demonstrativo de privacidade bloqueia o build de loja até a M7.2 entregar o texto aprovado. Os manifestos de exemplo nunca passam na trava de loja.
- O build ainda não foi executado no EAS: este marco não cria a organização Expo nem projetos. O primeiro build real, com a pizzaria piloto (M7.5), valida o pipeline.
- O EAS instala o monorepo inteiro a partir da raiz (lockfile do pnpm). Se o tempo de instalação pesar, o próximo passo é um `.easignore`, desde que o `pnpm install --frozen-lockfile` continue válido.
- O plano gratuito do EAS tem limite mensal de builds. Passar dele é um custo novo e precisa de aprovação.
