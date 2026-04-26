#!/usr/bin/env bash
# HyperMem npm-first installer and upgrader
# curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

PACKAGE="${HYPERMEM_PACKAGE:-@psiclawops/hypermem@latest}"
INSTALL_DIR="${HYPERMEM_INSTALL_DIR:-$HOME/.hypermem}"
RUNTIME_DIR="${HYPERMEM_RUNTIME_DIR:-$HOME/.openclaw/plugins/hypermem}"
CONFIG_FILE="$HOME/.openclaw/hypermem/config.json"
ASSUME_YES=false
SKIP_NPM=false
SKIP_STAGE=false
DRY_RUN=false

usage() {
  cat <<EOF
HyperMem installer

Usage: install.sh [options]

Options:
  --yes              non-interactive defaults
  --package <spec>   npm package spec, default: @psiclawops/hypermem@latest
  --install-dir <p>  npm install directory, default: ~/.hypermem
  --runtime-dir <p>  staged OpenClaw runtime dir, default: ~/.openclaw/plugins/hypermem
  --skip-npm         use existing package in install dir
  --skip-stage       install package only, do not run hypermem-install
  --dry-run          print planned actions without installing, staging, or writing config
  --help             show this help

Environment overrides:
  HYPERMEM_PACKAGE, HYPERMEM_INSTALL_DIR, HYPERMEM_RUNTIME_DIR

This script stages HyperMem. It does not edit OpenClaw config and does not restart the gateway.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=true; shift ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --runtime-dir) RUNTIME_DIR="$2"; shift 2 ;;
    --skip-npm) SKIP_NPM=true; shift ;;
    --skip-stage) SKIP_STAGE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo -e "${RED}Unknown option:${NC} $1" >&2; usage; exit 1 ;;
  esac
done

info() { echo -e "  ${CYAN}→${NC} $*"; }
success() { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $*"; }
dryrun() { echo -e "  ${YELLOW}DRY-RUN${NC} $*"; }
die() { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }

confirm() {
  if $ASSUME_YES; then return 0; fi
  echo -ne "  ${BOLD}$1${NC} ${DIM}[y/N]${NC} "
  read -r reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy] ]]
}

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}  HyperMem installer${NC}"
  echo -e "  ${DIM}npm package install + OpenClaw runtime staging${NC}"
  echo ""
}

preflight() {
  echo -e "${BOLD}  Preflight${NC}"
  command -v node >/dev/null 2>&1 || die "Node.js v22+ is required"
  local node_version node_major
  node_version="$(node --version | sed 's/^v//')"
  node_major="${node_version%%.*}"
  [[ "$node_major" =~ ^[0-9]+$ ]] || die "Cannot parse Node.js version: $node_version"
  (( node_major >= 22 )) || die "Node.js v22+ required, found v$node_version"
  success "node v$node_version"

  command -v npm >/dev/null 2>&1 || die "npm is required"
  success "npm $(npm --version)"

  if $DRY_RUN; then
    warn "dry-run mode: no package install, runtime staging, config write, or gateway change will be performed"
  fi

  if command -v openclaw >/dev/null 2>&1; then
    success "openclaw CLI found"
    openclaw gateway status >/dev/null 2>&1 || warn "OpenClaw gateway is not running or not onboarded yet. Complete OpenClaw setup before activation."
  else
    warn "openclaw CLI not found. HyperMem can be staged now, but activation requires OpenClaw."
  fi
}

install_package() {
  echo -e "\n${BOLD}  Package install${NC}"
  if $DRY_RUN; then
    dryrun "would create/install package directory: $INSTALL_DIR"
    dryrun "would install package: $PACKAGE"
    return
  fi

  mkdir -p "$INSTALL_DIR"
  if [[ ! -f "$INSTALL_DIR/package.json" ]]; then
    info "initializing $INSTALL_DIR"
    npm --prefix "$INSTALL_DIR" init -y --silent >/dev/null
  fi

  if $SKIP_NPM; then
    [[ -d "$INSTALL_DIR/node_modules/@psiclawops/hypermem" ]] || die "--skip-npm requested but package is missing in $INSTALL_DIR"
    success "using existing package in $INSTALL_DIR"
    return
  fi

  info "installing $PACKAGE"
  npm --prefix "$INSTALL_DIR" install --silent "$PACKAGE"
  success "package installed in $INSTALL_DIR"
}

backup_runtime() {
  if $DRY_RUN; then
    dryrun "would check for existing runtime and optionally back up: $RUNTIME_DIR"
    return 0
  fi

  [[ -e "$RUNTIME_DIR" ]] || return 0
  local backup
  backup="${RUNTIME_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
  if confirm "Existing runtime found at $RUNTIME_DIR. Back it up before replacing?"; then
    cp -a "$RUNTIME_DIR" "$backup"
    success "backup written to $backup"
  else
    warn "continuing without runtime backup"
  fi
}

stage_runtime() {
  echo -e "\n${BOLD}  Runtime staging${NC}"
  if $SKIP_STAGE; then
    warn "runtime staging skipped"
    return
  fi

  if $DRY_RUN; then
    dryrun "would run runtime installer into: $RUNTIME_DIR"
    return
  fi

  local installer="$INSTALL_DIR/node_modules/@psiclawops/hypermem/scripts/install-runtime.mjs"
  [[ -f "$installer" ]] || die "missing runtime installer: $installer"
  backup_runtime
  node "$installer" "$RUNTIME_DIR"
  success "runtime staged to $RUNTIME_DIR"
}

write_minimal_config_if_missing() {
  echo -e "\n${BOLD}  Config check${NC}"
  if $DRY_RUN; then
    dryrun "would preserve existing config or write lightweight starter config: $CONFIG_FILE"
    return
  fi

  if [[ -f "$CONFIG_FILE" ]]; then
    success "existing config preserved: $CONFIG_FILE"
    return
  fi

  mkdir -p "$(dirname "$CONFIG_FILE")"
  cat > "$CONFIG_FILE" <<'JSON'
{
  "contextWindowSize": 128000,
  "contextWindowReserve": 0.25,
  "deferToolPruning": false,
  "verboseLogging": false,
  "contextWindowOverrides": {},
  "warmCacheReplayThresholdMs": 120000,
  "subagentWarming": "light",
  "embedding": {
    "provider": "none"
  },
  "compositor": {
    "budgetFraction": 0.55,
    "reserveFraction": 0.25,
    "historyFraction": 0.4,
    "memoryFraction": 0.4,
    "defaultTokenBudget": 90000,
    "maxHistoryMessages": 500,
    "maxFacts": 25,
    "maxExpertisePatterns": 6,
    "maxCrossSessionContext": 4000,
    "maxTotalTriggerTokens": 4000,
    "maxRecentToolPairs": 3,
    "maxProseToolPairs": 10,
    "warmHistoryBudgetFraction": 0.27,
    "contextWindowReserve": 0.25,
    "dynamicReserveTurnHorizon": 5,
    "dynamicReserveMax": 0.5,
    "dynamicReserveEnabled": true,
    "keystoneHistoryFraction": 0.15,
    "keystoneMaxMessages": 12,
    "keystoneMinSignificance": 0.5,
    "targetBudgetFraction": 0.50,
    "enableFOS": true,
    "enableMOD": true,
    "hyperformProfile": "standard",
    "wikiTokenCap": 500,
    "zigzagOrdering": true
  },
  "eviction": {
    "enabled": true,
    "imageAgeTurns": 2,
    "toolResultAgeTurns": 4,
    "minTokensToEvict": 200,
    "keepPreviewChars": 120
  },
  "maintenance": {
    "periodicInterval": 300000,
    "maxActiveConversations": 5,
    "recentConversationCooldownMs": 30000,
    "maxCandidatesPerPass": 200
  },
  "vectorStore": {
    "enabled": false
  }
}
JSON
  success "lightweight starter config written: $CONFIG_FILE"
}

verify_stage() {
  echo -e "\n${BOLD}  Stage verification${NC}"
  if $DRY_RUN; then
    dryrun "would verify runtime payload under: $RUNTIME_DIR"
    return
  fi

  [[ -d "$RUNTIME_DIR/dist" ]] || die "missing $RUNTIME_DIR/dist"
  [[ -d "$RUNTIME_DIR/plugin/dist" ]] || die "missing $RUNTIME_DIR/plugin/dist"
  [[ -d "$RUNTIME_DIR/memory-plugin/dist" ]] || die "missing $RUNTIME_DIR/memory-plugin/dist"
  [[ -f "$RUNTIME_DIR/bin/hypermem-status.mjs" ]] || die "missing hypermem-status bin"
  [[ -f "$RUNTIME_DIR/bin/hypermem-model-audit.mjs" ]] || die "missing hypermem-model-audit bin"
  success "runtime payload complete"
}

next_steps() {
  echo ""
  echo -e "${CYAN}${BOLD}  HyperMem staged${NC}"
  echo ""
  echo -e "  ${BOLD}Package:${NC}  $PACKAGE"
  echo -e "  ${BOLD}Install:${NC}  $INSTALL_DIR"
  echo -e "  ${BOLD}Runtime:${NC}  $RUNTIME_DIR"
  echo -e "  ${BOLD}Config:${NC}   $CONFIG_FILE"
  echo ""
  echo -e "  ${BOLD}Activation commands:${NC}"
  cat <<EOF
    openclaw config get plugins.load.paths
    openclaw config get plugins.allow

    HYPERMEM_PATHS="[\"${RUNTIME_DIR}/plugin\",\"${RUNTIME_DIR}/memory-plugin\"]"
    openclaw config set plugins.load.paths "\$HYPERMEM_PATHS" --strict-json
    openclaw config set plugins.slots.contextEngine hypercompositor
    openclaw config set plugins.slots.memory hypermem

    # Only if plugins.allow already contains an array, append hypercompositor and hypermem to that existing array.
    # If plugins.allow is unset, null, or empty, skip the allowlist step.

    openclaw gateway restart
EOF
  echo ""
  echo -e "  ${BOLD}Verify:${NC}"
  cat <<EOF
    openclaw plugins list
    openclaw logs --limit 100 | grep -E 'hypermem|context-engine|falling back'
    node ${RUNTIME_DIR}/bin/hypermem-status.mjs --health
    node ${RUNTIME_DIR}/bin/hypermem-model-audit.mjs --strict
EOF
  echo ""
  echo -e "  ${DIM}A staged runtime is not active until OpenClaw is wired and restarted.${NC}"
}

main() {
  banner
  preflight
  install_package
  stage_runtime
  write_minimal_config_if_missing
  verify_stage
  next_steps
}

main "$@"
