#!/bin/bash
# Builds "Cory Setup.app" with the pronto and imsg binaries inside it, so a new Mac
# needs no Homebrew and no terminal.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Cory Setup.app"
IDENTITY="${CORY_CODESIGN_IDENTITY:--}"

rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Cory Setup</string>
  <key>CFBundleDisplayName</key><string>Cory Setup</string>
  <key>CFBundleIdentifier</key><string>dev.pronto.corysetup</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>CorySetup</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

echo "compiling…"
swiftc -O -parse-as-library \
  -target arm64-apple-macos13.0 \
  -o "$APP/Contents/MacOS/CorySetup" \
  Sources/CorySetup.swift

# Ship the agent and the Messages helper inside the bundle. Without these the wizard
# would be asking a non-technical user to install Homebrew first, which is the whole
# problem it exists to remove.
for name in pronto imsg; do
  if [ -f "Resources/$name" ]; then
    cp "Resources/$name" "$APP/Contents/Resources/$name"
    chmod 755 "$APP/Contents/Resources/$name"
    echo "  bundled $name"
  else
    echo "  WARNING: Resources/$name missing — the app will look for an installed copy"
  fi
done

# Sign inside-out: nested binaries first, then the bundle.
for name in pronto imsg; do
  [ -f "$APP/Contents/Resources/$name" ] && \
    codesign --force --sign "$IDENTITY" --timestamp=none "$APP/Contents/Resources/$name" 2>/dev/null || true
done
codesign --force --sign "$IDENTITY" --timestamp=none "$APP" 2>/dev/null || true

echo
echo "built: $APP"
codesign -dv "$APP" 2>&1 | grep -E 'Identifier|Authority' || true
