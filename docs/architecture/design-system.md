# Identidade visual WhiteOven

## Implementado na M0

A landing usa `packages/design-tokens/tokens.json` como fonte dos tokens de cores, tipografia, espaçamentos, raios, sombra e interações. O layout Astro converte os valores em variáveis CSS durante o build. A identidade combina laranja #FF922B, superfícies #FFFFFF e #FFF8F0 e texto #252525, com cards arredondados e tipografia sans-serif do sistema, sem download de fontes.

Botões laranja usam texto carvão. Textos de destaque usam o token `accentText`, mais escuro, para manter contraste sobre superfícies claras. Links têm alvo mínimo de 44px, foco visível e navegação por teclado; há atalho para o conteúdo e redução de movimento conforme preferência do sistema.

Loading, erro, vazio e desabilitado possuem tokens semânticos e estilos básicos (`skeleton`, `status`, `status--error`, `aria-busy` e `disabled`). A página estática não simula esses fluxos. Interfaces futuras deverão anunciar carregamento com `role="status"`, erros urgentes com `role="alert"` e manter mensagens compreensíveis sem depender somente de cor. Não declarar conformidade WCAG AA sem auditoria completa de teclado, leitor de tela e layout.

A foto da pizza é carregada do Unsplash (images.unsplash.com); depende de rede no navegador. Dimensões reservadas evitam deslocamento de layout, e o texto alternativo permanece disponível em caso de falha. Antes da publicação, revisar direitos e considerar um arquivo otimizado hospedado junto ao site.

## Consumo futuro e white label

Angular poderá importar o mesmo JSON e mapear tokens para CSS. React Native poderá importar cores e valores numéricos para StyleSheet; tipografia e sombras requerem adaptação às APIs nativas. Esses aplicativos e adaptadores ainda não existem.

Cada pizzaria deverá fornecer overrides restritos dos tokens semânticos de marca, cores de interação e conteúdo de identidade (nome, logotipo, imagens e textos alternativos). A configuração deverá mesclar overrides com os padrões WhiteOven; tokens de acessibilidade e feedback não devem desaparecer. Validar esquemas, formatos de mídia e pares de contraste antes de aceitar um tema: texto normal 4,5:1, texto grande 3:1 e componentes/foco 3:1. Alterar a primária exige revisar também `onPrimary`, hover, pressed e os contrastes nas superfícies. Não existe editor, persistência ou resolução de tenant em M0.

Os tokens são compartilhados; não impor CSS, fontes web ou componentes DOM ao aplicativo nativo.
