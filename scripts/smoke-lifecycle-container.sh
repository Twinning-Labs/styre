#!/usr/bin/env bash
# scripts/smoke-lifecycle-container.sh: the live lifecycle smoke (scripts/smoke-lifecycle.ts) inside a
# container, the fourth place spec 11.2 names (ENG-485 Task 16; operator decision 2026-10-08: the
# laptop's docker, the key passed by name, a user that is not root, core dumps off, --rm).
#
# Usage, on a Linux host with docker, from a clone that holds the branch to test and the control's
# branch baseline/pre-eng-485 (locally, or as origin's after a fetch):
#   bash scripts/smoke-lifecycle-container.sh            live: seven real dispatches; needs
#                                                         ANTHROPIC_API_KEY in this environment
#   bash scripts/smoke-lifecycle-container.sh --standin  the free mode: the stand-in claude
#
# It builds a small image on oven/bun (Bun, plus git, procps, lsof, Node and npm) with the claude CLI
# pinned to the same version as .github/workflows/lifecycle-live.yml, and the committed state of this
# clone (uncommitted changes are not copied) with the baseline branch. It runs the smoke there as the
# image's user `bun` (uid 1000), with tini as the first process (--init, so orphans are reaped as on
# a normal machine), `--ulimit core=0`, and a time limit inside and outside the container. The image,
# the container and the build folder are removed whatever happens; base images are left alone.
#
# The key: `docker run -e ANTHROPIC_API_KEY` copies the variable by name from this environment into
# the container. This script never expands, prints, logs or writes its value; it only tests that it
# is set. Never add `set -x` here: it would print commands, and the environment with them.
set -euo pipefail

# The version on npm's `latest` dist tag when this was written (`npm view @anthropic-ai/claude-code
# dist-tags`), the same pin as the workflow (test/lifecycle/live-smoke.test.ts checks it).
CLAUDE_PIN="@anthropic-ai/claude-code@2.1.293"
BASE="${STYRE_SMOKE_BASE:-oven/bun:1.4.2}"
BASELINE="baseline/pre-eng-485"

mode=live
case "${1:-}" in
"") ;;
--standin) mode=standin ;;
*)
  echo "usage: smoke-lifecycle-container.sh [--standin]" >&2
  exit 64
  ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() {
  echo "smoke-lifecycle-container: FAIL: $*" >&2
  exit 1
}
[ "$(uname -s)" = Linux ] || fail "needs a Linux host with docker"
command -v docker >/dev/null || fail "docker is not installed"
if [ "$mode" = live ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  fail "ANTHROPIC_API_KEY is not set: the live run passes it to the container by name"
fi
ref=""
for r in "refs/heads/$BASELINE" "refs/remotes/origin/$BASELINE"; do
  if git -C "$ROOT" rev-parse --verify --quiet "$r" >/dev/null; then
    ref="$r"
    break
  fi
done
[ -n "$ref" ] || fail "no branch $BASELINE in $ROOT: fetch it first"

id="$$-$RANDOM"
tag="styre-smoke-lifecycle:$id"
name="styre-smoke-lifecycle-$id"
ctx="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rmi -f "$tag" >/dev/null 2>&1 || true
  rm -rf "$ctx"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The committed state of this clone, with the baseline as a local branch.
git clone -q --no-hardlinks "$ROOT" "$ctx/repo"
git -C "$ctx/repo" fetch -q "$ROOT" "+$ref:refs/heads/$BASELINE"
cat >"$ctx/Dockerfile" <<DOCKERFILE
FROM $BASE
USER root
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git ca-certificates procps lsof nodejs npm \\
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g $CLAUDE_PIN && claude --version && getconf CLK_TCK
ENV DISABLE_AUTOUPDATER=1 DO_NOT_TRACK=1
COPY --chown=bun:bun repo /home/bun/repo
USER bun
WORKDIR /home/bun/repo
RUN bun install --frozen-lockfile
DOCKERFILE
echo "smoke-lifecycle-container: building $tag from $BASE ($(git -C "$ROOT" rev-parse --short HEAD), control $ref)"
docker build -q -t "$tag" "$ctx" >/dev/null

args=(run --rm --init --name "$name" --user 1000:1000 --ulimit core=0)
smoke=(timeout 900 bun run scripts/smoke-lifecycle.ts)
if [ "$mode" = live ]; then
  args+=(-e ANTHROPIC_API_KEY)
else
  smoke+=(--standin)
fi
echo "smoke-lifecycle-container: running the $mode smoke"
status=0
timeout 960 docker "${args[@]}" "$tag" "${smoke[@]}" || status=$?
if [ "$status" -ne 0 ]; then fail "the smoke exited $status"; fi
echo "smoke-lifecycle-container: PASS ($mode)"
