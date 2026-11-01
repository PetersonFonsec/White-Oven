# M7.5 — Onboarding da pizzaria piloto

Este roteiro conduz uma loja do cadastro ao primeiro pedido real concluído e à conferência do `BillingEntry`. Ele é um registro operacional: preencher os campos durante o onboarding, sem inserir senhas, tokens, chaves privadas, dados de clientes ou outros segredos neste arquivo.

O ambiente de produção ainda precisa ser provisionado. Não execute os passos marcados **no ambiente** até que o host e a loja piloto tenham sido definidos e autorizados. A publicação usa as contas da própria pizzaria conforme o [runbook de publicação](mobile-publishing.md). O escopo do piloto não inclui pagamento online.

## Registro do piloto

| Campo                         | Valor |
| ----------------------------- | ----- |
| Pizzaria / razão social       |       |
| Responsável da pizzaria       |       |
| Slug do tenant                |       |
| UUID do tenant                |       |
| Ambiente e URL pública da API |       |
| Região e fuso IANA da loja    |       |
| Plano e início de vigência    |       |
| Responsável WhiteOven         |       |
| Data de início do piloto      |       |
| Commit publicado              |       |

## 1. Aprovações e dados da loja

- [ ] Contrato de operador de dados assinado; registre a referência e a data no local aprovado para contratos. Veja [documentos legais](legal-documents.md).
- [ ] Política de privacidade e termos da pizzaria fornecidos/aprovados pelo jurídico; as versões foram publicadas na API e verificadas no slug correto.
- [ ] Plano Flex ou Pro, preço e data de início aprovados e registrados pelo operador na plataforma.
- [ ] Fuso horário IANA e endereço operacional confirmados pela pizzaria.
- [ ] Endereço e instruções de entrega, regiões atendidas, taxa fixa, pedido mínimo, horários, exceções, pausa e meios de pagamento presencial confirmados.
- [ ] Nome público, logotipo, cores e imagens aprovados; os arquivos enviados não contêm material sem autorização.
- [ ] Cardápio revisado pela pizzaria: categorias, tamanhos, sabores e preços, bordas, adicionais, produtos, disponibilidade e regras de meio a meio.
- [ ] Preços e cardápio foram conferidos no painel por OWNER/MANAGER com acesso da pizzaria.

## 2. Preparar e verificar tenant

1. Em **ambiente autorizado**, crie o tenant pela área de plataforma. Não crie tenant de produção com dados fictícios.
2. Convide o OWNER da pizzaria pelo fluxo de convite de uso único. Confirme o vínculo e a conclusão de MFA exigida para operadores; a senha nunca deve ser compartilhada com o WhiteOven.
3. Registre o UUID e o slug acima e confira que o painel, a API pública e o app apontam para essa mesma loja.
4. Defina o plano vigente pelo fluxo da plataforma e confira a data efetiva e o snapshot de valores.
5. Publique os documentos legais e confira as páginas públicas de privacidade, termos e exclusão de conta.
6. Configure a loja e o cardápio conforme os dados aprovados. Valide um conjunto representativo de pizzas inteiras e meio a meio, adicionais, entrega e retirada.

## 3. Prontidão operacional do ambiente

- [ ] Deploy feito pelo procedimento aprovado e com o commit registrado acima.
- [ ] `GET /health/ready` retorna sucesso pela rede interna; banco PostgreSQL e API estão saudáveis.
- [ ] Proxy público encaminha apenas as rotas previstas, termina TLS e não expõe `/metrics`, OpenAPI ou a porta interna da API.
- [ ] Segredos de produção foram carregados no gestor de segredos e têm cópia/recuperação operacional; nenhum segredo foi colocado no repositório.
- [ ] Operadores ativos estão com MFA: `pnpm api:check-operators-mfa` concluiu com zero operadores sem MFA.
- [ ] Checklist [M7.3 de segurança](security-review.md) preenchido para este ambiente, incluindo todos os itens marcados **no ambiente**.
- [ ] Backup de PostgreSQL e imagens está configurado e cifrado fora do host; uma restauração foi executada e registrada conforme [backup e restauração](api-backup-restore.md).
- [ ] Monitor e webhook do canal aprovado estão configurados; o ensaio real de alerta e recuperação está registrado em [observabilidade](observability.md).
- [ ] Responsáveis da pizzaria sabem como pausar a loja, marcar itens indisponíveis e acompanhar/cancelar pedidos.

## 4. Build e publicação

Siga o [runbook de publicação mobile](mobile-publishing.md), que cobre as contas Apple/Google da pizzaria, acesso convidado, Firebase/EAS, credenciais de assinatura, fichas e submissão. Antes de gerar os builds:

- [ ] Manifesto `apps/mobile/manifests/{slug}.json` e identificadores definitivos aprovados pela pizzaria.
- [ ] Ícone e dados da marca revisados no app compilado.
- [ ] Documentos legais publicados na API; `pnpm mobile:release-check {slug} store` terminou sem pendências.
- [ ] Builds de preview instalados e fluxos de cadastro, menu, cotação, pedido, histórico, exclusão de conta e notificações exercitados com contas e dados sintéticos.
- [ ] A pizzaria aprovou o build de loja e os metadados das fichas.
- [ ] Apps publicados/disponíveis nas lojas, ou distribuição de teste aceita pela pizzaria registrada aqui.

| Plataforma | Identificador do app | Versão/build | URL ou referência da loja | Data |
| ---------- | -------------------- | ------------ | ------------------------- | ---- |
| iOS        |                      |              |                           |      |
| Android    |                      |              |                           |      |

## 5. Ensaio antes de aceitar pedidos

- [ ] Cliente de teste consegue instalar/abrir o app, localizar a loja, criar conta e aceitar as versões legais vigentes.
- [ ] Horários aberto/fechado, pausa, indisponibilidade e retomada mostram o estado esperado.
- [ ] Entrega e retirada exibem corretamente valores, taxas e meios de pagamento presencial.
- [ ] A loja recebeu um pedido sintético de ponta a ponta, aceitou, avançou os estados e o cliente viu o histórico/estado atualizado.
- [ ] Pedido sintético gerou um lançamento coerente no ledger de teste e qualquer cancelamento/estorno foi exercitado conforme as regras do M6.2.
- [ ] Push opt-in/opt-out e entrega de mudança de estado verificados sem dados pessoais desnecessários na notificação.
- [ ] Equipe da pizzaria concluiu treinamento breve usando os próprios aparelhos/contas de teste.

Registre apenas referências não sensíveis dos pedidos sintéticos e descarte as contas de teste conforme a política acordada.

## 6. Primeiro pedido real e conferência financeira

Faça esta etapa com a pizzaria, depois dos itens anteriores. Não coloque nome, telefone, endereço ou conteúdo pessoal do cliente neste registro; use o identificador interno do pedido.

| Evidência                                                         | Registro |
| ----------------------------------------------------------------- | -------- |
| Data/hora local do pedido                                         |          |
| ID interno do pedido                                              |          |
| Número exibido ao cliente                                         |          |
| Estado final `COMPLETED` e autor da transição                     |          |
| Plano/snapshot aplicado                                           |          |
| `BillingEntry` do pedido (ID interno)                             |          |
| Componentes conferidos: subtotal, taxa, total e método presencial |          |
| Resultado e divergências                                          |          |
| Responsável da pizzaria que confirmou                             |          |
| Responsável WhiteOven que conferiu                                |          |

- [ ] O cliente fez o pedido pelo app publicado e a pizzaria o recebeu no painel.
- [ ] A equipe concluiu o pedido pela transição autorizada; horário e autoria aparecem no histórico.
- [ ] Existe exatamente o lançamento de conclusão esperado, vinculado ao pedido e ao plano vigente, sem dados pessoais.
- [ ] Valor e período local do lançamento batem com o snapshot do pedido e as regras de cobrança.
- [ ] O relatório mensal do tenant reconcilia o lançamento como estimativa; divergências foram investigadas e resolvidas.
- [ ] O cliente recebeu a atualização final e a pizzaria confirmou que o fluxo foi concluído.

## 7. Aceite do piloto

| Papel                    | Nome | Data | Aceite |
| ------------------------ | ---- | ---- | ------ |
| Responsável da pizzaria  |      |      |        |
| Responsável pelo produto |      |      |        |
| Responsável técnico      |      |      |        |

O M7.5 só pode ser marcado concluído depois do pedido real acima e da conferência do `BillingEntry`. Registre a versão do app, commit do servidor, IDs internos de evidência e pendências remanescentes em local operacional aprovado. Não marque como concluído por ter apenas configurado tenant, cardápio ou builds.
