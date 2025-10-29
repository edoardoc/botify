# Botify

Reusable Telegram ↔ Codex bridge that can be dropped into any repository. The package exposes a programmatic API plus a small CLI that reads environment variables (or a `.env` file) and mirrors the behaviour of the existing `scripts/telegram_bot.js` bridge.

## Features
- Long-polling Telegram bot locked to a single chat.
- Full Codex MCP lifecycle management with automatic session reuse.
- Configurable sandbox, approval policy, Codex profile/model, and prompt overrides.
- Graceful shutdown and rich status/help commands exposed via Telegram.

## Quick Start
1. `npm install` inside the `botify/` folder.
2. Copy `.env.example` to `.env` and fill in the required variables:
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are mandatory.
   - Optional Codex overrides (command, sandbox, approval policy, etc.) can stay commented out.
3. Build the TypeScript sources (optional for `ts-node` users):
   ```bash
   npm run build
   ```
4. Launch the bridge:
   ```bash
   node dist/cli.js
   ```
   or, after adding `botify/dist` to your path, simply run:
   ```bash
   npx botify
   ```

Once the process is running, chat with your Telegram bot. Any non-command message is forwarded to Codex and the response is streamed back as formatted text.

## Project Integration
- **As a Git submodule**: move the `botify/` folder into its own repository, then add it as a submodule wherever you need per-project bridges. Keeping it as a submodule makes it easy to fork or tailor the bridge for project-specific workflows—custom Codex prompts, alternative launch commands, or bespoke logging—while still reusing the shared core.
- **As a dependency**: publish the package (e.g., to a private registry) and add it to your project via `npm install`.
- **Custom scripts**: import the `TelegramCodexBridge` and `loadConfigFromEnv` helpers to embed the bridge in bespoke automation.

```ts
import { loadConfigFromEnv, TelegramCodexBridge } from 'botify';

const config = loadConfigFromEnv();
const bridge = new TelegramCodexBridge(config);
await bridge.start();
// keep the process alive; call bridge.stop() on shutdown
```

## Configuration Reference
All options are read from environment variables and have sensible defaults aligned with the original bridge:

| Variable | Description | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (from BotFather) | *required* |
| `TELEGRAM_CHAT_ID` | Numeric chat id allowed to talk to the bot | *required* |
| `TELEGRAM_POLL_TIMEOUT` | Long poll timeout in seconds | `25` |
| `CODEX_COMMAND` | Command used to launch the Codex MCP server | `codex mcp-server` |
| `CODEX_CWD` | Working directory for Codex | current working directory |
| `CODEX_HOME` | Dedicated Codex home directory | `<CODEX_CWD>/.codex_mcp_home` |
| `CODEX_SANDBOX` | Sandbox mode forwarded to Codex | `workspace-write` |
| `CODEX_APPROVAL_POLICY` | Approval policy forwarded to Codex | `never` |
| `CODEX_PROFILE` | Optional Codex profile | unset |
| `CODEX_MODEL` | Optional Codex model override | unset |
| `CODEX_INCLUDE_PLAN_TOOL` | Enable/disable plan tool | unset |
| `CODEX_BASE_INSTRUCTIONS` | Override base instructions string | unset |
| `CODEX_CONFIG_OVERRIDES` | JSON payload forwarded as config overrides | unset |
| `CODEX_RPC_TIMEOUT_MS` | RPC timeout in milliseconds (`0` disables) | `900000` |
| `CODEX_EXIT_LOG_LINES` | Buffered lines from Codex logs for crash reports | `40` |
| `CODEX_OUTPUT_CHUNK` | Telegram message chunk size | `3500` |

## Telegram Keys
1. DM `@BotFather`, run `/newbot`, follow the prompts, and copy the resulting `TELEGRAM_BOT_TOKEN`.
2. Start a chat with the bot (or add it to a group) and send a dummy message.
3. Grab the chat identifier with `curl "https://api.telegram.org/bot<token>/getUpdates"` or `@userinfobot`; the numeric `id` becomes `TELEGRAM_CHAT_ID`.
4. Drop both values into `.env` or export them in your shell before launching the bridge.
5. Optional: `/setprivacy` in `@BotFather` if the bot needs to see all group messages.

## Codex Setup Checklist
- Ensure the Codex CLI is installed and on the PATH of the user running the bridge.
- Provide any required credentials or MCP configuration inside `CODEX_HOME`.
- Tune sandbox/approval policy according to the target project; defaults mirror a non-interactive Codex bot.

## Development
- `npm run build` compiles sources to `dist/`.
- `npm run lint` performs a type-check-only run.
- `npm run clean` removes the build artifacts.

Feel free to extend the module with additional adapters (e.g., Slack, Discord) by following the same pattern inside `src/`.
