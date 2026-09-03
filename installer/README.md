# Cory Setup

A wizard that installs Cory on a Mac without a terminal.

    installer/CorySetup/build.sh        →  build/Cory Setup.app

The app bundles `pronto` and `imsg` in `Contents/Resources`, so a new Mac needs no
Homebrew. Stage them into `Resources/` before building; `build.sh` warns if they are
missing rather than producing an app that silently cannot install anything.

## The one manual step

Full Disk Access cannot be granted programmatically — macOS reserves that for the user.
The wizard opens the correct Settings pane, explains what to turn on, and polls until the
grant appears, then advances on its own. Reading `~/Library/Messages/chat.db` is the only
honest test: the permission cannot be queried, only exercised.

## Access

The wizard asks who may use Cory, and writes it through `pronto setup --access`:

- **Only me** / **Me and people I choose** → `--access allowlist --allow …`
- **Anyone who texts me** → `--access everyone`, with a plain warning attached

"Anyone" is a real choice someone may want, so it is offered — but it is stated in terms of
what it actually permits, not as a default that happens quietly.

## Before distributing

Signing here is ad-hoc, which is fine locally and not fine for other people's Macs.
Shipping needs **Developer ID Application + Developer ID Installer** certificates and
Apple notarization, i.e. a paid Apple Developer Program membership. Without them Gatekeeper
blocks the app on arrival, which is a worse wall than the one this removes.
Set `CORY_CODESIGN_IDENTITY` once those certificates exist.
