#!/bin/bash
# test/lifecycle/fixtures/standin-agent.sh: behaves like Claude Code where it matters (spec 11.1):
# runs a command in its OWN group; on TERM/INT/HUP stops that group and exits; on QUIT dies at once.
set -m                      # job control: the background job gets its own process group (bash, with or without a terminal)
sleep "${STANDIN_SLEEP:-300}" &   # the "tool command", leading its own group; tests set a unique value
TOOL=$!
trap 'kill -TERM -$TOOL 2>/dev/null; exit 0' TERM INT HUP
trap 'kill -KILL $$' QUIT
# Whatever way it exits on its own (an error, a crash short of SIGKILL), it stops its tool group
# first, so the tool is never left behind for a test that could not claim it in time.
trap 'kill -TERM -$TOOL 2>/dev/null' EXIT
# Said only now, with the traps set: tests wait for this line before they signal the stand-in.
echo "tool $TOOL" >&2
# With $STANDIN_PIDFILE (the GitHub cancel check), the same pids also go to that file: a CI step
# whose stderr is Styre's cannot read the line above.
if [ -n "$STANDIN_PIDFILE" ]; then echo "agent $$ tool $TOOL" >>"$STANDIN_PIDFILE"; fi
wait
