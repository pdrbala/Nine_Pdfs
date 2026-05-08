# Commit, Push e GitHub Pages

Este projeto publica o site pelo workflow `.github/workflows/pages.yml`.

## Fluxo normal

1. Confira as alteracoes locais:

```powershell
git status --short
```

2. Adicione os arquivos da mudanca:

```powershell
git add caminho/do/arquivo
```

3. Crie o commit:

```powershell
git commit -m "Mensagem do commit"
```

4. Envie para o GitHub:

```powershell
git push origin main
```

Depois do push, o GitHub Actions roda `npm ci` e `npm run build`, envia a pasta `build/`
como artifact e atualiza o GitHub Pages automaticamente.

## Testar o build local do Pages

Use o mesmo base path do GitHub Pages:

```powershell
$env:BASE_PATH = "/Nine_Pdfs"
npm run build
```

O output local fica em `build/`. Essa pasta nao precisa ser commitada; o workflow gera e
publica tudo de novo a cada push em `main`.

## Atualizar o Pages sem mudar codigo

Na aba Actions do GitHub, rode manualmente o workflow `Deploy GitHub Pages`.

URL publicada:

https://pdrbala.github.io/Nine_Pdfs/
