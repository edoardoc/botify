# Repository Guidelines

## Project Structure & Module Organization
Code lives in `src/` as strict TypeScript modules (`index.ts`, `cli.ts`, `config.ts`, `telegramCodexBridge.ts`, `types.ts`). Build artifacts land in `dist/` and should be treated as generated output. `package.json` and `tsconfig.json` define the Node 18+ ESM toolchain, while `.env` files (ignored) supply runtime credentials. Keep new modules colocated with their primary dependency; shared utilities belong in `src/` alongside `types.ts` to simplify imports.

## Build, Test, and Development Commands
- `npm install` — hydrate dependencies before any build or lint step.
- `npm run build` — emit production JavaScript into `dist/` via `tsc -p tsconfig.json`.
- `npm run lint` — run the TypeScript compiler in `--noEmit` mode; treat failures as blockers.
- `npm run clean` — clear `dist/` with `rimraf`; useful before packaging a release.
When debugging locally, point `CODEX_HOME`, `CODEX_COMMAND`, and Telegram secrets in your shell before launching the bridge.

## Coding Style & Naming Conventions
Use TypeScript with `strict` settings; prefer explicit return types on exported members. Maintain two-space indentation, single quotes, and trailing commas where permitted. Classes and types use PascalCase (`TelegramCodexBridge`, `BotifyConfig`); functions, variables, and instance members use camelCase. Exports are ESM (`export { ... } from './file.js'`); keep relative paths extension-complete to match the emitted `.js` files. Run the compiler before pushing instead of relying on automated formatting.

## Manual Verification
Quality checks happen manually. After each change and once the commit is created **and pushed**, run the full verification routine:
1. `npm run lint`
2. `npm run build`
3. `npm install`
4. `npm install -g .`
5. `botify --version` (ensure it matches `git rev-parse --short HEAD`)

This guarantees the exact code you pushed is what your local CLI runs. Stage a `.env.local` with Telegram tokens, export it (`source .env.local`), then execute the bridge via `node dist/cli.js` or the `botify` bin to confirm end-to-end behavior. Capture key log excerpts, reproduction prompts, and any Codex/Telegram transcripts so reviewers can replay your results without automation.

## Routine Commit & Deployment
Treat every well-formed, definite request (like feature tweaks or fixes with clear acceptance criteria) as a full release candidate. After fulfilling the request:
- Run the manual verification checklist above to prove the change is production-ready.
- Commit the work with an imperative summary and push immediately.
- Redeploy Botify right away by reinstalling the CLI (`npm install -g .`) and validating `botify --version` matches the new `git rev-parse --short HEAD`.
This keeps the Telegram bridge aligned with the latest satisfied request, reducing drift between requested behavior and the active deployment.

## Commit & Pull Request Guidelines
History currently contains a single `initial commit`; adopt concise, imperative summaries (e.g., `feat: add rollout retry logging`). Reference related issues in the body, list environment variables required for validation, and attach logs or screenshots when behavior changes. PRs should describe risk areas, manual test evidence, and any follow-up work so the release checklist stays lightweight.

## Security & Configuration Tips
Never commit secrets such as `TELEGRAM_BOT_TOKEN` or `CODEX_HOME` artifacts. Store environment variables in your shell or an untracked `.env.local`. When sharing debug output, redact chat IDs and Codex paths. If you modify configuration defaults in `src/config.ts`, double-check that onboarding instructions stay accurate in `README.md`.
