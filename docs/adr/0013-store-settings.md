# ADR 0013: configurações da loja, horários e pausa

- **Status:** implementado em M3.4
- **Data:** 2026-10-25
- **Milestone:** M3.4

## Contexto

O [modelo de domínio](../architecture/domain-model.md#storesettings) define `StoreSettings`, `OpeningRule`, `ClosureException` e a pausa manual. M3.4 precisa deixar o OWNER configurar tudo isso no painel e testar horários que cruzam a meia-noite. M4.1 vai calcular "loja aberta" a partir desses dados. A política de preço já existia em `PUT /v1/admin/catalog/pricing-policy`.

## Decisão

- **Três tabelas por tenant**, todas com RLS forçada:
  - `store_settings` guarda modos de atendimento, taxa de entrega fixa (Q-04, zero permitido), pedido mínimo, área de entrega em texto, tempos de preparo e entrega, tempo de aceite (Q-07, padrão de 10 minutos), formas de pagamento, telefone e endereço de retirada. As restrições `check` repetem as regras da API.
  - `store_opening_hours` guarda `rules` e `exceptions` como JSON, numa linha por loja.
  - `store_pauses` tem uma linha enquanto há pausa. `paused_until` nulo significa até alguém reabrir.
- **Horários são salvos inteiros** (`PUT /v1/admin/store/opening-hours`). Um turno pode se sobrepor ao dia anterior ou ao seguinte (sexta 18:00–02:00 contra sábado 01:00), e uma exceção muda os vizinhos efetivos. Por isso a validação olha a semana e as exceções juntas, e a gravação é atômica. Isso gera um evento de auditoria por gravação.
- **Regras puras em `apps/api/src/store/store-rules.ts`:**
  - Cada turno é um intervalo semiaberto em minutos a partir da data operacional em que começa. Um fechamento menor que a abertura passa de 1440.
  - As regras semanais são comparadas em duas semanas seguidas, para que sábado à noite seja comparado com domingo.
  - Cada data de exceção é comparada com os turnos efetivos da véspera e do dia seguinte.
  - As regras semanais valem sozinhas: uma exceção muda só a sua data e nunca torna válida uma semana com sobreposição.
  - Cada conflito vira um erro só, no turno que começa depois (o conflito entre sábado e domingo aparece uma vez, embora as duas semanas sejam comparadas). Contra uma regra semanal, o erro fica no turno substituto da exceção (`exceptions[0].shifts[1]`); entre duas exceções, no turno que começa depois. Os erros da semana e das exceções saem juntos, na ordem do formulário (regras, depois exceções, por índice). Com data repetida, as sobreposições das exceções esperam a correção, porque a data não tem um horário efetivo único.
  - O erro `422 OPENING_HOURS_INVALID` traz em `details.errors` o `code` (`OPENING_HOURS_OVERLAP`, `OPENING_HOURS_DUPLICATE_DATE` ou `OPENING_HOURS_INVALID`) e o caminho da entrada (`rules[2]`, `exceptions[0].shifts[1]`). `shiftsOfDate` aplica a precedência do domínio (fechado, horário substituto, regra semanal) e é a base de M4.1.
- **Fronteira de validação dos horários:** o banco confere só que `rules` e `exceptions` são listas JSON. As regras de domínio ficam em `validateOpeningHours`, pelos motivos abaixo, e não são repetidas em PL/pgSQL:
  - O único papel que grava em tempo de execução é `whiteoven_app`, e o único caminho dele é `PUT /v1/admin/store/opening-hours`, que valida antes de gravar e grava o valor normalizado.
  - O trigger recusa a gravação sem sessão viva de OWNER da mesma loja, e a RLS forçada impede tocar outra loja.
  - O papel `whiteoven_owner` só roda migrations.
  - Repetir a regra de sobreposição (semana circular, vizinhos efetivos de cada exceção) em SQL criaria duas cópias para manter em sincronia.
  - M4.1 vai ler os horários com `shiftsOfDate`. Um novo caminho de gravação precisa passar por `validateOpeningHours`.
- **As regras ficam na API e não em `packages/contracts`.** A API compila para CommonJS e ainda não consome o pacote ESM com fontes `.ts` ([ADR 0004](0004-api-foundation.md), [ADR 0007](0007-staff-authentication.md)). Ligar o pacote ao build e à imagem Docker da API seria uma mudança de infraestrutura fora deste passo. O painel não duplica a regra de sobreposição: confere só o formato e mostra os caminhos que a API devolve, ao lado da linha certa.
- **Papéis:**
  - Configurações e horários: só o OWNER grava, pela nova capacidade `storeSettingsWrite` (`ONBOARDING` e `ACTIVE`). O MANAGER pode ler.
  - Pausa: qualquer pessoa da equipe pausa e reabre (`storePause`), por 15, 30 ou 60 minutos ou até reabrir.
  - Loja suspensa não grava nada (`403 STORE_WRITE_FORBIDDEN`).
- **Auditoria por trigger** `security definer`, como no catálogo. O trigger confere a sessão viva do ator e recusa no banco um papel que a API também recusaria. Ações registradas: `store.settings.updated`, `store.opening_hours.updated`, `store.pause.started` e `store.pause.ended`. Ele usa as mesmas variáveis de transação do catálogo (`app.catalog_actor_id`, `app.catalog_session_id`, `app.catalog_request_id`).
- **Painel:**
  - `/loja/configuracoes` (OWNER) tem três seções salvas separadamente. Salvar uma não descarta o que foi digitado nas outras.
  - Política de preço: a prévia calcula exemplos inteira e meio a meio com `evaluatePizza` e a política digitada, antes de salvar.
  - Horários: semana a partir da segunda, com "fecha no dia seguinte" e exceções por data.
  - Pedidos e entrega: modos de atendimento, taxa, pedido mínimo, tempos, formas de pagamento, telefone e endereço de retirada.
  - A pausa fica no Início, para todos os papéis. A API devolve a pausa com o fuso da loja (`timezone`) e guarda o fim como instante UTC. O painel mostra a hora no fuso da loja, não no do navegador.
  - Uma pausa com hora marcada tem um timer até o fim. Ao expirar, o cartão mostra a loja reaberta e confirma com a API, porque alguém pode ter pausado de novo. Uma falha nessa consulta é repetida até três vezes, a cada 30 segundos, e depois aparece. Não há consulta periódica. Uma resposta atrasada, uma troca de loja ou o fim do cartão descartam o que estava em andamento.
  - `privacyPolicyVersion` fica para M4.2, com a conta do cliente.

## Alternativas descartadas

- **Uma linha por regra e por exceção:** facilita consultas, mas a validação precisa do conjunto inteiro, e uma gravação geraria dezenas de eventos de auditoria por remoção e inclusão.
- **Pausa em `store_settings`:** obrigaria o trigger a deixar a STAFF alterar só uma coluna da linha do OWNER. Uma tabela própria deixa a regra de papel simples.
- **Ligar `packages/contracts` à API agora:** daria uma só cópia das regras para o painel e a API, mas mexe no build CommonJS e no Dockerfile. Fica registrado como trabalho futuro.

## Consequências

- O horário vale no fuso do tenant (`tenants.timezone`), que o painel mostra.
- O status público "aberta ou fechada" e os cenários H1–H10 continuam em M4.1, sobre `shiftsOfDate` e `store_pauses`.
- Um tenant só passa a `ACTIVE` com horários (domain-model). Essa verificação entra quando a ativação passar a exigir os pré-requisitos.
