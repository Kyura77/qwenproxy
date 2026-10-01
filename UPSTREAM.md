# Relação com o upstream

Este repositório é o fork mantido do
[`johngbl/QwenProxy`](https://github.com/johngbl/QwenProxy) usado pelo AWE.

- `upstream`: `https://github.com/johngbl/QwenProxy.git`
- Base da branch `awe`: tag `v1.5.3`
  (`3f72536497c0918de4851ca37d9de6bdf0e5c5ec`).

## Estratégia

A branch `main` permanece **idêntica** ao upstream (literal fork). Todo delta do
AWE fica isolado na branch `awe`, que é a revisão fixada pelo submodule
`servers/qwen` do repositório AWE.

Atualização do upstream: `git fetch upstream --tags`, depois merge/rebase da
`awe` sobre a nova tag, revisando `git diff upstream/main...awe`.

## Overlay AWE (branch `awe`)

Somente o necessário para importar e manter sessões OTP sem senha:

1. `src/core/session-import.ts` — importa uma conta OTP para o SQLite e instala
   `storage_state.json` no perfil canônico.
2. `src/import-session.ts` — CLI `npx tsx src/import-session.ts <arquivo>`.
3. `src/tests/session-import.test.ts` — testes offline do importador.
4. `src/services/playwright.ts` — dois ajustes mínimos:
   - `shouldRestoreStorageStateCookies`: restaura o storage state salvo quando o
     perfil vivo ainda não tem cookie `token` (perfis novos podem já ter cookies
     de guest/locale, o que fazia o import ser ignorado).
   - `pickRefreshToken`: resolve o refresh token em SQLite → localStorage →
     cookie `refresh_token`. Contas OTP só carregam o cookie, então sem esse
     fallback o token curto não é renovável.
5. `UPSTREAM.md` e a inclusão do teste novo em `package.json`.

Tudo o mais (TUI, sync, updater, rotas, personalização, mídia) permanece igual
ao upstream.

## Licença e atribuição

Upstream licenciado sob ISC. Ver `LICENSE`.
