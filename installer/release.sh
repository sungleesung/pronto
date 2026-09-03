#!/bin/bash
# Builds, signs, packages, notarizes and staples a distributable Cory installer.
#
# Run it with nothing configured and it tells you exactly what is missing instead of
# failing halfway through a five-minute notarization.
set -euo pipefail
cd "$(dirname "$0")"

TEAM_ID="${CORY_TEAM_ID:-L2Y884X6FV}"
NOTARY_PROFILE="${CORY_NOTARY_PROFILE:-cory-notary}"
VERSION="${CORY_VERSION:-1.0}"
OUT="CorySetup/build"

app_identity=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/' || true)
pkg_identity=$(security find-identity -v 2>/dev/null \
  | grep "Developer ID Installer" | head -1 | sed -E 's/.*"(.*)"/\1/' || true)

missing=0
say() { printf "  %-34s %s\n" "$1" "$2"; }
echo "Checking what is needed to distribute:"
if [ -n "$app_identity" ]; then say "Developer ID Application" "found"; else
  say "Developer ID Application" "MISSING"; missing=1; fi
if [ -n "$pkg_identity" ]; then say "Developer ID Installer" "found"; else
  say "Developer ID Installer" "MISSING"; missing=1; fi
if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  say "Notary credentials ($NOTARY_PROFILE)" "found"
else
  say "Notary credentials ($NOTARY_PROFILE)" "MISSING"; missing=1
fi
for b in CorySetup/Resources/pronto CorySetup/Resources/imsg; do
  if [ -f "$b" ]; then say "$(basename "$b") staged" "found"; else
    say "$(basename "$b") staged" "MISSING"; missing=1; fi
done

if [ "$missing" -ne 0 ]; then
  cat <<'HELP'

Not ready yet. To fix:

  Certificates  Xcode > Settings > Accounts > (your Apple ID) > Manage Certificates
                Press + and create BOTH:
                   Developer ID Application
                   Developer ID Installer
                They are different from the "Apple Development" certificate you already
                have, which cannot be used to distribute to other Macs.

  Notarizing    Create an app-specific password at appleid.apple.com
                (Sign-In and Security > App-Specific Passwords), then run:

                  xcrun notarytool store-credentials cory-notary \
                    --apple-id YOUR_APPLE_ID --team-id TEAM --password APP_SPECIFIC_PASSWORD

  Binaries      cp "$HOME/Library/Application Support/pronto/bin/pronto" CorySetup/Resources/
                cp /opt/homebrew/bin/imsg CorySetup/Resources/
HELP
  exit 1
fi

echo
echo "Building signed app…"
CORY_CODESIGN_IDENTITY="$app_identity" CorySetup/build.sh >/dev/null
APP="$OUT/Cory Setup.app"
codesign --verify --strict --verbose=1 "$APP"

echo "Building installer package…"
pkgbuild --quiet --install-location /Applications --component "$APP" \
  --identifier dev.pronto.corysetup --version "$VERSION" "$OUT/component.pkg"
productbuild --quiet --package "$OUT/component.pkg" --sign "$pkg_identity" \
  "$OUT/CorySetup-$VERSION.pkg"
rm -f "$OUT/component.pkg"
PKG="$OUT/CorySetup-$VERSION.pkg"

echo "Notarizing (this takes a few minutes)…"
xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$PKG"

echo
echo "Verifying the way a stranger's Mac will:"
spctl --assess --type install -vv "$PKG" 2>&1 | sed 's/^/  /'
echo
echo "Ready to send: $PKG"
