#!/bin/bash
# Adds NOTION_TOKEN to the pronto LaunchAgent and restarts it.
# Reads the token from a prompt so it never appears in shell history, in a chat
# transcript, or in any file pronto writes.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/dev.pronto.agent.plist"
[ -f "$PLIST" ] || { echo "No LaunchAgent at $PLIST"; exit 1; }

read -rsp "Paste your Notion integration token (ntn_...): " TOKEN
echo
[ -n "$TOKEN" ] || { echo "Empty token, nothing changed."; exit 1; }
case "$TOKEN" in
  ntn_*|secret_*) ;;
  *) echo "That does not look like a Notion token (expected ntn_... or secret_...)."; exit 1 ;;
esac

cp "$PLIST" "$PLIST.bak.$(date +%s)"
/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:NOTION_TOKEN" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NOTION_TOKEN string $TOKEN" "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl kickstart -k "gui/$(id -u)/dev.pronto.agent"
sleep 5
"$HOME/Library/Application Support/pronto/bin/pronto" status | head -3
echo
echo "Done. Cory now has Notion tools. Backup of the old plist is beside it."
echo "Remember: share the target Notion pages with the integration, or it sees nothing."
