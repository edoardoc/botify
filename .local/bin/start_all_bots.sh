#!/usr/bin/env bash

# Ensure tmux/node/etc. are visible to launchd
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

start_session() {
  local name="$1"
  local dir="$2"

  if tmux has-session -t "$name" 2>/dev/null; then
    echo "tmux session $name already exists, skipping"
  else
    echo "starting tmux session $name"

    # cmd to start the botify/scripts/start-bot.sh
    local cmd="cd \"$dir\" && { title $name 2>/dev/null || true; } && set -o allexport; source .env; set +o allexport && botify/scripts/start-bot.sh > >(tee -a ./doodlebotlogfile.log) 2>&1"

    # Run that line in a bash login shell so it behaves like your terminal
    tmux new -d -s "$name" "bash -lc '$cmd'"
  fi
}

# Main supervisor loop: check every 10 minutes (600 seconds)
while true; do
  start_session "DEV1BOT"    "$HOME/projects/prj1/work/dev1/"
  start_session "DEV2BOT"    "$HOME/projects/prj1/work/dev2/"
  start_session "DEV3BOT"    "$HOME/projects/prj1/work/dev3/"
  start_session "BOTIFYBOT"  "$HOME/projects/botify/"
  sleep 600
done

