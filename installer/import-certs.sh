#!/bin/bash
# Installs Developer ID certificates downloaded from developer.apple.com.
#
# The portal hands back a .cer containing only the public half. It is useless until it is
# paired with the private key that produced the request, which is why the .key files in
# certs/ must not be deleted before this runs.
set -euo pipefail
cd "$(dirname "$0")/certs"

installed=0
for kind in application installer; do
  cer=$(ls -t "developerID_${kind}"*.cer developer*ID*"${kind}"*.cer 2>/dev/null | head -1 || true)
  if [ -z "${cer:-}" ]; then
    echo "  developerID_${kind}: no .cer found here — download it and drop it in $(pwd)"
    continue
  fi
  key="developerID_${kind}.key"
  [ -f "$key" ] || { echo "  developerID_${kind}: private key missing; regenerate the CSR"; continue; }

  # Pair the key with the certificate, then import the pair as one identity.
  openssl x509 -inform DER -in "$cer" -out "${kind}.pem" 2>/dev/null \
    || cp "$cer" "${kind}.pem"
  openssl pkcs12 -export -legacy -out "${kind}.p12" \
    -inkey "$key" -in "${kind}.pem" -passout pass:cory 2>/dev/null \
    || openssl pkcs12 -export -out "${kind}.p12" \
       -inkey "$key" -in "${kind}.pem" -passout pass:cory
  security import "${kind}.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P cory -T /usr/bin/codesign -T /usr/bin/productbuild >/dev/null
  rm -f "${kind}.pem" "${kind}.p12"
  echo "  imported developerID_${kind}"
  installed=$((installed + 1))
done

echo
echo "Identities now available:"
security find-identity -v 2>/dev/null | grep -E 'Developer ID' | sed 's/^/  /' \
  || echo "  none yet"
[ "$installed" -gt 0 ] || exit 1
