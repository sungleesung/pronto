#!/bin/bash
# Puts a secret into pronto's LaunchAgent environment and reloads it.
#
# Reads the value from a silent prompt, so it never lands in shell history or in a
# chat transcript. Usage:
#   scripts/set-agent-secret.sh NOTION_TOKEN
#   scripts/set-agent-secret.sh HF_API_KEY HF_SECRET
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/dev.pronto.agent.plist"
[ -f "$PLIST" ] || { echo "No LaunchAgent at $PLIST"; exit 1; }
[ $# -ge 1 ] || { echo "Usage: $0 NAME [NAME...]"; exit 1; }

cp "$PLIST" "$PLIST.bak.$(date +%s)"

for NAME in "$@"; do
  case "$NAME" in
    [A-Z_][A-Z0-9_]*) ;;
    *) echo "Refusing '$NAME': names are UPPER_SNAKE_CASE."; exit 1 ;;
  esac
  read -rsp "Value for $NAME: " VALUE
  echo
  [ -n "$VALUE" ] || { echo "Empty, nothing changed for $NAME."; exit 1; }
  /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:$NAME" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:$NAME string $VALUE" "$PLIST" >/dev/null
  echo "  set $NAME (${#VALUE} chars)"
done

plutil -lint "$PLIST" >/dev/null

# launchctl kickstart restarts the job but does NOT re-read the plist, so a changed
# environment is silently ignored. Only a full bootout/bootstrap picks it up.
launchctl bootout "gui/$(id -u)/dev.pronto.agent" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 5

echo
echo "Environment now carries:"
launchctl print "gui/$(id -u)/dev.pronto.agent" 2>/dev/null \
  | sed -n '/^\tenvironment = {/,/}/p' | grep -oE '^\s+[A-Za-z_]+ =>' | tr -d ' =>' | sed 's/^/  /'
echo
"$HOME/Library/Application Support/pronto/bin/pronto" status | head -3
