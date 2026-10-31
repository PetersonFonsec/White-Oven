# ADR 0010: armazenamento de imagens do catálogo

- **Status:** recomendação implementada para M2.5; Q-13 permanece aberta
- **Data:** 2026-10-24
- **Milestone:** M2.5

## Contexto

O catálogo precisa receber imagens sem confiar no nome, extensão ou tipo MIME enviados pelo cliente. A escolha de fornecedor de storage continua pendente em Q-13, e nenhum fornecedor externo foi aprovado. O ambiente de desenvolvimento já usa Compose e precisa persistir imagens entre reinícios.

## Decisão

- Definir uma interface `ImageStorage` para que o backend possa trocar a implementação sem alterar as rotas ou o modelo do catálogo.
- Implementar `LocalImageStorage` no diretório `IMAGE_STORAGE_DIRECTORY`; produção exige um caminho absoluto. O Compose de desenvolvimento monta o volume nomeado `image-data` nesse caminho.
- Aceitar somente PNG, JPEG e WebP até 5 MiB. Conferir o formato pelos bytes decodificados, limitar a 30 megapixels, remover metadados e gerar variantes WebP `thumbnail` (até 480 px) e `menu` (até 1600 px).
- Gerar UUIDs no servidor e armazenar em `tenants/{tenantId}/{assetId}/{variant}.webp`. Diretórios usam modo 0700 e arquivos 0600.
- Restringir upload e leitura a sessões da equipe OWNER/MANAGER, validar membership e estado do tenant na transação, aplicar RLS ao metadado e auditar a criação. Upload faz uma autorização curta antes da decodificação e revalida em uma segunda transação antes da gravação; `TenantTransactions` revalida sessão e membership e mantém locks durante a persistência. As rotas são administrativas e autenticadas; exposição pública de imagens pertence a milestone posterior.
- O contrato `ImageStorage` exige que `write` remova suas gravações parciais sempre que possível e repropague o erro original. `remove` é idempotente e limitado ao par tenant/asset. O storage local escreve em diretório novo e remove esse diretório se uma variante falhar; UUIDs em colisão não sobrescrevem nem removem conteúdo existente.
- Gravar arquivos antes do metadado e removê-los se INSERT ou COMMIT do banco falhar. Uma falha de remoção compensatória é registrada com evento, operação, tenant/asset e tipos de erro, sem mensagens ou caminhos do filesystem; o erro original continua sendo propagado. Uma falha de processo entre gravação e commit ainda pode deixar arquivo órfão; uma rotina de reconciliação fica para operação posterior.
- Quando o metadado existe mas uma variante não está no storage (`ENOENT`), responder `503 IMAGE_STORAGE_MISSING` e registrar a inconsistência. Outros erros de I/O continuam como falhas internas observáveis e não são convertidos em `404`.
- Respostas administrativas de imagem usam `Cache-Control: private, no-store` porque a autorização pode ser revogada. Endpoints públicos futuros definirão sua política separadamente. M5.2 criou a rota pública, restrita às imagens do cardápio público e ao logotipo, com `no-cache` e ETag ([ADR 0021](0021-mobile-menu-pizza-builder.md)).

## Consequências

- O desenvolvimento não depende de fornecedor externo, e uma futura implementação de storage pode substituir `ImageStorage`.
- O volume local é persistente, mas não é backup externo. Os bytes e o PostgreSQL precisam ser copiados e restaurados como um conjunto consistente antes de qualquer captação real. O runbook operacional da landing não inclui esse volume. M7.1 implementou essa cópia conjunta ([ADR 0029](0029-api-backup-restore.md)), que depende de as imagens nunca serem apagadas depois do commit.
- Q-13 permanece sem resposta; esta implementação segue a recomendação local configurável e não autoriza provisionamento ou implantação de produção.
- Variantes são regeneráveis somente a partir da imagem original, que não é retida; portanto backup deve incluir as variantes armazenadas, não apenas `image_assets`.
