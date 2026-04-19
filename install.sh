#!/usr/bin/env bash
# HyperMem Installer
# curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
set -euo pipefail

# ─────────────────────────────────────────────
# Colors
# ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────
banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ███╗   ███╗███████╗███╗   ███╗"
  echo "  ██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗████╗ ████║██╔════╝████╗ ████║"
  echo "  ███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝██╔████╔██║█████╗  ██╔████╔██║"
  echo "  ██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║"
  echo "  ██║  ██║   ██║   ██║     ███████╗██║  ██║██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║"
  echo "  ╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝"
  echo -e "${NC}"
  echo -e "  ${DIM}The memory layer for OpenClaw agents${NC}"
  echo ""
}

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────
info()    { echo -e "  ${CYAN}→${NC} $*"; }
success() { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "  ${RED}✗${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

prompt() {
  # prompt <var_name> <question> [default]
  local var="$1" question="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    echo -ne "  ${BOLD}${question}${NC} ${DIM}[${default}]${NC} "
  else
    echo -ne "  ${BOLD}${question}${NC} "
  fi
  read -r reply </dev/tty || { [[ -n "$default" ]] && reply="$default" || die "Cannot read input (not a terminal?). Run: bash <(curl -fsSL ...) instead."; }
  [[ -z "$reply" && -n "$default" ]] && reply="$default"
  printf -v "$var" '%s' "$reply"
}

confirm() {
  # confirm <question> — returns 0 for yes, 1 for no
  echo -ne "  ${BOLD}$1${NC} ${DIM}[y/N]${NC} "
  read -r reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy] ]]
}

# ─────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────
preflight() {
  echo -e "\n${BOLD}  Preflight checks${NC}"

  # bash version
  if (( BASH_VERSINFO[0] < 4 )); then
    die "bash 4+ required (you have $BASH_VERSION)"
  fi
  success "bash $BASH_VERSION"

  # curl
  command -v curl &>/dev/null || die "curl is required"
  success "curl $(curl --version | head -1 | awk '{print $2}')"

  # git
  command -v git &>/dev/null || die "git is required"
  success "git $(git --version | awk '{print $3}')"

  # node
  command -v node &>/dev/null || die "Node.js is required (v22+)"
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  (( NODE_MAJOR >= 22 )) || die "Node.js v22+ required (you have v$NODE_VERSION — HyperMem requires v22+)"
  success "node v$NODE_VERSION"

  # npm
  command -v npm &>/dev/null || die "npm is required"
  success "npm $(npm --version)"
}

# ─────────────────────────────────────────────
# Hardware detection
# ─────────────────────────────────────────────
detect_hardware() {
  echo -e "\n${BOLD}  Detecting hardware${NC}"

  HAS_NVIDIA=false
  HAS_AMD=false
  HAS_OLLAMA=false
  HAS_API_KEY=false
  DETECTED_TIER=1

  # NVIDIA GPU
  if command -v nvidia-smi &>/dev/null; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
    HAS_NVIDIA=true
    success "NVIDIA GPU: $GPU_NAME"
  else
    info "No NVIDIA GPU detected"
  fi

  # AMD GPU
  if command -v rocm-smi &>/dev/null || lspci 2>/dev/null | grep -qi 'amd.*display\|radeon'; then
    HAS_AMD=true
    success "AMD GPU detected"
  fi

  # Ollama
  if command -v ollama &>/dev/null; then
    OLLAMA_VERSION=$(ollama --version 2>/dev/null || echo "unknown")
    HAS_OLLAMA=true
    success "Ollama: $OLLAMA_VERSION"
  else
    info "Ollama not found"
  fi

  # API key (OpenRouter or OpenAI-compatible) — informational only, does NOT affect recommendation
  if [[ -n "${OPENROUTER_API_KEY:-}" || -n "${HYPERMEM_EMBED_API_KEY:-}" ]]; then
    HAS_API_KEY=true
    info "Embedding API key detected (Tier 4 available)"
  else
    info "No embedding API key in environment"
  fi

  # Recommend tier based on hardware only — operator opts into Tier 4 explicitly
  if $HAS_OLLAMA && ($HAS_NVIDIA || $HAS_AMD); then
    DETECTED_TIER=3
  elif $HAS_NVIDIA || $HAS_AMD; then
    # GPU present but no Ollama — recommend Tier 2, note Tier 3 needs Ollama
    DETECTED_TIER=2
  else
    # CPU-only or unknown — Tier 2 runs everywhere via WASM, no Ollama needed
    DETECTED_TIER=2
  fi
}

# ─────────────────────────────────────────────
# Tier selection
# ─────────────────────────────────────────────
select_tier() {
  echo -e "\n${BOLD}  Memory tier selection${NC}\n"

  echo -e "  ${DIM}Choose how HyperMem handles semantic memory retrieval:${NC}\n"

  echo -e "  ${BOLD}1)${NC} ${GREEN}FTS5 + BM25${NC} ${DIM}(Tier 1 — keyword search only)${NC}"
  echo -e "     No embedder. Fast, zero extra dependencies."
  echo -e "     Best for: minimal setups, very low spec hardware.\n"

  echo -e "  ${BOLD}2)${NC} ${GREEN}MiniLM-L6-v2${NC} ${DIM}(Tier 2 — lightweight semantic)${NC}"
  echo -e "     384-dimension embedder, runs in Node via WASM. No GPU, no Ollama."
  echo -e "     Best for: CPU-only servers, Raspberry Pi, low-memory VMs.\n"

  echo -e "  ${BOLD}3)${NC} ${GREEN}nomic-embed-text${NC} ${DIM}(Tier 3 — GPU-accelerated local)${NC}"
  echo -e "     768-dimension embedder via Ollama. GPU strongly recommended."
  echo -e "     Best for: local workstations with a GPU, self-hosted setups.\n"

  echo -e "  ${BOLD}4)${NC} ${GREEN}qwen3-embedding:8b${NC} ${DIM}(Tier 4 — API, top quality)${NC}"
  echo -e "     4096-dimension embedder via OpenRouter (or any OpenAI-compatible API)."
  echo -e "     Best for: production deployments, highest retrieval quality.\n"

  echo -e "  ${DIM}Recommended for your hardware: ${NC}${BOLD}Tier ${DETECTED_TIER}${NC}"
  $HAS_API_KEY && echo -e "  ${DIM}(Tier 4 also available — API key detected in environment)${NC}"
  echo ""

  while true; do
    prompt TIER_INPUT "Select tier (1-4):" "$DETECTED_TIER"
    if [[ "$TIER_INPUT" =~ ^[1-4]$ ]]; then
      SELECTED_TIER="$TIER_INPUT"
      break
    fi
    warn "Enter a number between 1 and 4"
  done

  echo ""
  case "$SELECTED_TIER" in
    1) success "Tier 1: FTS5+BM25 — no embedder needed" ;;
    2) success "Tier 2: MiniLM-L6-v2 via @huggingface/transformers" ;;
    3) success "Tier 3: nomic-embed-text via Ollama" ;;
    4) success "Tier 4: qwen3-embedding:8b via OpenRouter" ;;
  esac
}

# ─────────────────────────────────────────────
# Install HyperMem
# ─────────────────────────────────────────────
INSTALL_DIR="${HYPERMEM_INSTALL_DIR:-$HOME/.hypermem}"

install_hypermem() {
  echo -e "\n${BOLD}  Installing HyperMem${NC}"

  if [[ -d "$INSTALL_DIR" ]]; then
    if confirm "HyperMem already found at $INSTALL_DIR — update it?"; then
      info "Pulling latest..."
      git -C "$INSTALL_DIR" pull --ff-only
    else
      info "Using existing installation at $INSTALL_DIR"
    fi
  else
    info "Cloning into $INSTALL_DIR..."
    git clone https://github.com/PsiClawOps/hypermem.git "$INSTALL_DIR"
  fi

  info "Installing dependencies..."
  npm --prefix "$INSTALL_DIR" install --silent

  info "Building core..."
  npm --prefix "$INSTALL_DIR" run build

  info "Building hypercompositor plugin..."
  npm --prefix "$INSTALL_DIR/plugin" install --silent
  npm --prefix "$INSTALL_DIR/plugin" run build

  info "Building memory plugin..."
  npm --prefix "$INSTALL_DIR/memory-plugin" install --silent
  npm --prefix "$INSTALL_DIR/memory-plugin" run build

  success "HyperMem installed at $INSTALL_DIR"
}

# ─────────────────────────────────────────────
# Tier-specific setup
# ─────────────────────────────────────────────
setup_tier() {
  echo -e "\n${BOLD}  Setting up Tier ${SELECTED_TIER}${NC}"

  case "$SELECTED_TIER" in
    1)
      # Nothing to install
      EMBED_PROVIDER="none"
      EMBED_MODEL="none"
      EMBED_DIMS=0
      success "No embedder required"
      ;;

    2)
      info "Installing @huggingface/transformers (WASM embedder)..."
      npm --prefix "$INSTALL_DIR" install --silent @huggingface/transformers@3
      EMBED_PROVIDER="transformers"
      EMBED_MODEL="Xenova/all-MiniLM-L6-v2"
      EMBED_DIMS=384
      success "MiniLM-L6-v2 will download on first use (~90MB)"
      ;;

    3)
      if ! command -v ollama &>/dev/null; then
        die "Ollama is required for Tier 3. Install it from https://ollama.com then re-run."
      fi
      info "Pulling nomic-embed-text via Ollama..."
      ollama pull nomic-embed-text
      EMBED_PROVIDER="ollama"
      EMBED_MODEL="nomic-embed-text"
      EMBED_DIMS=768
      success "nomic-embed-text ready"
      ;;

    4)
      # Get API key
      API_KEY="${OPENROUTER_API_KEY:-${HYPERMEM_EMBED_API_KEY:-}}"
      if [[ -z "$API_KEY" ]]; then
        echo ""
        echo -e "  ${DIM}Get a key at https://openrouter.ai/keys${NC}"
        prompt API_KEY "OpenRouter API key:"
        [[ -z "$API_KEY" ]] && die "API key required for Tier 4"
      else
        success "Using API key from environment"
      fi
      EMBED_PROVIDER="openai"
      EMBED_MODEL="qwen/qwen3-embedding:8b"
      EMBED_DIMS=4096
      EMBED_API_KEY="$API_KEY"
      EMBED_BASE_URL="https://openrouter.ai/api/v1"
      success "Tier 4 configured — qwen3-embedding:8b via OpenRouter"
      ;;
  esac
}

# ─────────────────────────────────────────────
# Write config
# ─────────────────────────────────────────────
write_config() {
  echo -e "\n${BOLD}  Writing config${NC}"

  CONFIG_DIR="$HOME/.openclaw/hypermem"
  mkdir -p "$CONFIG_DIR"
  CONFIG_FILE="$CONFIG_DIR/config.json"

  # Build embedding block
  if [[ "$SELECTED_TIER" == "1" ]]; then
    EMBED_BLOCK='"embedding": { "provider": "none" }'
  elif [[ "$SELECTED_TIER" == "2" ]]; then
    EMBED_BLOCK="\"embedding\": { \"provider\": \"transformers\", \"model\": \"$EMBED_MODEL\", \"dimensions\": $EMBED_DIMS }"
  elif [[ "$SELECTED_TIER" == "3" ]]; then
    EMBED_BLOCK="\"embedding\": { \"provider\": \"ollama\", \"model\": \"$EMBED_MODEL\", \"dimensions\": $EMBED_DIMS, \"ollamaUrl\": \"http://localhost:11434\" }"
  else
    EMBED_BLOCK="\"embedding\": { \"provider\": \"openai\", \"model\": \"$EMBED_MODEL\", \"dimensions\": $EMBED_DIMS, \"openaiBaseUrl\": \"$EMBED_BASE_URL\", \"openaiApiKey\": \"$EMBED_API_KEY\" }"
  fi

  cat > "$CONFIG_FILE" <<EOF
{
  "installDir": "$INSTALL_DIR",
  "tier": $SELECTED_TIER,
  "contextWindowSize": 128000,
  "contextWindowReserve": 0.25,
  "deferToolPruning": false,
  "verboseLogging": false,
  "contextWindowOverrides": {},
  "warmCacheReplayThresholdMs": 120000,
  "subagentWarming": "light",
  "compositor": {
    "budgetFraction": 0.703,
    "reserveFraction": 0.25,
    "historyFraction": 0.4,
    "memoryFraction": 0.4,
    "defaultTokenBudget": 90000,
    "maxHistoryMessages": 500,
    "maxFacts": 30,
    "maxExpertisePatterns": 6,
    "maxCrossSessionContext": 4000,
    "maxTotalTriggerTokens": 4000,
    "maxRecentToolPairs": 3,
    "maxProseToolPairs": 10,
    "warmHistoryBudgetFraction": 0.4,
    "contextWindowReserve": 0.25,
    "dynamicReserveTurnHorizon": 5,
    "dynamicReserveMax": 0.5,
    "dynamicReserveEnabled": true,
    "keystoneHistoryFraction": 0.2,
    "keystoneMaxMessages": 15,
    "keystoneMinSignificance": 0.5,
    "targetBudgetFraction": 0.65,
    "enableFOS": true,
    "enableMOD": true,
    "hyperformProfile": "standard",
    "wikiTokenCap": 600,
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
  $EMBED_BLOCK,
  "vectorStore": {
    "enabled": $([ "$SELECTED_TIER" -gt 1 ] && echo true || echo false)
  }
}
EOF

  success "Config written to $CONFIG_FILE"
}

# ─────────────────────────────────────────────
# OpenClaw plugin registration
# ─────────────────────────────────────────────
register_plugin() {
  if ! command -v openclaw &>/dev/null; then
    warn "OpenClaw CLI not found, skipping plugin registration"
    echo -e "  ${DIM}Run these manually after installing OpenClaw:${NC}"
    echo -e "  ${DIM}  openclaw plugins install file:$INSTALL_DIR/plugin${NC}"
    echo -e "  ${DIM}  openclaw plugins install file:$INSTALL_DIR/memory-plugin${NC}"
    return
  fi

  echo ""
  if confirm "Register HyperMem plugins with OpenClaw?"; then
    # Context engine plugin (hypercompositor)
    info "Registering context engine plugin (hypercompositor)..."
    if openclaw plugins install "file:$INSTALL_DIR/plugin" 2>/dev/null; then
      success "hypercompositor registered"
    else
      warn "Context engine registration failed — run: openclaw plugins install file:$INSTALL_DIR/plugin"
    fi

    # Memory plugin (hypermem)
    info "Registering memory plugin (hypermem)..."
    if openclaw plugins install "file:$INSTALL_DIR/memory-plugin" 2>/dev/null; then
      success "hypermem registered"
    else
      warn "Memory plugin registration failed — run: openclaw plugins install file:$INSTALL_DIR/memory-plugin"
    fi

    # Configure plugin slots
    info "Configuring plugin slots..."
    local SLOT_OK=true
    openclaw config set plugins.slots.contextEngine hypercompositor 2>/dev/null || SLOT_OK=false
    openclaw config set plugins.slots.memory hypermem 2>/dev/null || SLOT_OK=false
    if $SLOT_OK; then
      success "Plugin slots configured"
    else
      warn "Slot config failed — set manually:"
      echo -e "  ${DIM}  openclaw config set plugins.slots.contextEngine hypercompositor${NC}"
      echo -e "  ${DIM}  openclaw config set plugins.slots.memory hypermem${NC}"
    fi

    success "Restart OpenClaw to activate: openclaw gateway restart"
  fi
}

# ─────────────────────────────────────────────
# Smoke test
# ─────────────────────────────────────────────
smoke_test() {
  echo -e "\n${BOLD}  Smoke test${NC}"

  # Verify config parses and has required fields
  node --input-type=module <<EOF 2>/dev/null && success "Config loads cleanly" || warn "Config load failed — check $HOME/.openclaw/hypermem/config.json"
import { readFileSync, existsSync } from 'fs';
const cfg = JSON.parse(readFileSync('$HOME/.openclaw/hypermem/config.json', 'utf8'));
if (!cfg.tier) throw new Error('missing tier');
if (!cfg.installDir) throw new Error('missing installDir');
if (!existsSync(cfg.installDir)) throw new Error('installDir does not exist: ' + cfg.installDir);
EOF

  # Verify HyperMem core module loads
  node --input-type=module <<EOF 2>/dev/null \
    && success "HyperMem core module loads" \
    || warn "HyperMem core module load failed — check $INSTALL_DIR"
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('$INSTALL_DIR/dist/index.js');
EOF

  # Verify context engine plugin dist exists
  [[ -f "$INSTALL_DIR/plugin/dist/index.js" ]] \
    && success "hypercompositor plugin built" \
    || warn "hypercompositor plugin not built — run: npm --prefix $INSTALL_DIR/plugin run build"

  # Verify memory plugin dist exists
  [[ -f "$INSTALL_DIR/memory-plugin/dist/index.js" ]] \
    && success "hypermem memory plugin built" \
    || warn "hypermem memory plugin not built — run: npm --prefix $INSTALL_DIR/memory-plugin run build"

  # Tier 2: verify transformers package is present
  if [[ "$SELECTED_TIER" == "2" ]]; then
    [[ -d "$INSTALL_DIR/node_modules/@huggingface/transformers" ]] \
      && success "@huggingface/transformers present" \
      || warn "@huggingface/transformers missing — run: npm --prefix $INSTALL_DIR install @huggingface/transformers@3"
  fi

  # Tier 3: verify nomic model is available in Ollama
  if [[ "$SELECTED_TIER" == "3" ]] && command -v ollama &>/dev/null; then
    ollama list 2>/dev/null | grep -q 'nomic-embed-text' \
      && success "nomic-embed-text present in Ollama" \
      || warn "nomic-embed-text not found in Ollama — run: ollama pull nomic-embed-text"
  fi
}

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
summary() {
  echo ""
  echo -e "${CYAN}${BOLD}  ─────────────────────────────────────────${NC}"
  echo -e "${CYAN}${BOLD}  HyperMem installed${NC}"
  echo -e "${CYAN}${BOLD}  ─────────────────────────────────────────${NC}"
  echo ""
  echo -e "  ${BOLD}Tier:${NC}    $SELECTED_TIER"
  echo -e "  ${BOLD}Install:${NC}  $INSTALL_DIR"
  echo -e "  ${BOLD}Config:${NC}   $HOME/.openclaw/hypermem/config.json"
  echo -e "  ${BOLD}Plugins:${NC}  hypercompositor (context-engine) + hypermem (memory)"
  echo ""

  case "$SELECTED_TIER" in
    1) echo -e "  ${DIM}FTS5+BM25 keyword search active. No embedder.${NC}" ;;
    2) echo -e "  ${DIM}MiniLM-L6-v2 will download on first embedding call.${NC}" ;;
    3) echo -e "  ${DIM}nomic-embed-text ready via Ollama.${NC}" ;;
    4) echo -e "  ${DIM}qwen3-embedding:8b via OpenRouter. API key stored in config.${NC}" ;;
  esac

  echo ""
  echo -e "  ${DIM}Upgrade tier anytime: re-run this installer and select a higher tier.${NC}"
  echo -e "  ${DIM}Docs: https://github.com/psiclawops/hypermem${NC}"
  echo ""
}

# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────
main() {
  banner
  preflight
  detect_hardware
  select_tier
  install_hypermem
  setup_tier
  write_config
  register_plugin
  smoke_test
  summary
}

main "$@"
