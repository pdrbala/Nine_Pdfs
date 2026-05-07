# Nine PDFs - SvelteKit + TypeScript

Buscador local de PDFs academicos a partir de titulo solto ou referencia ABNT, com parser local,
enriquecimento por catalogo/IA e buscas diretas/manuais.

## Rodando localmente

1. Instale Node.js 20+.
2. No terminal:

```bash
cd "C:\Users\Balla\Downloads\Nine_Pdfs"
npm install
npm run dev
```

## Scripts

- `npm run dev` - ambiente de desenvolvimento
- `npm run build` - build de producao
- `npm run preview` - preview do build
- `npm run check` - validacao Svelte/TypeScript

## Conversor EPUB -> PDF

O app inclui um endpoint interno em `/api/convert/epub-to-pdf` para converter arquivos `.epub`
enviados pelo usuario. A conversao roda server-side, rejeita EPUB criptografado/DRM e gera um PDF
simples com capa/sumario opcionais.
