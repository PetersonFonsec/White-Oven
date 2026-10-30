# ADR 0027: avisos de pedido por push no app

- **Status:** em desenvolvimento em M5.5
- **Data:** 2026-10-30
- **Milestone:** M5.5

## Contexto

M5.4 (ADR 0023) mostra o andamento do pedido por polling, só com o detalhe aberto. Em 2026-10-30 o produto decidiu a Q-11: avisos ao cliente pelo Expo Push, opt-in. O roadmap pede token do dispositivo por cliente e por loja e nenhum dado pessoal no conteúdo além do necessário. Cada loja tem seu próprio binário (ADR 0020), e o projeto EAS de cada uma é criado na publicação (M5.6, Q-09).

## Decisão

- **Opt-in explícito:** o app só pede a permissão do sistema depois de o cliente tocar em "Ativar avisos do pedido" em Minha conta. Recusar a permissão não chama a API. Sem projeto EAS no manifesto (`easProjectId`), o build não inclui `expo-notifications` e a tela diz que os avisos não estão disponíveis.
- **Dispositivo da sessão:** `PUT /v1/customer/stores/{slug}/me/push-device` com `{ token }` (formato `ExponentPushToken[...]`) registra o dispositivo da sessão atual do cliente; `DELETE` remove; `GET` responde `{ enabled }`. Todas respondem `no-store`. Registrar exige loja ACTIVE; ler e remover funcionam em lojas suspensas e encerradas, como a conta.
- **Tabela `customer_push_devices`:** tenant, cliente, sessão e token, com RLS forçada. O token é único por loja e a sessão tem no máximo um token. Um token novo da mesma sessão substitui o anterior. Se outra conta da mesma loja entra no aparelho e ativa os avisos, o token passa para ela. Revogar uma sessão (logout, reuso de refresh, exclusão da conta) apaga o dispositivo dela, e a exclusão da conta apaga todos os dispositivos do cliente.
- **Fila no banco:** um gatilho `SECURITY DEFINER` em `order_status_changes` grava uma linha em `push_deliveries` para cada transição da loja ou do sistema para `PREPARING`, `READY`, `OUT_FOR_DELIVERY`, `COMPLETED`, `REJECTED` ou `CANCELED`. A linha só é gravada se o cliente do pedido tem um dispositivo com sessão viva naquele instante. `PLACED` e o cancelamento feito pelo próprio cliente não geram aviso. Como o gatilho fica na tabela de histórico, recusa por tempo esgotado e recusa por suspensão da loja também avisam. O papel da API lê e atualiza a fila, mas não insere nem apaga linhas: só existe aviso para algo que está no histórico do pedido.
- **Conteúdo mínimo:** título com o nome da loja e texto com o número e o novo estado do pedido (por exemplo, "Pedido #12 saiu para entrega."), mais `data: { type: "order-status", orderId }`. Nome do cliente, endereço, itens, valores, forma de pagamento e o texto livre do motivo nunca vão no aviso. Tocar no aviso abre o detalhe do pedido; o app só aceita ids de pedido nesse formato.
- **Envio:** com `PUSH_DELIVERY=expo`, um job a cada 10 segundos percorre as lojas e, em transação por loja, trava até 50 avisos pendentes (`FOR UPDATE SKIP LOCKED`). Ele envia à API HTTP do Expo em lotes de até 100, com timeout de 10 segundos. `EXPO_ACCESS_TOKEN` é opcional, para contas Expo com segurança reforçada. O padrão é `PUSH_DELIVERY=disabled`, e nada sai do servidor.
- **Resultado:** um ticket `ok` de qualquer dispositivo marca o aviso como `SENT`. `DeviceNotRegistered` apaga o dispositivo. Outros erros por mensagem marcam `FAILED`, exceto `MessageRateExceeded`, que volta para a fila. Falha da requisição inteira (rede, timeout, 429 ou 5xx, resposta inesperada) reagenda com espera de 30, 60, 120 e 240 segundos e desiste na quinta tentativa. Um aviso com mais de 30 minutos vira `EXPIRED` sem envio, porque um "saiu para entrega" atrasado só confunde. Sem dispositivo vivo no momento do envio, o aviso vira `SKIPPED`.
- **Entrega pelo menos uma vez:** se o processo cair depois de o Expo aceitar e antes do commit, o aviso é reenviado. Os logs registram só contagens e o tenant, nunca token ou texto.
- **Manifesto e app:** `easProjectId` (UUID) entra opcional no manifesto da loja. Quando presente, `app.config.ts` adiciona o plugin `expo-notifications`, `extra.eas.projectId` e `pushProjectId` na configuração de execução. Com o app aberto, o aviso aparece como banner, sem som.

## Consequências

O cliente acompanha o pedido sem manter a tela aberta, e a loja não precisa de nenhuma ação nova. O polling da M5.4 continua sendo a fonte da linha do tempo. A fila no banco segue o mesmo caminho de todas as transições, inclusive as feitas pelas funções de plataforma, e um aviso não pode ser forjado pela API.

O token de push é um dado do aparelho. Ele fica só enquanto a sessão que o registrou vive, e o aviso de privacidade aprovado (M7.2) precisa mencioná-lo. Os recibos assíncronos do Expo (`getReceipts`) não são consultados neste marco: um dispositivo desinstalado é removido quando o envio seguinte recebe `DeviceNotRegistered`. Linhas antigas da fila não são apagadas; a limpeza fica para quando houver volume.

Para enviar de verdade, cada loja precisa do projeto EAS e das credenciais FCM/APNs configuradas no Expo, o que faz parte da publicação (M5.6). Push não funciona no Expo Go do Android, só em builds de desenvolvimento ou de loja. Nenhum fornecedor novo é contratado por este marco: o Expo Push não cobra pelo envio.
