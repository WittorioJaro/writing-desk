#!/bin/sh
# Installs (or updates) the Writing Desk sync server on this Mac as a per-user LaunchAgent.
#
# The server itself listens only on 127.0.0.1 (never on your LAN), and `tailscale serve` exposes it
# to your tailnet only. Tailscale handles the incoming connection, so the macOS firewall needs no
# exception and nothing outside your tailnet can reach it.
#   WD_PORT          tailnet port (default 8765)
#   WD_LOCAL_PORT    loopback port the server binds (default 8766)
set -e
cd "$(dirname "$0")/.."
PORT="${WD_PORT:-8765}"
LOCAL_PORT="${WD_LOCAL_PORT:-8766}"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
HOST="$("$TS" ip -4 2>/dev/null | head -1)"
if [ -z "$HOST" ]; then echo "Couldn't find this Mac's Tailscale IP. Is Tailscale running and signed in?"; exit 1; fi

DIR="$HOME/Library/Application Support/WritingDeskServer"
LABEL="local.writingdesk.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

swift build -c release --product WritingDeskServer
mkdir -p "$DIR/bin" "$DIR/backups" "$HOME/Library/LaunchAgents"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$(swift build -c release --show-bin-path)/WritingDeskServer" "$DIR/bin/WritingDeskServer"
codesign --force --sign - "$DIR/bin/WritingDeskServer" >/dev/null 2>&1 || true

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$DIR/bin/WritingDeskServer</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$LOCAL_PORT</string>
    <string>--db</string><string>$DIR/writing-desk.sqlite</string>
    <string>--backups</string><string>$DIR/backups</string>
    <string>--allow</string><string>127.0.0.1</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/server.log</string>
</dict></plist>
PLISTEOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
# Expose it on the tailnet (persists across restarts; tailnet only, not the public internet).
"$TS" serve --bg --tcp "$PORT" "tcp://127.0.0.1:$LOCAL_PORT" >/dev/null

URL="http://$HOST:$PORT"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -m 5 "$URL/v1/health" >/dev/null; then
    echo "Writing Desk sync server is running: $URL"
    echo "Database: $DIR/writing-desk.sqlite (daily snapshots in backups/, log in server.log)"
    NAME="$("$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].split(".")[0])' 2>/dev/null || true)"
    echo "In Writing Desk on each Mac: Sync button -> enter $URL${NAME:+ (or http://$NAME:$PORT)} -> Turn on"
    exit 0
  fi
  sleep 1
done
echo "Server didn't answer at $URL — see $DIR/server.log"; exit 1
