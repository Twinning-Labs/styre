#!/bin/bash
# test/lifecycle/fixtures/stubborn-agent.sh: an agent that ignores SIGINT, SIGTERM and SIGHUP, and so
# does its tool command (in the same group), so only a forced stop (SIGKILL) ends them. A terminal's
# Ctrl-C reaches it too, and leaves it running: the stop is still in progress when a second Ctrl-C
# arrives.
trap '' INT TERM HUP
sleep "${STANDIN_SLEEP:-300}" &
# Said only now, with the traps set: tests wait for this line before they signal anything.
echo "tool $!" >&2
wait
