#!/bin/sh
# Builds build/WritingDesk.app from the Swift package (Command Line Tools only, no Xcode needed).
set -e
cd "$(dirname "$0")/.."
swift build -c release --product WritingDesk
APP=build/WritingDesk.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$(swift build -c release --show-bin-path)/WritingDesk" "$APP/Contents/MacOS/WritingDesk"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Writing Desk</string>
  <key>CFBundleIdentifier</key><string>local.writingdesk</string>
  <key>CFBundleExecutable</key><string>WritingDesk</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
