#!/bin/bash
# test/lifecycle/fixtures/standin-claude.sh: the `claude` CLI as the live smoke's free mode sees it
# (scripts/smoke-lifecycle.ts --standin). No network and no model: it reports the tools it was
# given, as `claude -p --output-format stream-json` does, then runs the project's test the way
# Claude Code's Bash tool does, in a shell that leads a group of its own:
#   - SIGTERM, SIGINT, SIGHUP: it stops that group and exits (spec 2.2);
#   - SIGQUIT: with SMOKE_STANDIN_QUIT=die (the default) it dies at once and leaves the group
#     running (spec 2.2, the D13 case); with SMOKE_STANDIN_QUIT=clean it stops the group first;
#   - SMOKE_STANDIN_PARENT=follow: it also stops the group and exits when its parent dies, as no real
#     CLI did in spec 2.1 (the control then leaks nothing, and the smoke must say its probes are
#     blind);
#   - SMOKE_STANDIN_TEST=skip: its tool runs `sleep 30` instead of the test, so the smoke never
#     sees the test start;
#   - SMOKE_STANDIN_TEST=orphan: the same, and it then ends its own parent (the smoke's driver, and
#     only if that is what its parent is) with SIGKILL, so the driver dies before the smoke could
#     claim anything under it: the smoke must still stop this stand-in through the driver's group.
case "$1" in
  --version)
    echo "2.1.294 (Claude Code, stand-in)"
    exit 0
    ;;
  --help)
    echo "stand-in: --restricted --tools --allowedTools --permission-mode --strict-mcp-config --output-format"
    exit 0
    ;;
esac
tools=""
while [ $# -gt 0 ]; do
  if [ "$1" = --tools ]; then tools="$2"; fi
  shift
done
cat >/dev/null # the prompt
list="[\"$(printf '%s' "$tools" | sed 's/,/","/g')\"]"
printf '{"type":"system","subtype":"init","tools":%s,"permissionMode":"dontAsk","mcp_servers":[]}\n' "$list"
# A real CLI asks the model before its first tool call. This short wait keeps that order, so a
# startup refusal of the report above lands before any tool has run, as it does with the real CLI.
sleep 0.5

set -m # job control: the tool shell leads a group of its own, as Claude Code's does
if [ "${SMOKE_STANDIN_TEST:-run}" != run ]; then
  bash -c 'sleep 30; true' &
else
  bash -c 'sh test.sh; true' &
fi
TOOL=$!
if [ "${SMOKE_STANDIN_TEST:-run}" = orphan ] && [ "$PPID" -gt 1 ]; then
  case "$(ps -o args= -p "$PPID")" in
  *smoke-lifecycle-driver.ts*) kill -KILL "$PPID" ;;
  esac
fi
trap 'kill -TERM -$TOOL 2>/dev/null; exit 143' TERM INT HUP
if [ "${SMOKE_STANDIN_QUIT:-die}" = clean ]; then
  trap 'kill -TERM -$TOOL 2>/dev/null; exit 131' QUIT
else
  trap 'kill -KILL $$' QUIT
fi
if [ "${SMOKE_STANDIN_PARENT:-}" = follow ]; then
  parent=$PPID
  while kill -0 "$parent" 2>/dev/null && kill -0 "$TOOL" 2>/dev/null; do
    sleep 0.2 &
    wait $!
  done
  kill -TERM -$TOOL 2>/dev/null
  exit 0
fi
wait
