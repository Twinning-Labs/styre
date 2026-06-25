#!/usr/bin/env bash
# record-demo.sh — capture a styre run terminal session and emit docs/assets/demo.svg
#
# ─── RECORDER DEPENDENCY ────────────────────────────────────────────────────────
# This script uses svg-term-cli (npm) to convert an asciinema .cast file to SVG.
#
#   Install asciinema (records the session):
#     macOS:  brew install asciinema
#     Linux:  pip install asciinema   OR   see https://asciinema.org/docs/installation
#
#   Install svg-term-cli (renders the .cast → SVG):
#     npm install -g svg-term-cli     # requires Node ≥ 18
#
#   Alternative renderer (if you prefer a Rust tool, no Node required):
#     cargo install --git https://github.com/asciinema/agg
#     # Then replace the svg-term-cli invocation below with:
#     #   agg "$CAST_FILE" "$SVG_OUT"
#
# ─── HOW TO RUN ─────────────────────────────────────────────────────────────────
# Prerequisites: a built styre binary on PATH, valid credentials, and a live
# Linear ticket ID to drive.
#
#   DEMO_TICKET=ENG-999 bash scripts/record-demo.sh
#
# The script records the terminal session, converts it to an SVG, and writes
# docs/assets/demo.svg.  Commit that file; it is not regenerated at build time.
#
# ─── CAPTURE IS DEFERRED ────────────────────────────────────────────────────────
# The SVG is committed once captured — it is NOT generated at build time and is
# NOT a build/CI dependency.  The recorder (asciinema + svg-term-cli) is an
# optional developer tool; it does not appear in package.json.
#
# Capture requires:
#   1. A locally built `styre` binary (`bun run build` or `./scripts/build.sh`)
#   2. A valid ANTHROPIC_API_KEY (or subscription session) in the environment
#   3. A live Linear ticket ID (DEMO_TICKET env var or first positional arg)
#   4. The recorder tools installed (see above)
#
# Until the SVG is captured, README.md keeps the ASCII diagram fallback.
# The slot comment <!-- demo cast injected by Task 9: docs/assets/demo.svg -->
# marks where the <img> tag should be inserted once the SVG is ready.
# ────────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS_DIR="$REPO_ROOT/docs/assets"
CAST_FILE="$REPO_ROOT/docs/assets/demo.cast"
SVG_OUT="$ASSETS_DIR/demo.svg"

# Ticket ID: first positional arg, or DEMO_TICKET env var, or error.
TICKET="${1:-${DEMO_TICKET:-}}"
if [[ -z "$TICKET" ]]; then
  echo "ERROR: provide a ticket ID as the first argument or via DEMO_TICKET env var." >&2
  echo "  Usage: DEMO_TICKET=ENG-999 $0" >&2
  exit 1
fi

# ── Dependency checks ────────────────────────────────────────────────────────
for cmd in asciinema svg-term styre; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found on PATH." >&2
    case "$cmd" in
      asciinema)   echo "  Install: brew install asciinema  OR  pip install asciinema" >&2 ;;
      svg-term)    echo "  Install: npm install -g svg-term-cli" >&2 ;;
      styre)       echo "  Build:   bun run build  (or ./scripts/build.sh)" >&2 ;;
    esac
    exit 1
  fi
done

mkdir -p "$ASSETS_DIR"

echo "==> Recording: styre run $TICKET"
echo "    Cast file:  $CAST_FILE"
echo "    SVG output: $SVG_OUT"
echo ""

# Record the terminal session.
# --overwrite   : replace any previous .cast file
# --rows/--cols : fix dimensions so the SVG renders consistently
asciinema rec \
  --overwrite \
  --rows 30 \
  --cols 100 \
  --command "styre run $TICKET" \
  "$CAST_FILE"

echo ""
echo "==> Converting cast → SVG"
svg-term \
  --in "$CAST_FILE" \
  --out "$SVG_OUT" \
  --window \
  --width 100 \
  --height 30 \
  --term iterm2

echo ""
echo "Done. SVG written to: $SVG_OUT"
echo ""
echo "Next steps:"
echo "  1. Review $SVG_OUT (open in a browser)."
echo "  2. git add docs/assets/demo.svg docs/assets/demo.cast"
echo "  3. In README.md, replace the <!-- demo cast injected by Task 9 --> comment with:"
echo '     <p align="center"><img src="docs/assets/demo.svg" alt="styre run driving a ticket from design to merged" width="800"></p>'
echo "  4. Commit: git commit -m 'docs: add animated demo cast'"
