# Termos e política de privacidade das lojas

Como o operador publica os textos de uma pizzaria ([ADR 0030](../adr/0030-legal-documents.md)). Os textos vêm do jurídico: o WhiteOven não escreve nem edita nenhum deles.

## Antes de publicar

- [ ] Texto final da **política de privacidade** e dos **termos de uso** da pizzaria, aprovados pelo jurídico e pela pizzaria.
- [ ] Contrato de operador de dados entre o WhiteOven e a pizzaria assinado (fora da plataforma). Anote a versão assinada no checklist de onboarding (M7.5).
- [ ] Nome da versão, por exemplo `2026-11` ou `2026-11.1`: letras, números, ponto, hífen e sublinhado, até 40 caracteres. Nunca `demo-…` para clientes reais.

## Formato do texto

Texto simples, sem HTML:

- uma linha em branco separa blocos;
- `## Título` no começo de um bloco vira título;
- um bloco em que toda linha começa com `- ` vira lista;
- qualquer outro bloco é um parágrafo.

## Publicar

Com uma sessão de operador com MFA (o access token do painel), uma chamada por documento:

```sh
curl -sS -X POST "$API/v1/platform/tenants/$TENANT_ID/legal-documents" \
  -H "authorization: Bearer $ACCESS_TOKEN" -H "content-type: application/json" \
  --data @politica.json   # {"kind":"PRIVACY_POLICY","version":"2026-11","body":"..."}
```

`kind` é `PRIVACY_POLICY` ou `TERMS_OF_USE`. A resposta `201` publica uma versão nova; `200` quer dizer que a mesma versão com o mesmo texto já existia; `409 LEGAL_VERSION_CONFLICT` quer dizer que essa versão já existe com outro texto. Uma correção, por menor que seja, é uma versão nova. Nada é apagado nem alterado depois de publicado.

`GET /v1/platform/tenants/$TENANT_ID/legal-documents` lista todas as versões.

## Conferir

- `$API/lojas/{slug}/privacidade` e `$API/lojas/{slug}/termos` mostram a versão vigente.
- `$API/lojas/{slug}/excluir-conta` é a URL de exclusão de conta para o Google Play.
- `pnpm mobile:release-check {slug} store --eas` confere que a API do build serve os dois documentos e que nenhum é demonstrativo.
- Clientes já cadastrados veem o aviso de nova versão em Minha conta e aceitam por lá. Neste marco, a nova versão não bloqueia pedidos.
