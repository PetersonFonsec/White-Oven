# ADR 0022: conta, carrinho e checkout no app

- **Status:** implementado localmente em M5.3, aguardando revisão
- **Data:** 2026-10-28
- **Milestone:** M5.3

## Contexto

O M5.2 foi integrado pela PR #34. O próximo marco do roadmap é M5.3: conta obrigatória por loja (Q-05, ADR 0017), carrinho local, cotação e criação de pedido (ADR 0018). A API já oferece cadastro, login, refresh rotativo, endereços, exclusão por anonimização e pedidos idempotentes. O app precisava conectar esses contratos sem duplicar pedidos quando a resposta se perde.

## Decisão

- **Sessão:** access token apenas em memória; refresh token no `expo-secure-store`. Cada namespace inclui o hash de API + slug. Requisições autenticadas usam o slug do manifesto e nunca recebem um tenant do formulário. O cliente não usa cookies nem segue redirecionamentos autenticados.
- **Rotação:** requisições concorrentes compartilham um refresh. O token anterior é consumido no armazenamento antes de enviá-lo para rotação. Se a resposta se perder, o app solicita login novamente em vez de reenviar um token consumido e revogar a sessão por reuso. O logout só se apresenta como concluído depois da revogação na API; falha mantém uma forma de tentar novamente.
- **Conta:** cadastro com aceite explícito do texto/versão configurados no manifesto; login, logout, endereços (criar, editar, remover) e exclusão com nova senha e confirmação. A conta continua acessível quando a loja está indisponível, conforme ADR 0017. Recuperação de senha por e-mail não integra este marco.
- **Privacidade:** `privacyPolicy: { version, text }` é opcional no manifesto; sem configuração válida, cadastro fica desabilitado. Os dois manifestos de demonstração contêm aviso explicitamente restrito a dados sintéticos. O texto jurídico aprovado e a política de publicação continuam no M7.2. O aviso demonstrativo não é aprovação para uso com clientes reais.
- **Carrinho:** até 30 linhas, 1–20 unidades por linha, somente IDs, configurações e descrições; preços são calculados novamente com `pizza-pricing`. Itens indisponíveis continuam visíveis, marcados e bloqueados para checkout. Cada metade, borda, adicional e remoção aparece na descrição. Alterações persistem antes de serem publicadas na tela.
- **Persistência:** sessão e estado comercial ficam em registros separados no SecureStore, fora do cache público de marca. O estado comercial contém carrinho, eventual confirmação pendente e recibo mínimo; não salva senha, access token ou cadastro de endereços. Como a confirmação pode conter observações, todo o estado comercial é protegido pelo armazenamento seguro. Registros grandes são divididos em blocos Unicode pequenos, escritos sob um UUID novo, seguidos de um ponteiro de commit. Um erro anterior ao commit mantém a versão anterior legível. Blocos antigos são removidos após o commit; falhas de limpeza não invalidam um commit concluído. Dados ilegíveis impedem novos envios em vez de serem descartados silenciosamente.
- **Configurações públicas:** o perfil existente `GET /v1/public/stores/{slug}` passa a incluir `checkout` (ou `null` sem configuração): modos de atendimento, taxa fixa, mínimo, descrição da área, formas de pagamento e endereço de retirada. Uma projeção SQL explícita, sob `TenantTransactions`, evita publicar campos internos. Não há rota ou tabela nova. A matriz de isolamento cobre a leitura de duas lojas com headers/query de outra loja ignorados.
- **Cotação:** exige sessão, cardápio válido/atualizado, status aberto confirmado e configurações carregadas. A API continua sendo a autoridade. O usuário escolhe atendimento, endereço e pagamento offline, informa troco opcional em centavos e observações. A tela mostra subtotal, taxa e total da API. Divergência da estimativa exige confirmação explícita do novo total. Alterar formulário, carrinho, endereço, navegação ou atualizar loja/cardápio invalida a cotação, inclusive respostas que cheguem depois dessa invalidação.
- **Criação:** a confirmação congela corpo, total aceito, UUID criptográfico (`expo-crypto`), conta e instante; salva tudo antes de chamar a API. Durante uma confirmação pendente, o carrinho fica bloqueado. Duplo toque não cria requisições concorrentes. Depois de resposta perdida ou reinício, a mesma conta reenvia exatamente corpo e chave. O recibo mínimo e o esvaziamento do carrinho são um único commit local; se esse commit falhar, a tentativa permanece recuperável com a chave original.
- **Rejeição vs incerteza:** erros explícitos de preço, validação, itens ou loja fechada liberam nova cotação, pois a transação recusou a criação. Rede, 5xx, resposta inválida ou conflito de idempotência preservam a confirmação. Trocar de conta não permite reenviá-la nem descartá-la. Após 23 horas (margem conservadora para as 24 horas da API), ou relógio voltando para antes da confirmação, o app não reenvia automaticamente. O cliente precisa conferir o resultado com a pizzaria e reconhecer isso explicitamente para liberar o carrinho; liberar não cancela um pedido recebido.
- **Navegação:** `screenFor` continua decidindo a tela. Loja indisponível fecha builder e checkout; Minha conta é a exceção intencional para permitir leitura/exclusão. Retomar o app atualiza loja/cardápio. Não há polling de pedidos, histórico, push ou pagamento online neste marco (M5.4/M5.5 e Q-03).

## Validação

- Testes puros de carrinho, persistência com Unicode e falhas, namespace por loja, rotação concorrente, refresh com resposta perdida, idempotência após reinício, conta diferente, expiração e preço alterado.
- `pnpm test:e2e:mobile` compila os fixtures da API e executa o cliente/controlador reais do app contra NestJS e PostgreSQL descartável: cadastro, endereço, builder, carrinho, quote, criação, resposta perdida, reinício, recuperação com loja fechada, preço alterado e exclusão/anonimização. Usa somente dados sintéticos e requer `TEST_DATABASE_OWNER_URL`. A CI executa esse fluxo.
- Bundle Hermes de iOS e Android por Expo. Esse teste de integração é de fluxo/contrato; não substitui teste visual e de Keychain/Keystore em aparelho ou simulador antes da publicação.

## Consequências

`expo-secure-store` e `expo-crypto` são as únicas dependências novas. O `expo-file-system` existente não oferece proteção de credenciais; `Math.random` não é usado para chaves. Não há novo fornecedor, migração ou infraestrutura. Reinstalação, indisponibilidade do armazenamento seguro e limpeza de dados do sistema não são uma garantia de recuperação; o comprovante da loja continua sendo a referência quando o resultado local não pode ser determinado.
