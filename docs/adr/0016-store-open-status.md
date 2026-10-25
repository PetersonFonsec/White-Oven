# ADR 0016: status público de loja aberta

- **Status:** implementado em M4.1
- **Data:** 2026-10-28
- **Milestone:** M4.1

## Contexto

O M3.4 ([ADR 0013](0013-store-settings.md)) já grava e valida turnos, exceções por data operacional e pausa, e expõe `shiftsOfDate`. Falta responder se a loja está aberta num instante, como define o [modelo de domínio](../architecture/domain-model.md#openingrule-e-closureexception), e publicar essa resposta para a vitrine. O critério de aceite do M4.1 é: cenários H1–H10 passam e turnos sobrepostos são rejeitados.

## Decisão

- **Função pura `storeStatusAt`** (`apps/api/src/store/store-status.ts`):
  - Recebe o status do tenant, o fuso, os horários, a pausa e o instante. Não lê banco nem relógio, então H1–H10 são testes de unidade.
  - Ordem: tenant diferente de `ACTIVE` dá `TENANT_NOT_ACTIVE`. Pausa vigente (`pausedUntil` nulo ou depois do instante) dá `PAUSED`. Depois disso, a loja está aberta se a hora local cair num turno da data operacional ou da véspera, deslocado em 24 horas. Senão, `OUTSIDE_HOURS`.
  - O instante vira data e minuto locais com `Intl.DateTimeFormat` no fuso IANA do tenant. Um instante sempre tem uma única hora de parede, então o horário de verão não precisa de caso especial: na hora repetida, as duas 01:30 contam como 01:30.
  - Os segundos são descartados. Como os turnos começam e terminam em minutos inteiros e são semiabertos, 01:59:59 ainda está no turno que fecha às 02:00.
  - Um fuso desconhecido lança erro em vez de supor um. Hoje só existe o padrão `America/Sao_Paulo`.
- **Endpoint `GET /v1/public/stores/{slug}/status`**, com `@StoreTenant()` e sem autenticação:
  - Responde `{ open, reason, pausedUntil, timezone, checkedAt }`. `pausedUntil` só vem preenchido durante uma pausa com fim, para a vitrine mostrar quando a loja volta.
  - Status do tenant, fuso, horários, pausa e `now()` vêm de uma única consulta. O relógio é o do banco, o mesmo que grava `store_pauses.paused_until`, então pausa e horário nunca usam relógios diferentes.
  - `Cache-Control: no-store`, porque a resposta muda com o relógio e com cada pausa.
  - Loja desconhecida responde `404` e loja que não está `ACTIVE` responde `403 TENANT_NOT_ACTIVE`, como o cardápio público. O motivo `TENANT_NOT_ACTIVE` no corpo só aparece se o status mudar entre o guard e a consulta.
- **Sem tabela nova nem migration.** A rota lê `store_opening_hours` e `store_pauses` com o contexto anônimo do tenant, sob a RLS existente.
- **Turnos sobrepostos** continuam rejeitados na gravação por `validateOpeningHours` (M3.4), inclusive entre dias vizinhos. O status só lê horários que passaram por essa validação.

## Consequências

- O pedido (M4.5) e a vitrine (M4.x) usam a mesma função para decidir se aceitam pedido, sem uma segunda cópia da regra.
- A resposta não diz quando a loja abre de novo fora de pausa. Calcular a próxima abertura exige converter hora local em instante perto de mudanças de horário de verão, e fica para quando a vitrine precisar.
- O teste de integração do fuso usa `Pacific/Kiritimati` e `Pacific/Pago_Pago`, que estão a 25 horas de distância, então os dias da semana locais sempre diferem.
