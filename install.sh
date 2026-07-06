#!/usr/bin/env bash
set -euo pipefail

PREFIX="${AGENT_CONTINUITY_PREFIX:-$HOME/.local}"
PACKAGE_SPEC="${AGENT_CONTINUITY_PACKAGE:-agent-continuity}"
RUN_PRODUCT_INSTALL=1
DRY_RUN=0
NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-node}"
PRODUCT_ARGS=()

usage() {
  cat <<'EOF'
Agent Continuity bootstrap installer

Usage:
  install.sh [installer-options] [-- continuity-install-options]

Installer options:
  --prefix DIR              Install npm package under DIR (default: ~/.local)
  --package SPEC            npm package spec to install (default: agent-continuity)
  --from-source DIR         Install from a local source checkout
  --from-tarball FILE|URL   Install from a packed npm tarball
  --no-product-install      Only install the CLI; do not run `continuity install`
  --dry-run                 Print commands without changing the system
  -h, --help                Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/rp-arielrodriguez/agent-continuity/main/install.sh | bash
  ./install.sh --from-source . -- --no-integrations --peer-listen :9987
  ./install.sh --from-tarball ./agent-continuity-0.1.0.tgz --no-product-install
EOF
}

while (($#)); do
  case "$1" in
    --prefix)
      [[ $# -ge 2 ]] || { echo "missing value for --prefix" >&2; exit 2; }
      PREFIX="$2"
      shift 2
      ;;
    --package)
      [[ $# -ge 2 ]] || { echo "missing value for --package" >&2; exit 2; }
      PACKAGE_SPEC="$2"
      shift 2
      ;;
    --from-source)
      [[ $# -ge 2 ]] || { echo "missing value for --from-source" >&2; exit 2; }
      PACKAGE_SPEC="$(cd "$2" && pwd)"
      shift 2
      ;;
    --from-tarball)
      [[ $# -ge 2 ]] || { echo "missing value for --from-tarball" >&2; exit 2; }
      PACKAGE_SPEC="$2"
      shift 2
      ;;
    --no-product-install)
      RUN_PRODUCT_INSTALL=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      PRODUCT_ARGS+=("$@")
      break
      ;;
    *)
      PRODUCT_ARGS+=("$1")
      shift
      ;;
  esac
done

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required command not found: $1" >&2
    exit 1
  fi
}

CONTINUITY_BIN="$PREFIX/bin/continuity"

echo "Agent Continuity installer"
echo "prefix: $PREFIX"
echo "package: $PACKAGE_SPEC"
echo "product-install: $([[ "$RUN_PRODUCT_INSTALL" -eq 1 ]] && echo yes || echo no)"

require_command "$NODE_BIN"
require_command "$NPM_BIN"

run mkdir -p "$PREFIX/bin"
run "$NPM_BIN" install -g --prefix "$PREFIX" "$PACKAGE_SPEC"

if [[ "$DRY_RUN" -eq 0 && ! -x "$CONTINUITY_BIN" ]]; then
  echo "continuity binary was not installed at $CONTINUITY_BIN" >&2
  exit 1
fi

if [[ "$RUN_PRODUCT_INSTALL" -eq 1 ]]; then
  run "$CONTINUITY_BIN" install "${PRODUCT_ARGS[@]}"
else
  echo "skipped product install"
fi

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo "Add $PREFIX/bin to PATH to run continuity without an absolute path." ;;
esac
