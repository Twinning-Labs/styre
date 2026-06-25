#!/usr/bin/env sh
set -e

OUTFILE="${OUTFILE:-dist/styre}"
mkdir -p "$(dirname "$OUTFILE")"

# TARGET is an optional Bun --target (e.g. bun-darwin-arm64). Empty => native.
if [ -n "$TARGET" ]; then
  bun build --compile --target="$TARGET" ./src/index.ts --outfile "$OUTFILE"
else
  bun build --compile ./src/index.ts --outfile "$OUTFILE"
fi

# Bun's compiled binary ships an ad-hoc "linker-signed" signature that newer
# macOS (Apple Silicon) rejects with SIGKILL (exit 137); re-sign ad-hoc so it
# runs. Only on a macOS host (codesign exists); Linux/CI skips this.
if [ "$(uname)" = "Darwin" ]; then
  codesign --sign - --force "$OUTFILE"
fi
