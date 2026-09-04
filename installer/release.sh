#!/bin/bash
# Builds, signs, packages, notarizes and staples a distributable Cory installer.
#
# Run it with nothing configured and it tells you exactly what is missing instead of
# failing halfway through a five-minute notarization.
set -euo pipefail
cd "$(dirname "$0")"

# Read the team from the Developer ID certificate rather than assuming it. The developer
# account is not necessarily the Apple ID this Mac is signed into, so a hardcoded team is
# wrong exactly when it matters.
# `|| true` matters: with pipefail, grep finding nothing would abort the script before it
# could tell the user what is missing, which is the one job the preflight has.
TEAM_ID="${CORY_TEAM_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed -E 's/.*\(([A-Z0-9]+)\).*/\1/' || true)}"
NOTARY_PROFILE="${CORY_NOTARY_PROFILE:-cory-notary}"
VERSION="${CORY_VERSION:-1.0}"
OUT="CorySetup/build"
DIST="dist"

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

  Certificates  Requests are already generated in installer/certs/. At
                developer.apple.com/account/resources/certificates press + and create
                BOTH, uploading the matching request:

                   Developer ID Application  <-  certs/developerID_application.csr
                   Developer ID Installer    <-  certs/developerID_installer.csr

                Download each .cer into installer/certs/, then run:
                   installer/import-certs.sh

                These are different from the "Apple Development" certificate, which
                cannot be used to distribute to other Macs. Use the portal rather than
                Xcode when the developer account is not the Apple ID this Mac is signed
                into — Xcode can only issue certificates for accounts it is signed into.

  Notarizing    Create an app-specific password at appleid.apple.com
                (Sign-In and Security > App-Specific Passwords), then run:

                  xcrun notarytool store-credentials cory-notary \
                    --apple-id DEVELOPER_ACCOUNT_APPLE_ID \
                    --team-id TEAM_ID_FROM_THE_PORTAL \
                    --password APP_SPECIFIC_PASSWORD

                Use the Apple ID of the DEVELOPER account and the team id shown in the
                portal's top-right membership details — not whichever Apple ID this Mac
                happens to be signed into.

  Binaries      cp "$HOME/Library/Application Support/pronto/bin/pronto" CorySetup/Resources/
                cp /opt/homebrew/bin/imsg CorySetup/Resources/
HELP
  exit 1
fi

echo
echo "Building signed app…"
CORY_CODESIGN_IDENTITY="$app_identity" CorySetup/build.sh >/dev/null
APP="$OUT/Cory by Crate Systems.app"
codesign --verify --strict --verbose=1 "$APP"

echo "Building installer package…"
mkdir -p "$DIST"
pkgbuild --quiet --install-location /Applications --component "$APP" \
  --identifier net.trycrate.cory.setup --version "$VERSION" "$DIST/component.pkg"
productbuild --quiet --package "$DIST/component.pkg" --sign "$pkg_identity" \
  "$DIST/Cory-$VERSION.pkg"
rm -f "$DIST/component.pkg"
PKG="$DIST/Cory-$VERSION.pkg"

echo "Notarizing (this takes a few minutes)…"
xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$PKG"

echo
echo "Verifying the way a stranger's Mac will:"
spctl --assess --type install -vv "$PKG" 2>&1 | sed 's/^/  /'
echo
echo "Ready to send: $PKG"
