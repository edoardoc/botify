# Botify

![Botify logo](assets/botify-logo-minimal.svg)

Reusable Telegram ↔ Codex bridge that can be dropped into any repository. 

## Features
- Long-polling Telegram bot locked to a single chat.
- Full Codex MCP lifecycle management with automatic session reuse.
- Configurable sandbox, approval policy, Codex profile/model, and prompt overrides.
- Graceful shutdown and rich status/help commands exposed via Telegram.

## Installation

Choose the installation approach that best fits your workflow.

### Git Submodule
1. `git submodule add git@github.com:edoardoc/botify.git`
2. Run `npm install` inside the `botify/` folder.
3. Make sure `<host_project>/.codex_mcp_home/auth.json` contains valid Codex credentials.
4. Launch Botify from the `<host_project>` folder with `./botify/scripts/start-bot.sh`.

The launcher script reads `.env`, boots the compiled bridge, and mirrors output to `./logs/botify.log` (override via `BOTIFY_LOG_PATH=/custom/path.log`). Run it from the host project root so relative paths match—asking the bot to list the folder is a quick sanity check.

### Global npm CLI
1. Install the CLI once: `npm install -g github:edoardoc/botify` (or `npm install -g git+ssh://git@github.com/edoardoc/botify.git`).
2. Inside each host project, create a `.env` file using `.env.example` as a template.
3. Populate the required environment variables (see the configuration table below).
4. From the host project root, run `botify` to start the bridge. It treats the current directory as `CODEX_CWD` and writes artifacts to `<project>/.codex_mcp_home/`.
5. Optional: set `BOTIFY_LOG_PATH=./logs/botify.log botify` to tee output into your repo log directory.
6. Update later via `npm update -g botify`; `botify --version` shows the installed branch/commit.

```bash
npm install -g github:edoardoc/botify

# inside a host repo
BOTIFY_LOG_PATH=./logs/botify.log botify
```

> ℹ️ **Installing straight from GitHub.** npm 11 currently links git-based installs into a temporary cache directory and cleans that cache immediately, which prevents the `botify` binary from landing in `~/.npm-global/bin`. To ensure a working CLI:
> 1. Clone the repo and check out the desired branch (`git clone git@github.com:edoardoc/botify.git && cd botify`).
> 2. Run `npm install` to build `dist/`.
> 3. Install from disk: `npm install -g .`
>
> Alternatively, pack the repository first (`npm pack github:edoardoc/botify#humanize`) and install the resulting `botify-0.1.0.tgz`. In both cases, verify `~/.npm-global/bin` (or your chosen npm prefix) is on `PATH` so the `botify` shim is discoverable.

## Configuration
1. Copy `.env.example` to `.env` and fill in the required variables:
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are mandatory.
   - Optional Codex overrides (command, sandbox, approval policy, etc.) can stay commented out until needed.
2. Export the `.env` or run the launcher/CLI from the same directory so it can auto-load the file.

Botify reads all settings from environment variables; defaults align with the original bridge:

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

## Credentials & Authorization

### Codex Authorization
Codex creates `<host_project>/.codex_mcp_home/auth.json` during `codex login`. Keep that file in sync with the bridge. If you see `Your access token could not be refreshed because your refresh token was already used`, run `codex logout && codex login` (or `codex auth login`) and copy the freshly generated `auth.json` back into this project before restarting Botify.

### Obtaining Telegram Keys
1. DM `@BotFather`, run `/newbot`, follow the prompts, and copy the resulting `TELEGRAM_BOT_TOKEN`.
2. Start a chat with the bot (or add it to a group) and send a dummy message.
3. Grab the chat identifier with `curl "https://api.telegram.org/bot<token>/getUpdates"` or `@userinfobot`; the numeric `id` becomes `TELEGRAM_CHAT_ID`.
4. Drop both values into `.env` or export them in your shell before launching the bridge.
5. Optional: `/setprivacy` in `@BotFather` if the bot needs to see all group messages.

#### Finding your `TELEGRAM_CHAT_ID`
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

### Group Chat Setup
Botify is locked to a single `TELEGRAM_CHAT_ID`, so running it inside a Telegram group means everyone in that group shares the same Codex session, queue, and `/reset` state. To prepare a group chat:

1. Create a new Telegram group (or pick an existing one) and add your teammates plus the bot created via `@BotFather`.
2. In `@BotFather`, run `/setprivacy`, choose the bot, and select **Disable** so the bridge can see every group message without requiring repeated mentions. If you keep privacy enabled, members must reply to Botify or start their message with `@<botname>`/`Botify,` so the bridge receives the prompt.
3. Send any message in the group so Telegram records the chat and then fetch the numeric id (usually negative, e.g., `-1001234567890`) using the `curl ... getUpdates` command above, `@userinfobot`, or `@RawDataBot`.
4. Drop that id into `.env` as `TELEGRAM_CHAT_ID` and restart Botify. Every prompt sent in that group now flows through the same Codex conversation; `/reset` clears the session for the entire group.
5. When chatting, group members can mention the bot (`@your_bot fix build`), reply directly to its previous answer, or simply type `Botify, ...` to ensure the bridge routes the text even if privacy mode stays enabled. The bridge automatically strips those prefixes before forwarding prompts to Codex.

Because the queue is serialized per chat, multiple users can send prompts without colliding, but Codex will answer them sequentially. If you want multiple groups, run separate Botify instances, each configured with a different `TELEGRAM_CHAT_ID`.

## Usage
Start the bridge with `./botify/scripts/start-bot.sh` (submodule) or `botify` (global CLI), then interact with it through Telegram commands. In group chats every participant shares the same Codex history and queue; Botify replies inline to the message that triggered a response and automatically ignores the leading `@<botname>`/`Botify,` prefixes that Telegram injects in mentions or replies.

| Command | Description |
| --- | --- |
| `/help` | Show command list and a short bridge description. |
| `/ping` | Quick heartbeat that replies with `pong`. |
| `/status` | Report Codex readiness, queue length, timestamps, sandbox, and Botify version. |
| `/reset` | Drop the active Codex conversation and clear pending prompts. |
| `/relive` | Notify the chat that Botify is shutting down and exit with code 0 so a new build can restart. |
| (any other text) | Relayed to Codex via MCP; responses stream back as formatted messages. |

## Version Information
Every build captures the current Git branch and commit in `version-meta.json` and exposes it through the CLI, so you always know if you're running a tailored build of the tool:
- `botify --version` (or `botify -v`) prints `semver+branch.commit`, making it easy to audit what was installed globally.
- The same version string is advertised to Codex in the `clientInfo` payload so remote sessions can also see which build is active.
If Git metadata is unavailable during installation, the CLI falls back to the base `package.json` version and marks branch/commit as `unknown`.

## Attachment Handling
- Any Telegram document or photo sent to the bot is downloaded immediately and stored inside `BOTIFY_ATTACHMENTS_DIR` (default `./uploads` relative to the Codex CWD).
- Add this directory to your `.gitignore` (already ignored by default) so large binaries never end up in version control.
- When a file is saved, the bot sends back the relative path so you can reference it in follow-up prompts (e.g., “use `uploads/photo-abc123.jpg` as the hero image”).


## macOS Launch Agent

Use a Launch Agent when you want Botify (or several bots) to boot automatically whenever you log into macOS. The process involves two files: a shell launcher that starts every bot you care about, and a `~/Library/LaunchAgents` plist that keeps that script running.

1. **Create the launcher script.** Save the following template as `~/projects/botify/.local/bin/start_all_bots.sh`, update the `BOT_PROJECTS` array so each entry points to a repository that contains its own `.env` and Botify config, and add/remove entries as needed.

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail

   BOT_PROJECTS=(
     "/Users/you/projects/botify-demo"
     "/Users/you/projects/another-app"
   )

   for project in "${BOT_PROJECTS[@]}"; do
     (
       cd "$project"
       source .env.local
       BOTIFY_LOG_PATH="$project/logs/botify.log" botify >> "$project/logs/botify.log" 2>&1 &
     )
   done
   wait
   ```

   Customize the snippet to run any preparation commands (e.g., `npm install`) before `botify`. The script should end with `wait` so launchd knows when the background processes exit.

2. **Make the script executable.**

   ```bash
   chmod +x ~/projects/botify/.local/bin/start_all_bots.sh
   ```

3. **Create the Launch Agent.** Save `~/Library/LaunchAgents/com.botify.startbots.plist` with your absolute paths (replace `/Users/you/...` as needed):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
     <dict>
       <key>Label</key>
       <string>com.botify.startbots</string>
       <key>ProgramArguments</key>
       <array>
         <string>/Users/you/projects/botify/.local/bin/start_all_bots.sh</string>
       </array>
       <key>RunAtLoad</key>
       <true/>
       <key>StandardOutPath</key>
       <string>/Users/you/projects/botify/logs/launch-agent.log</string>
       <key>StandardErrorPath</key>
       <string>/Users/you/projects/botify/logs/launch-agent.log</string>
     </dict>
   </plist>
   ```

4. **Load or reload the agent whenever you change either file:**

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.botify.startbots.plist 2>/dev/null || true
   launchctl load ~/Library/LaunchAgents/com.botify.startbots.plist
   launchctl start com.botify.startbots
   ```

With that in place, macOS will rerun `start_all_bots.sh` automatically every time you log in, so each listed repository launches its own Botify instance without manual intervention.

<p align="right">
  <img src="assets/botify-logo-stack.svg" alt="Stacked Botify logo" width="220" />
</p>
