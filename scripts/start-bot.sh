#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
caller_pwd="$(pwd)"
log_path="${BOTIFY_LOG_PATH:-$caller_pwd/logs/botify.log}"

if [[ "$caller_pwd" == "$repo_root" ]]; then
  >&2 echo "Warning: run this script from the parent project (e.g., ./botify/scripts/start-bot.sh), not from inside the botify submodule."
fi

mkdir -p "$(dirname "$log_path")"
cd "$repo_root"

npm run build

set -o allexport
if [ -f ".env" ]; then
  source ".env"
fi
set +o allexport

export CODEX_CWD="${CODEX_CWD:-$caller_pwd}"

node dist/cli.js > >(tee -a "$log_path") 2>&1
