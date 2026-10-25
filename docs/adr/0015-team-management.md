# ADR 0015: equipe da loja

- **Status:** implementado em M3.6
- **Data:** 2026-10-27
- **Milestone:** M3.6

## Contexto

O [modelo de domínio](../architecture/domain-model.md#membership) pede que toda loja mantenha ao menos um OWNER ativo e que o último OWNER não possa ser removido nem rebaixado. O critério de aceite do M3.6 é: o último OWNER fica protegido e a revogação encerra as sessões. O [ADR 0007](0007-staff-authentication.md) já verifica o vínculo a cada requisição, sem cache. Ainda não há provedor de e-mail (Q-12), então o convite, como o de dono do M1.5, é um link que a pessoa que convida copia e envia.

## Decisão

- **Funções `SECURITY DEFINER` para toda mudança,** no padrão do ADR 0008:
  - `whiteoven_team_invite`, `whiteoven_team_cancel_invite`, `whiteoven_team_change_role` e `whiteoven_team_revoke_member`.
  - Cada uma confere de novo, no banco, que quem age tem sessão viva nesta loja, usuário ativo, vínculo OWNER ativo e loja em `ONBOARDING` ou `ACTIVE`. Sem isso, a função recusa com `42501`.
  - A mudança e o evento de auditoria (`team.invite_created`, `team.invite_canceled`, `team.role_changed`, `team.member_revoked`, `team.invite_redeemed`) ficam na mesma transação.
  - A API também confere a capacidade `teamManage` do `TenantStatusPolicy` e responde `403 TEAM_WRITE_FORBIDDEN` com a loja suspensa. MANAGER e STAFF recebem `403 ROLE_FORBIDDEN` em todas as rotas de equipe.
- **Último OWNER protegido no banco.** Um trigger `before update` em `memberships` recusa com `P0011`, que a API devolve como `409 LAST_OWNER`, qualquer mudança que deixe a loja sem OWNER ativo, venha de onde vier. Um lock consultivo por loja serializa essas mudanças: quando dois donos rebaixam um ao outro ao mesmo tempo, só um consegue. O painel não mostra ações na linha do próprio OWNER; outro dono altera o papel dele.
- **Revogar encerra as sessões nesta loja.**
  - O vínculo passa a `REVOKED`. As sessões da pessoa cuja loja ativa é esta são revogadas na mesma transação, com o motivo novo `MEMBERSHIP_REVOKED`.
  - O token de acesso já emitido para de valer na requisição seguinte, porque o vínculo é lido a cada requisição, e o refresh é recusado.
  - Sessões da mesma pessoa em outras lojas continuam valendo.
  - Mudar o papel não encerra sessões: o novo papel vale na requisição seguinte.
- **Convites:**
  - Ficam na tabela de tenant `staff_invites`, com RLS forçada; a app só lê. O índice global `staff_invite_lookup` liga o hash do token à loja e nenhum papel de execução o lê.
  - O token tem 43 caracteres base64url e só o SHA-256 dele é guardado. O link é `/equipe/convite/{token}`, válido por 72 horas e de uso único. Ele aparece uma vez para o OWNER, como o convite de dono.
  - Papéis que podem ser convidados: OWNER, MANAGER e STAFF.
  - `Idempotency-Key` é obrigatório (system-overview). O token é derivado por HMAC da chave, da loja e do corpo, com o mesmo segredo dos convites de dono e outro domínio, então uma nova tentativa devolve o mesmo link. A mesma chave com outro corpo é `409 IDEMPOTENCY_CONFLICT`.
  - Um novo convite para o mesmo e-mail substitui o pendente, e o link anterior deixa de valer. Convidar quem já está ativo na loja é `409 ALREADY_MEMBER`.
- **Aceitar o convite** é público (`POST /v1/team/invites/preview` e `/redeem`). A prévia mostra loja, papel, e-mail e se a conta já existe. Token desconhecido, usado, cancelado ou vencido é sempre `410 INVITE_INVALID`, então os tokens não podem ser sondados.
  - Pessoa nova: informa nome e senha, com as mesmas regras de senha do login.
  - Pessoa que já tem conta: confirma com a senha atual, sob o mesmo bloqueio progressivo do login (`429 RATE_LIMITED`). A conta precisa estar ativa e ter o mesmo e-mail do convite.
  - Um vínculo `REVOKED` volta a `ACTIVE` com o papel do convite. Se a pessoa entrou na loja por outro caminho depois do convite, o resgate é `409 ALREADY_MEMBER` e o papel dela não muda.
- **Painel:** a página `/loja/equipe` é só do OWNER e é carregada sob demanda. Ela lista as pessoas ativas e os convites pendentes, gera o convite e mostra o link uma vez, altera o papel com um botão (não ao trocar o seletor) e revoga depois de uma confirmação. A página `/equipe/convite/{token}` tira o token da barra de endereço na hora, como a do convite de dono, e o guarda só na memória.

## Alternativas descartadas

- **Checar o último OWNER só na API:** um `update` direto ou duas requisições simultâneas passariam. O trigger com lock vale para qualquer escrita.
- **Tirar da app o `update` em `memberships`:** o `select ... for share` que o guard usa a cada requisição exige esse privilégio. As mudanças da app passam pelas funções e o trigger protege o resto.
- **Encerrar todas as sessões da pessoa:** ela perderia o acesso a outras lojas em que continua na equipe.
- **Token aleatório a cada tentativa:** uma resposta perdida faria a nova tentativa trocar o link, e o primeiro, talvez já enviado, deixaria de valer.

## Consequências

- O envio do convite por e-mail entra quando houver provedor (Q-12). O link e as regras continuam os mesmos.
- O trigger também vale para seeds e scripts. Os testes que rebaixam ou revogam donos mantêm outro OWNER na loja.
- `staff_invites` fica com o histórico dos convites (aceito, cancelado, substituído) para auditoria. A limpeza entra com a política de retenção.
