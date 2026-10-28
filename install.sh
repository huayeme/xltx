#!/bin/sh
# User-side installer for 小林同学 (xltx). No source tree, compiler or package
# manager is needed: it unpacks a verified package, keeps the existing data,
# stores one model API key, registers the background service and shows the QR code.
#
#   ./install.sh                              install from this unpacked package
#   ./install.sh xltx-0.1.0-linux-x64.tar.gz  verify and install that archive
#   XLTX_INSTALL_DIR=/opt/xltx ./install.sh   choose the installation directory
set -eu

BASE=${XLTX_INSTALL_DIR:-$HOME/xltx}
ARCHIVE=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    *) [ -z "$ARCHIVE" ] || { printf 'only one archive may be given\n' >&2; exit 2; }; ARCHIVE=$arg ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }

need tar
need cp
need mv

TMP=""
BUILD=""
BACKUP=""
cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ] && [ ! -e "$BASE" ]; then mv "$BACKUP" "$BASE"; fi
}
trap cleanup EXIT

PARENT=$(dirname "$BASE")
[ -d "$PARENT" ] || mkdir -p "$PARENT" || fail "cannot create $PARENT"

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || fail "no such file: $ARCHIVE"
  if [ -f "$ARCHIVE.sha256" ]; then
    need sha256sum
    ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" ) || fail "checksum does not match"
  fi
  TMP=$(mktemp -d "$PARENT/.xltx-unpack.XXXXXX") || fail "cannot create a temporary directory"
  tar -xzf "$ARCHIVE" -C "$TMP" || fail "cannot unpack $ARCHIVE"
  STAGE=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n1)
  [ -n "$STAGE" ] || fail "the archive has no top-level directory"
elif [ -f "$PWD/xltx" ] && [ -d "$PWD/runtime" ]; then
  STAGE=$PWD
  TMP=""
  case "$BASE" in "$STAGE"|"$STAGE"/*) fail "choose an installation directory outside the unpacked package" ;; esac
else
  # Run from the source tree: assemble the installation right here instead of
  # asking for a separate build step. The runtime still has to be produced from
  # the bundled Node, Pi and browser, which build.sh does.
  SOURCE=$PWD
  if [ ! -f "$SOURCE/scripts/build.sh" ] || [ ! -f "$SOURCE/package.json" ] || [ ! -d "$SOURCE/src" ]; then
    fail "this does not look like an xltx package or source tree"
  fi
  case "$BASE" in "$SOURCE"|"$SOURCE"/*) fail "choose an installation directory outside the source tree" ;; esac
  need bash
  say "This is the source tree, so the runtime is built before installing."
  say "Build tools are installed with sudo and the bundled Node, Pi and browser are downloaded once."
  BUILD=$(mktemp -d "$PARENT/.xltx-build.XXXXXX") || fail "cannot create a temporary directory"
  TMP=$BUILD
  STAGE=$BUILD/package
  XLTX_BUILD_INTO=$STAGE bash "$SOURCE/scripts/build.sh" || fail "the build failed; nothing was installed"
fi

if [ ! -f "$STAGE/xltx" ] || [ ! -d "$STAGE/runtime" ]; then
  if [ -n "$BUILD" ]; then fail "the build did not produce an installation"; fi
  fail "this does not look like an xltx package"
fi
( cd "$STAGE" && ./xltx verify ) >/dev/null || fail "package verification failed"

if [ -z "$TMP" ]; then
  COPY=$(mktemp -d "$PARENT/.xltx-install.XXXXXX") || fail "cannot create a temporary directory"
  TMP=$COPY
  cp -a "$STAGE/." "$COPY/" || fail "cannot copy the package"
  STAGE=$COPY
fi
[ -x "$STAGE/xltx" ] || fail "the copied package has no xltx"

# Stop the old service before touching its data.
if [ -x "$BASE/xltx" ]; then systemctl --user stop xltx.service 2>/dev/null || true; fi

# Keep the user's data and working directory across upgrades.
if [ -d "$BASE/data" ]; then mv "$BASE/data" "$STAGE/data" || fail "cannot keep the existing data"; fi
if [ -d "$BASE/workspace" ]; then mv "$BASE/workspace" "$STAGE/workspace" || fail "cannot keep the existing workspace"; fi

if [ -e "$BASE" ]; then
  BACKUP="$BASE.bak.$(date +%Y%m%dT%H%M%S)"
  mv "$BASE" "$BACKUP" || fail "cannot move the previous installation aside"
  say "previous version kept at $BACKUP"
  ls -d "$BASE".bak.* 2>/dev/null | sort | head -n -2 | xargs -r rm -rf || true
fi
mv "$STAGE" "$BASE" || fail "cannot move the installation into place"
[ -z "$TMP" ] || rm -rf "$TMP"
TMP=""
chmod 700 "$BASE" || true

ENVFILE="$BASE/data/environment.json"
if [ -s "$ENVFILE" ]; then
  say "keeping the existing model API key"
else
  KEY_NAME=""
  KEY=""
  LABEL=""
  if [ -n "${XLTX_API_KEY:-}" ] && [ -n "${XLTX_API_KEY_NAME:-}" ]; then
    KEY_NAME=$XLTX_API_KEY_NAME; KEY=$XLTX_API_KEY; LABEL=$XLTX_API_KEY_NAME
  else
    say "Which model service will the assistant use?"
    say "  1) DeepSeek"
    say "  2) OpenAI"
    say "  3) Anthropic (Claude)"
    say "  4) OpenRouter"
    say "  5) Another service"
    printf 'Choose 1-5 [1]: '
    CHOICE=""
    read -r CHOICE || true
    CHOICE=${CHOICE:-1}
    case "$CHOICE" in
      1) KEY_NAME=DEEPSEEK_API_KEY; LABEL=DeepSeek ;;
      2) KEY_NAME=OPENAI_API_KEY; LABEL=OpenAI ;;
      3) KEY_NAME=ANTHROPIC_API_KEY; LABEL=Anthropic ;;
      4) KEY_NAME=OPENROUTER_API_KEY; LABEL=OpenRouter ;;
      5) printf 'Variable name for your service (for example MISTRAL_API_KEY): '; KEY_NAME=""; read -r KEY_NAME || true; LABEL=$KEY_NAME ;;
      *) fail "choose a number from 1 to 5" ;;
    esac
    printf 'Paste the %s API key (input is hidden): ' "$LABEL"
    if [ -t 0 ] && command -v stty >/dev/null 2>&1; then
      stty -echo; read -r KEY || true; stty echo; printf '\n'
    else
      read -r KEY || true
    fi
  fi
  printf '%s' "$KEY_NAME" | grep -Eq '^[A-Z][A-Z0-9_]*_API_KEY$' || fail "cannot use the key name: $KEY_NAME"
  [ -n "${KEY:-}" ] || fail "the API key is empty"
  mkdir -p "$BASE/data"
  printf '{\n  "%s": "%s"\n}\n' "$KEY_NAME" "$KEY" > "$ENVFILE" || fail "cannot write $ENVFILE"
  chmod 600 "$ENVFILE"
  say "stored the $LABEL API key"
fi

cd "$BASE"
./xltx check || fail "xltx check failed"
say ""
say "Registering the background service..."
./xltx setup || fail "xltx setup failed; the previous version is kept at $BACKUP, fix the problem and rerun this script"
./xltx status || true
say ""
say "Scan the QR code below with WeChat."
./xltx login || fail "login did not finish; rerun: cd $BASE && ./xltx login"
say ""
say "Installed in $BASE"
