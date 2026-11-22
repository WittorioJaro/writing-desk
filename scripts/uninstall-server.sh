#!/bin/sh
# Stops and removes the sync server LaunchAgent. The database and backups are kept.
LABEL="local.writingdesk.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
"$TS" serve --tcp "${WD_PORT:-8765}" off 2>/dev/null || true
echo "Stopped. Data kept in: $HOME/Library/Application Support/WritingDeskServer"
