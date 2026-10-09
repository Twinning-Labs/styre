#!/bin/bash
# A stand-in agent whose tool command (a group of its own, by job control) leaves a member in that
# group that is NOT its descendant: a subshell starts `sleep $ORPHAN_SLEEP` and exits, so the sleep
# is reparented but stays in the tool's group. The subshell first writes the sleep's pid to
# "$ORPHAN_PID" and waits (shell builtins only) until "$ORPHAN_GO" exists, so a test can claim the
# sleep while it is still a descendant (test/helpers/own-processes.ts). The tool then runs
# `sleep $TOOL_SLEEP`.
set -m
sh -c '( sleep "$ORPHAN_SLEEP" & echo $! > "$ORPHAN_PID"; while [ ! -e "$ORPHAN_GO" ]; do :; done ); exec sleep "$TOOL_SLEEP"' &
wait
