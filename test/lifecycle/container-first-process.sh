#!/usr/bin/env bash
# test/lifecycle/container-first-process.sh: the compiled styre as a container's first process (ENG-485
# spec 7.6, Task 15). A container's first process ignores every signal left at its default action,
# the one it re-raises at itself included, so `docker stop` used to wait 10 s and then SIGKILL (exit
# 137). With the stop handlers, Styre handles docker's SIGTERM, stops its agent, and its fallback
# exit gives 143.
#
# It builds a small image holding the binary, the fake agent CLI and the stand-in agent, with
# `styre setup` as the entry point (the agent hangs, as a long enrichment would), and runs it with
# no init process, so styre is pid 1. Once the stand-in's tool command shows in the container's own
# process list (`docker top`), it runs `docker stop` and checks:
#   - `docker inspect` reports ExitCode 143, and the stop took well under docker's 10 s timeout (so
#     the exit was Styre's, not docker's SIGKILL);
#   - the log holds Styre's stop request line and its line saying it stopped the agent and at least
#     one of its commands (the tool, which the wait above saw), and no line
#     saying something could not be stopped. When pid 1 exits, the kernel ends every process left in
#     the container, so "no stand-in remains" is shown by Styre having stopped it itself first.
# The image and the container are removed whatever happens.
#
# Needs a Linux host with docker, and the binary built for it: `bun run build` (dist/styre), or
# STYRE_BIN. STYRE_CONTAINER_BASE names the base image (default debian:trixie-slim).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FX="$ROOT/test/lifecycle/fixtures"
BIN="${STYRE_BIN:-$ROOT/dist/styre}"
BASE="${STYRE_CONTAINER_BASE:-debian:trixie-slim}"
SLEEP=4173

fail() {
  echo "container-first-process: FAIL: $*" >&2
  exit 1
}
[ "$(uname -s)" = Linux ] || fail "needs a Linux host: the binary goes into a Linux container"
[ -x "$BIN" ] || fail "no binary at $BIN: run 'bun run build' first"
command -v docker >/dev/null || fail "docker is not installed"

id="$$-$RANDOM"
tag="styre-lifecycle-pid1:$id"
name="styre-lifecycle-pid1-$id"
ctx="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rmi -f "$tag" >/dev/null 2>&1 || true
  rm -rf "$ctx"
}
trap cleanup EXIT

cp "$BIN" "$ctx/styre"
cp "$FX/fake-claude.sh" "$FX/standin-agent.sh" "$ctx/"
cat >"$ctx/config.json" <<'JSON'
{"telemetry":false,"agent":{"provider":"claude","command":"/fixtures/fake-claude.sh","models":{"deep":"d","standard":"s","cheap":"c"}}}
JSON
cat >"$ctx/Dockerfile" <<DOCKERFILE
FROM $BASE
COPY styre /usr/local/bin/styre
COPY fake-claude.sh standin-agent.sh /fixtures/
COPY config.json /config.json
RUN chmod 755 /usr/local/bin/styre /fixtures/fake-claude.sh /fixtures/standin-agent.sh \
 && mkdir -p /repo /out && printf "source 'https://rubygems.org'\n" > /repo/Gemfile
ENV STYRE_FAKE_AGENT=hang STANDIN_SLEEP=$SLEEP ANTHROPIC_API_KEY=test-key-not-real DO_NOT_TRACK=1 \
    XDG_STATE_HOME=/state XDG_CONFIG_HOME=/config
ENTRYPOINT ["/usr/local/bin/styre", "setup", "/repo", "--config", "/config.json", "--out", "/out/profile.json"]
DOCKERFILE

docker build -q -t "$tag" "$ctx" >/dev/null
# --init=false: no init process, whatever the daemon's default, so styre is pid 1. --ulimit core=0:
# a crash stores no core file (on a host whose core_pattern is a pipe, such as apport, it would be
# kept on the host).
docker run -d --init=false --ulimit core=0 --name "$name" "$tag" >/dev/null

first="$(docker exec "$name" cat /proc/1/cmdline | tr '\0' ' ')"
case "$first" in
/usr/local/bin/styre\ setup*) ;;
*) fail "the container's first process is not styre: $first" ;;
esac

# Wait (bounded) for the stand-in agent's tool command: the agent is running.
running=no
for _ in $(seq 1 150); do
  if docker top "$name" -o pid,args 2>/dev/null | grep -q "sleep $SLEEP\$"; then
    running=yes
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    docker logs "$name" >&2 || true
    fail "styre exited before its agent started"
  fi
  sleep 0.2
done
[ "$running" = yes ] || {
  docker logs "$name" >&2 || true
  fail "the stand-in agent never started"
}

start="$(date +%s%N)"
docker stop -t 10 "$name" >/dev/null
took_ms=$((($(date +%s%N) - start) / 1000000))
code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
log="$(docker logs "$name" 2>&1)"

echo "container-first-process: exit code $code after ${took_ms} ms"
echo "$log" | sed 's/^/  log: /'
[ "$code" = 143 ] || fail "ExitCode $code, expected 143"
[ "$took_ms" -lt 8000 ] || fail "docker stop took ${took_ms} ms: Styre did not end the container itself"
grep -qF "styre: received a stop request (SIGTERM) — cleaning up…" <<<"$log" ||
  fail "no stop request line in the log"
# At least one command: the stand-in's tool, which exists, was stopped by Styre, not by the kernel
# when pid 1 exited.
grep -qE "^styre: stopped the agent \(pid [0-9]+\) and [1-9][0-9]* of its commands\.$" <<<"$log" ||
  fail "no line saying the agent and at least one of its commands were stopped"
if grep -qE "could not (stop|confirm)" <<<"$log"; then fail "something was left running"; fi
echo "container-first-process: PASS"
