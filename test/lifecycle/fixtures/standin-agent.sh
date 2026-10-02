#!/bin/sh
# test/lifecycle/fixtures/standin-agent.sh: behaves like Claude Code where it matters (spec 11.1):
# runs a command in its OWN group; on TERM/INT/HUP stops that group and exits; on QUIT dies at once.
set -m                      # job control: the background job gets its own process group
sleep "${STANDIN_SLEEP:-300}" &   # the "tool command", leading its own group; tests set a unique value
TOOL=$!
echo "tool $TOOL" >&2
trap 'kill -TERM -$TOOL 2>/dev/null; exit 0' TERM INT HUP
trap 'kill -KILL $$' QUIT
wait
