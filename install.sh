#!/usr/bin/env bash
# SlackOC installer — builds from source and installs the `slackoc` CLI globally.
#
#   curl -fsSL https://raw.githubusercontent.com/matthewsu/SlackOC/main/install.sh | bash
#
# Overrides (mostly for testing):
#   SLACKOC_REF          git ref to install (default: main)
#   SLACKOC_TARBALL_URL  full tarball URL override (skips GitHub URL construction)
set -euo pipefail

REPO="matthewsu/SlackOC"
REF="${SLACKOC_REF:-main}"
TARBALL_URL="${SLACKOC_TARBALL_URL:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}}"

fail() { echo "slackoc install: error: $*" >&2; exit 1; }

# --- Pre-flight -------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node not found — install Node.js >= 20 first (https://nodejs.org)"
NODE_MAJOR="$(node -v | sed -E 's/^v?([0-9]+).*/\1/')"
[ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null || fail "node >= 20 required (found $(node -v)) — upgrade: https://nodejs.org"
command -v npm  >/dev/null 2>&1 || fail "npm not found — it ships with Node.js"
command -v curl >/dev/null 2>&1 || fail "curl not found"

# --- Download + build -------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ downloading ${REPO}@${REF}"
curl -fsSL "$TARBALL_URL" -o "$WORK/slackoc.tar.gz" || fail "download failed: $TARBALL_URL"
tar -xzf "$WORK/slackoc.tar.gz" -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
[ -n "$SRC" ] && [ -f "$SRC/package.json" ] || fail "unexpected tarball layout"

echo "→ building"
npm -C "$SRC" ci --no-audit --no-fund --loglevel=error
npm -C "$SRC" run build --silent

echo "→ installing slackoc globally"
npm install -g "$SRC" --no-audit --no-fund --loglevel=error || \
  fail "global install failed — if this was EACCES, fix your npm prefix: https://docs.npmjs.com/resolving-eacces-permissions-errors"

command -v slackoc >/dev/null 2>&1 || \
  fail "slackoc installed but not on PATH — add $(npm prefix -g)/bin to your PATH"

echo
echo "✓ slackoc installed ($(slackoc --version))"
echo
echo "Next steps:"
echo "  1. Make sure opencode >= 1.18 is installed and authenticated"
echo "  2. slackoc init    # one-time: create the Slack app from the bundled manifest, paste tokens"
echo "  3. slackoc start   # bridge online"
echo
echo "Docs: https://github.com/${REPO}#readme"
