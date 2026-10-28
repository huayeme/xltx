#!/usr/bin/env bash
# On a Linux x64 build host: prepare every build input and produce the distributable
# package (dist/xltx-{version}-linux-x64.tar.gz plus its .sha256 file). Nothing is
# installed on this host. Installation is the user's separate step: install.sh.
#
# Environment variables:
#   XLTX_BUILD_BASE   build working directory, default ~/xltx-build (holds node/pi/browser caches)
#   XLTX_NODE_VERSION defaults to the version in portable.json
#   XLTX_BUILD_INTO   assemble the installation into this directory instead of
#                     producing dist/*.tar.gz; install.sh sets it when installing
#                     straight from the source tree
# root is only used for the build-tools step: sudo prompts for the password on the spot.
set -uo pipefail

BASE="${XLTX_BUILD_BASE:-$HOME/xltx-build}"
INTO="${XLTX_BUILD_INTO:-}"
LOG="$BASE/build.log"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$BASE"
exec > >(tee -a "$LOG") 2>&1

fail() { echo "FAIL: $*"; exit 1; }
step() { echo; echo "##### $* ($(date +%T))"; }
echo "===== start $(date -Is) on $(hostname) $(uname -m)"

S() { sudo "$@"; }

step "apt base tools"
S apt-get update || echo "warn: apt update failed"
S apt-get install -y build-essential ripgrep fd-find busybox fonts-dejavu-core tar xz-utils curl ca-certificates || echo "warn: apt install failed"

step "apt browser dependencies"
want="libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libatspi2.0-0t64 libasound2t64 libx11-xcb1 libxcursor1 libxss1 libxtst6 libglib2.0-0t64"
for p in $want; do echo "- $p"; S apt-get install -y "$p" || echo "warn: missing $p"; done

command -v gcc >/dev/null || fail "gcc missing"
command -v rg  >/dev/null || fail "rg missing"
command -v busybox >/dev/null || fail "busybox missing"
command -v fdfind >/dev/null 2>&1 || command -v fd >/dev/null 2>&1 || fail "fd missing"

cd "$REPO" || fail "cd $REPO"

# Read portable.json without a shell-side Node: a bare Debian host has none yet.
setting() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$REPO/portable.json" | head -n1; }

NODE_VERSION=$(setting nodeVersion)
[ -n "$NODE_VERSION" ] || fail "cannot read nodeVersion from portable.json"
step "node v$NODE_VERSION"
NODE="$BASE/node/bin/node"
if [ ! -x "$NODE" ] || ! "$NODE" --version | grep -qx "v$NODE_VERSION"; then
  curl -fL --progress-bar "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$BASE/node.tar.xz" || fail "node download failed"
  rm -rf "$BASE/node"; mkdir -p "$BASE/node"
  tar -xJf "$BASE/node.tar.xz" -C "$BASE/node" --strip-components=1 || fail "node extraction failed"
fi
"$NODE" --version | grep -qx "v$NODE_VERSION" || fail "node version mismatch"
export PATH="$BASE/node/bin:$PATH"

step "npm ci"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund || fail "npm ci"

PI_VERSION=$(setting piVersion)
[ -n "$PI_VERSION" ] || fail "cannot read piVersion from portable.json"
PI_DIR="$BASE/pi/node_modules/@earendil-works/pi-coding-agent"
step "pi $PI_VERSION"
if [ ! -d "$PI_DIR" ]; then
  rm -rf "$BASE/pi"; mkdir -p "$BASE/pi"
  npm install --prefix "$BASE/pi" --no-audit --no-fund "@earendil-works/pi-coding-agent@$PI_VERSION" || fail "pi install failed"
fi
node -e "const p=require('$PI_DIR/package.json');console.log('pi',p.name,p.version)" || fail "pi package corrupt"

step "playwright chromium-headless-shell"
export PLAYWRIGHT_BROWSERS_PATH="$BASE/browsers"
BIN=$(find "$BASE/browsers" -type f \( -name chrome-headless-shell -o -name headless_shell \) 2>/dev/null | head -n1)
if [ -z "$BIN" ]; then
  "$REPO/node_modules/.bin/playwright" install chromium-headless-shell || fail "playwright install failed"
  BIN=$(find "$BASE/browsers" -type f \( -name chrome-headless-shell -o -name headless_shell \) | head -n1)
fi
[ -n "$BIN" ] || fail "missing headless shell"
if [ "$(basename "$BIN")" != "chrome-headless-shell" ]; then
  mv "$BIN" "$(dirname "$BIN")/chrome-headless-shell" || fail "rename failed"
  BIN="$(dirname "$BIN")/chrome-headless-shell"
fi
BROWSER_DIR="$(dirname "$BIN")"

step "browser dependency library closure"
rm -rf "$BASE/browser-libs"; mkdir -p "$BASE/browser-libs"
collect() {
  find "$BROWSER_DIR" "$BASE/browser-libs" -type f 2>/dev/null | while IFS= read -r f; do
    head -c4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n' | grep -qx '7f454c46' || continue
    ldd "$f" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i ~ /^\//) {print $i; exit}}'
  done
}
for round in 1 2 3 4; do
  before=$(ls "$BASE/browser-libs" | wc -l)
  collect | sort -u | while IFS= read -r lib; do
    [ -f "$lib" ] || continue
    t="$BASE/browser-libs/$(basename "$lib")"
    [ -e "$t" ] || cp -L "$lib" "$t"
  done
  after=$(ls "$BASE/browser-libs" | wc -l)
  echo "round $round: $before -> $after libs"
  [ "$before" = "$after" ] && break
done

step "fonts"
rm -rf "$BASE/fonts"; mkdir -p "$BASE/fonts"
cp /usr/share/fonts/truetype/dejavu/*.ttf "$BASE/fonts/" || echo "warn: no dejavu fonts"

step "Build the package"
cd "$REPO" || fail "cd $REPO"
INTO_ARGS=()
if [ -n "$INTO" ]; then INTO_ARGS=("--into=$INTO"); fi
node scripts/package.mjs \
  --node="$NODE" \
  --pi="$PI_DIR" \
  --bash="$(realpath /bin/bash)" \
  --busybox="$(realpath /usr/bin/busybox)" \
  --rg="$(realpath "$(command -v rg)")" \
  --fd="$(realpath "$(command -v fdfind || command -v fd)")" \
  --browser="$BROWSER_DIR" \
  --browser-libs="$BASE/browser-libs" \
  --fonts="$BASE/fonts" \
  ${INTO_ARGS[@]+"${INTO_ARGS[@]}"} || fail "packaging failed"

echo "===== done $(date -Is)"
if [ -n "$INTO" ]; then
  echo "installed at $INTO"
else
  ls -1 "$REPO"/dist/*.tar.gz "$REPO"/dist/*.tar.gz.sha256 2>/dev/null || true
fi
