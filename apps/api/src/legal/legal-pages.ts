import { createHash } from "node:crypto";
import {
  type LegalBlock,
  type LegalDocument,
  legalBlocks,
} from "@whiteoven/contracts";

/**
 * Server-rendered pages of a store's legal documents and of the account deletion request
 * (ADR 0030). No script, no external resource and no text from the database outside `escape`;
 * the only style is the fixed sheet below, allowed by its hash in the Content-Security-Policy.
 */

const STYLE = `
:root{color-scheme:light dark;--fg:#1f1a17;--muted:#5c534d;--bg:#fffaf5;--line:#e4d9cf;--accent:#8a2c0d;--alert:#9b1c1c}
@media (prefers-color-scheme:dark){:root{--fg:#f4ece6;--muted:#c4b8ae;--bg:#191512;--line:#3a322c;--accent:#f0a07a;--alert:#ff9b9b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem}
header{border-bottom:1px solid var(--line);margin-bottom:1.5rem;padding-bottom:1rem}
header p{margin:0;color:var(--muted)}
nav ul{display:flex;flex-wrap:wrap;gap:.5rem 1rem;list-style:none;margin:.75rem 0 0;padding:0}
a{color:var(--accent)}
h1{font-size:1.6rem;line-height:1.25;margin:.25rem 0}
h2{font-size:1.15rem;margin:1.75rem 0 .5rem}
.meta{color:var(--muted);font-size:.9rem}
.alert{border-left:4px solid var(--alert);padding:.5rem .75rem;color:var(--alert)}
form{display:grid;gap:1rem;margin-top:1.5rem}
label{display:grid;gap:.25rem;font-weight:600}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
input[type=email],input[type=password]{font:inherit;padding:.6rem .75rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:inherit}
input[type=checkbox]{width:1.25rem;height:1.25rem;margin-top:.15rem}
button{font:inherit;font-weight:600;padding:.75rem 1rem;border:0;border-radius:.5rem;background:var(--alert);color:#fff;cursor:pointer}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`;

const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** For every page: nothing loads but the inline sheet; forms post only back here. */
export const LEGAL_PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "img-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);

export type LegalPage = "privacidade" | "termos" | "excluir-conta";

const PAGE_TITLES: Record<LegalPage, string> = {
  privacidade: "Política de privacidade",
  termos: "Termos de uso",
  "excluir-conta": "Excluir conta",
};

const dateFormat = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeZone: "America/Sao_Paulo",
});

function layout(input: {
  storeName: string;
  slug: string;
  title: string;
  current?: LegalPage;
  content: string;
}): string {
  const base = `/lojas/${encodeURIComponent(input.slug)}`;
  const links = (Object.keys(PAGE_TITLES) as LegalPage[])
    .map((page) =>
      page === input.current
        ? `<li><a href="${base}/${page}" aria-current="page">${PAGE_TITLES[page]}</a></li>`
        : `<li><a href="${base}/${page}">${PAGE_TITLES[page]}</a></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)} · ${escapeHtml(input.storeName)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<p>${escapeHtml(input.storeName)}</p>
<nav aria-label="Documentos da loja"><ul>${links}</ul></nav>
</header>
${input.content}
</main>
</body>
</html>
`;
}

function renderBlocks(blocks: LegalBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "heading") return `<h2>${escapeHtml(block.text)}</h2>`;
      if (block.type === "list")
        return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      return `<p>${escapeHtml(block.text)}</p>`;
    })
    .join("\n");
}

export function documentPage(input: {
  storeName: string;
  slug: string;
  page: "privacidade" | "termos";
  document: LegalDocument | null;
}): string {
  const title = PAGE_TITLES[input.page];
  const content = input.document
    ? `<h1>${title}</h1>
<p class="meta">Versão ${escapeHtml(input.document.version)}, publicada em ${dateFormat.format(new Date(input.document.publishedAt))}.</p>
${renderBlocks(legalBlocks(input.document.body))}`
    : `<h1>${title}</h1>
<p>Esta loja ainda não publicou este documento.</p>`;
  return layout({ ...input, title, current: input.page, content });
}

export type DeletionOutcome =
  "form" | "deleted" | "invalid" | "incomplete" | "rate-limited";

const DELETION_MESSAGES: Partial<Record<DeletionOutcome, string>> = {
  invalid: "E-mail ou senha incorretos. Nenhuma conta foi excluída.",
  incomplete:
    "Informe o e-mail e a senha da conta e confirme que entende que a exclusão não pode ser desfeita.",
  "rate-limited":
    "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
};

export function deletionPage(input: {
  storeName: string;
  slug: string;
  outcome: DeletionOutcome;
}): string {
  const store = escapeHtml(input.storeName);
  const base = `/lojas/${encodeURIComponent(input.slug)}`;
  if (input.outcome === "deleted")
    return layout({
      ...input,
      title: "Conta excluída",
      current: "excluir-conta",
      content: `<h1>Conta excluída</h1>
<p role="status">Sua conta na ${store} foi excluída. Seus dados pessoais foram removidos e todas as sessões abertas no app foram encerradas.</p>`,
    });
  const message = DELETION_MESSAGES[input.outcome];
  return layout({
    ...input,
    title: PAGE_TITLES["excluir-conta"],
    current: "excluir-conta",
    content: `<h1>Excluir sua conta</h1>
<p>Você pode excluir sua conta na ${store} pelo app, em <strong>Minha conta</strong>, ou por esta página, sem precisar instalar o app.</p>
<h2>O que é excluído</h2>
<ul>
<li>Nome, e-mail, telefone e senha da conta.</li>
<li>Endereços salvos e aparelhos cadastrados para avisos do pedido.</li>
<li>Todas as sessões abertas, que são encerradas na hora.</li>
</ul>
<h2>O que é mantido</h2>
<ul>
<li>Os pedidos já feitos, com itens, valores e datas, sem seu nome, telefone, endereço ou observações, para os registros da loja.</li>
<li>O registro de quais versões dos termos e da política de privacidade você aceitou e quando, sem dados pessoais.</li>
</ul>
<p>Os prazos de guarda estão na <a href="${base}/privacidade">política de privacidade</a>. A exclusão não pode ser desfeita.</p>
${message ? `<p class="alert" role="alert">${message}</p>` : ""}
<form method="post" action="${base}/excluir-conta">
<label>E-mail da conta<input type="email" name="email" autocomplete="username" required maxlength="254"></label>
<label>Senha<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>
<label class="check"><input type="checkbox" name="confirm" value="yes" required> Entendo que a exclusão é definitiva.</label>
<button type="submit">Excluir minha conta</button>
</form>`,
  });
}

/** For a store that does not exist, is unavailable, or a request that failed. */
export function errorPage(status: number): string {
  const [title, text] =
    status === 404
      ? ["Página não encontrada", "Confira o endereço da loja."]
      : status === 403
        ? [
            "Loja indisponível",
            "Esta loja não está disponível no momento. Fale diretamente com a pizzaria.",
          ]
        : ["Não foi possível concluir", "Tente novamente em alguns minutos."];
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body><main><h1>${title}</h1><p>${text}</p></main></body>
</html>
`;
}
