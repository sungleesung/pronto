#!/bin/bash
# Builds "Cory Setup.app" with the pronto and imsg binaries inside it, so a new Mac
# needs no Homebrew and no terminal.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Cory by Crate Systems.app"
IDENTITY="${CORY_CODESIGN_IDENTITY:--}"

# Only the app is rebuilt. Packages live in ../dist so that rebuilding the app
# cannot delete one that is mid-notarization.
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <!-- CFBundleName drives the menu bar, where a long name is truncated;
       CFBundleDisplayName is what Finder and the installer show. -->
  <key>CFBundleName</key><string>Cory</string>
  <key>CFBundleDisplayName</key><string>Cory by Crate Systems</string>
  <key>CFBundleIdentifier</key><string>net.trycrate.cory.setup</string>
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
    # 755, not the 700 an installed pronto carries: a package payload has to be readable
    # by the installer and by whoever ends up running it.
    chmod 755 "$APP/Contents/Resources/$name"
    echo "  bundled $name"
  else
    echo "  WARNING: Resources/$name missing — the app will look for an installed copy"
  fi
done

# Sign inside-out: nested binaries first, then the bundle.
# A Developer ID build must use the hardened runtime and a real timestamp or
# notarization rejects it. Ad-hoc local builds skip both, since neither is available.
if [ "$IDENTITY" = "-" ]; then
  SIGN_EXTRA=(--timestamp=none)
else
  SIGN_EXTRA=(--options runtime --timestamp --entitlements entitlements.plist)
fi

for name in pronto imsg; do
  [ -f "$APP/Contents/Resources/$name" ] && \
    codesign --force --sign "$IDENTITY" "${SIGN_EXTRA[@]}" "$APP/Contents/Resources/$name" || true
done
codesign --force --sign "$IDENTITY" "${SIGN_EXTRA[@]}" "$APP"

echo
echo "built: $APP"
codesign -dv "$APP" 2>&1 | grep -E 'Identifier|Authority' || true
