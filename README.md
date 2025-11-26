# Botify

![Botify logo](assets/botify-logo-minimal.svg)

Reusable Telegram ↔ Codex bridge that can be dropped into any repository. 

## Features
- Long-polling Telegram bot locked to a single chat.
- Full Codex MCP lifecycle management with automatic session reuse.
- Configurable sandbox, approval policy, Codex profile/model, and prompt overrides.
- Graceful shutdown and rich status/help commands exposed via Telegram.

## Quick Start

Choose the installation flow that best matches your project.

### Option 1: Git Submodule
1. `git submodule add git@github.com:edoardoc/botify.git`
2. run `npm install` inside the `botify/` folder
3. make sure you have a `<host_project>/.codex_mcp_home/auth.json` with something valid inside
4. launch Botify from the `<host_project>` folder with `./botify/scripts/start-bot.sh`

### Option 2: Global npm CLI
1. Install the CLI once: `npm install -g github:edoardoc/botify` (or use the SSH form `npm install -g git+ssh://git@github.com/edoardoc/botify.git`).
2. Inside each host project, create a `.env` file (use the table in [Env and activations](#env-and-activations) or `.env.example` from this repo as a template) and populate the required variables.
3. From the host project root, run `botify` to start the bridge. The binary loads `.env`, treats the current folder as `CODEX_CWD`, and writes Codex artifacts in `<project>/.codex_mcp_home/`.
4. Optional: set `BOTIFY_LOG_PATH=./logs/botify.log botify` to mirror output into your project log directory.
5. Update the CLI later via `npm update -g botify`. Run `botify --version` at any time to confirm which branch/commit is installed (e.g., `0.1.0+main.abc1234`).

## Details

### Git Submodule Integration
Inside the host project, add a submodule: `git submodule add git@github.com:edoardoc/botify.git`

### Env and activations
1. Copy `.env.example` to `.env` and fill in the required variables:
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are mandatory.
   - Optional Codex overrides (command, sandbox, approval policy, etc.) can stay commented out.

Once the process is running, chat with your Telegram bot. Any non-command message is forwarded to Codex and the response is streamed back as formatted text.

### Global npm Install Workflow
If you prefer keeping Botify outside of your repo, install it globally and call the CLI inside each project:

```bash
npm install -g github:edoardoc/botify

# inside a host repo
BOTIFY_LOG_PATH=./logs/botify.log botify
```

The executable loads `.env` from the current directory, so each host project can manage its own Telegram/Codex credentials without duplicating the codebase. Update to a newer release at any time with `npm update -g botify`.

### Version Information
Every build captures the current Git branch and commit in `version-meta.json` and exposes it through the CLI:
- `botify --version` (or `botify -v`) prints `semver+branch.commit`, making it easy to audit what was installed globally.
- The same version string is advertised to Codex in the `clientInfo` payload so remote sessions can also see which build is active.
If Git metadata is unavailable during installation, the CLI falls back to the base `package.json` version and marks branch/commit as `unknown`.

## Bot Launcher Script
From the host project root, run `./botify/scripts/start-bot.sh` to load `.env`, boot the compiled bridge, and mirror all output to `./logs/botify.log` (created automatically). Override the log destination with `BOTIFY_LOG_PATH=/custom/path.log` if you prefer a different location.
Before interacting with the bot make sure it was invoked from the host directory (just ask it to list the folder)

### Codes Authorization
Codex will create a `<host_project>/.codex_mcp_home/` where a file `auth.json` should be present (after codex login that file is created)

If Codex ever says `Your access token could not be refreshed because your refresh token was already used`, the refresh token in `.codex_mcp_home/auth.json` has been consumed by another session. Run `codex logout && codex login` (or `codex auth login`), then copy the freshly generated `auth.json` back into this project before restarting the bridge.

## Obtaining Telegram Keys
1. DM `@BotFather`, run `/newbot`, follow the prompts, and copy the resulting `TELEGRAM_BOT_TOKEN`.
2. Start a chat with the bot (or add it to a group) and send a dummy message.
3. Grab the chat identifier with `curl "https://api.telegram.org/bot<token>/getUpdates"` or `@userinfobot`; the numeric `id` becomes `TELEGRAM_CHAT_ID`.
4. Drop both values into `.env` or export them in your shell before launching the bridge.
5. Optional: `/setprivacy` in `@BotFather` if the bot needs to see all group messages.

### Finding your `TELEGRAM_CHAT_ID`
1. Replace `<token>` with your bot token and run:
   ```bash
   curl "https://api.telegram.org/bot<token>/getUpdates"
   ```
2. Locate the most recent `message.chat.id` in the JSON response. That value (often negative for groups) is the `TELEGRAM_CHAT_ID`.
3. Optionally, pipe the result through `jq` to extract the id quickly:
   ```bash
   curl "https://api.telegram.org/bot<token>/getUpdates" | jq '.result[0].message.chat.id'
   ```
4. If you do not see the chat listed, send another message to the bot and re-run the command; Telegram only returns chats with recent activity.

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
| `CODEX_SANDBOX` | Sandbox mode forwarded to Codex | `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | Approval policy forwarded to Codex | `never` |
| `BOTIFY_ATTACHMENTS_DIR` | Directory where incoming Telegram files are saved | `<CODEX_CWD>/uploads` |
| `CODEX_PROFILE` | Optional Codex profile | unset |
| `CODEX_MODEL` | Optional Codex model override | unset |
| `CODEX_INCLUDE_PLAN_TOOL` | Enable/disable plan tool | unset |
| `CODEX_BASE_INSTRUCTIONS` | Override base instructions string | unset |
| `CODEX_CONFIG_OVERRIDES` | JSON payload forwarded as config overrides | unset |
| `CODEX_RPC_TIMEOUT_MS` | RPC timeout in milliseconds (`0` disables) | `900000` |
| `CODEX_EXIT_LOG_LINES` | Buffered lines from Codex logs for crash reports | `40` |
| `CODEX_OUTPUT_CHUNK` | Telegram message chunk size | `3500` |

### Attachment Handling
- Any Telegram document or photo sent to the bot is downloaded immediately and stored inside `BOTIFY_ATTACHMENTS_DIR` (default `./uploads` relative to the Codex CWD).
- Add this directory to your `.gitignore` (already ignored by default) so large binaries never end up in version control.
- When a file is saved, the bot sends back the relative path so you can reference it in follow-up prompts (e.g. “use `uploads/photo-abc123.jpg` as the hero image”).


## Booting bots on macos

Change file `start_all_bots.sh` with the bots you created, then change all absolute paths `/Users/eddy/...` with your paths in `com.500nits.startbots.plist` then do a:

```
chmod +x ~/projects/botify/.local/bin/start_all_bots.sh
launchctl unload ~/Library/LaunchAgents/com.500nits.startbots.plist 2>/dev/null || true
launchctl load  ~/Library/LaunchAgents/com.500nits.startbots.plist
launchctl start com.500nits.startbots
```

this will start all your bots at every boot
