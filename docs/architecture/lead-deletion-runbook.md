# Exclusão de leads — banco, exports e backups

Procedimento manual da M0.1-B. Não há CRM, portal de titular ou remoção automática de cópias secundárias. Nenhuma exclusão de dados reais foi executada como parte desta implementação.

## Pré-condição operacional

O controlador nomeia um operador autorizado e mantém, fora do Git, registros de solicitações, inventário de exports/backups e um diário mínimo de exclusões para recuperação. Guardar em local restrito/cifrado; arquivos locais e diretórios devem ter modos 0600/0700. Não inserir WhatsApp, nome ou payload completo em tickets, logs, PRs ou evidências. UUID de lead também deve ser tratado como dado restrito. Não existe arquivo real de inventário ou diário versionado por este documento.

Cada export/backup precisa ser inventariado **ao criá-lo**: identificador da cópia, localização restrita, responsável, destinatários autorizados, intervalo de datas/IDs cobertos, data de criação, prazo de eliminação, criptografia/chave e possibilidade de excluir individualmente. A CLI só cria o JSON; o operador registra o inventário antes de compartilhá-lo. Não fazer cópias não rastreadas. Backup tem prazo máximo de 30 dias da criação e não pode estender a retenção original de 180 dias dos leads. Configurar eliminação e validar cumprimento antes da captação pública.

## Atendimento e evidências

1. **Abrir caso restrito.** Gerar ID interno, registrar recebimento, operador e escopo. Confirmar a identidade de forma proporcional usando o canal já informado, evitando coletar documentos extras por padrão. Localizar todos os UUIDs abrangidos pelo pedido com acesso autorizado, sem imprimir PII em stdout. Não presumir que um único UUID representa todos os cadastros da pessoa.
2. **Interromper uso.** Suspender contato e processamento comercial dos registros abrangidos. Registrar UUIDs e data de exclusão no diário mínimo restrito **antes** de alterar o banco, para proteger restaurações em caso de falha. O diário não deve conter os campos comerciais completos.
3. **Excluir do banco ativo.** Com o mesmo ambiente e caminho de banco do serviço, executar `pnpm leads delete UUID_DO_CADASTRO` para cada UUID. O comando remove lead e chaves de idempotência associadas. Conferir ausência com `pnpm leads inspect`; guardar horário, código de saída, UUID e resultado, sem conteúdo do cadastro. “Não encontrado” não comprova exclusão em outras cópias.
4. **Tratar exports.** Consultar inventário e destinatários; apagar exports afetados e suas cópias/temporários, ou substituir por nova exportação do banco já saneado e eliminar a antiga. Não editar parcialmente JSON sem verificar o resultado. Obter confirmação dos destinatários autorizados, registrar cópia, responsável, ação e data. Se uma cópia não for localizada ou não houver confirmação, marcar como pendente; não declarar atendimento integral.
5. **Tratar backups.** Preferir eliminar backup afetado, inclusive versões/snapshots e réplicas, após confirmar que não compromete recuperação necessária dos demais dados. Se a cópia imutável não permitir remoção individual, isolá-la do acesso comercial, restringir acesso à recuperação e registrar impedimento, responsável e expiração em até 30 dias da criação, ou antes quando a retenção original do lead vencer. Chave de cifra dedicada pode ser destruída somente se autorizada e sem afetar dados não abrangidos. Cifrar sem restringir uso ou sem eliminar chave/cópia não equivale a exclusão.
6. **Responder e acompanhar.** Registrar ações concluídas e pendências com prazos. Informar ao titular o tratamento efetivamente realizado e eventual retenção restrita em backup até eliminação; não dizer que todas as cópias foram apagadas enquanto houver pendências. Verificar a destruição final e registrar evidência antes de encerrar o caso como concluído. Atendimento jurídico e prazos aplicáveis devem ser revisados pelo controlador; este runbook não substitui essa avaliação.

## Restauração segura

1. Restaurar em ambiente isolado, sem contato comercial e sem abrir inscrições.
2. Aplicar **todo o diário de exclusões posterior ao backup**, executando `pnpm leads delete UUID` em cada registro abrangido, e `pnpm leads purge` para expirados. Usar o caminho do banco restaurado; não reaplicar por engano somente no banco antigo.
3. Validar ausência dos UUIDs e dos registros expirados; conferir limites de acesso, retenção, configuração de identidade e proxy. Somente depois liberar o serviço restaurado.
4. Inventariar o novo estado/cópias, registrar operador, horários e evidências. Testar esse processo com dados sintéticos antes de aceitar leads reais.

Reter o diário mínimo somente enquanto existirem cópias restauráveis abrangidas ou casos ainda em atendimento; eliminar ao confirmar destruição de todas as cópias, salvo obrigação específica avaliada pelo controlador. Não colocar esse diário no mesmo backup antigo que ele precisa sanear; manter cópia atualizada e restrita para recuperação.

## Modelo de registro restrito (sem dados reais)

| Campo                         | Conteúdo a preencher pelo operador                           |
| ----------------------------- | ------------------------------------------------------------ |
| Caso / operador / recebido em | ID interno e responsável autorizado                          |
| Escopo confirmado             | UUIDs abrangidos, sem payload do lead                        |
| Banco ativo                   | Caminho restrito, horário, resultado e verificação           |
| Exports / destinatários       | IDs das cópias, ação, confirmação e data                     |
| Backups / versões             | IDs, exclusão ou isolamento, motivo e expiração              |
| Diário de recuperação         | Registro aplicado e revisão após restauração                 |
| Resposta ao titular           | Data e pendências informadas, sem contato em log público     |
| Conclusão                     | Data e evidência de eliminação final, ou pendência com prazo |

A implantação só deve abrir inscrições após definir responsáveis, inventário, rotina de expiração e ensaio de restauração. Este trabalho entrega o procedimento e o aviso da CLI; não manipula dados, exports ou backups de produção.
