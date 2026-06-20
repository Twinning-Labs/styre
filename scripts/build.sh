#!/usr/bin/env sh
set -e
bun build --compile ./src/index.ts --outfile dist/styre
# Bun's compiled binary ships an ad-hoc "linker-signed" signature that newer
# macOS (Apple Silicon) rejects with SIGKILL (exit 137); re-sign ad-hoc so it
# runs locally. Linux/CI has no codesign and skips this.
if [ "$(uname)" = "Darwin" ]; then
  codesign --sign - --force dist/styre
fi
