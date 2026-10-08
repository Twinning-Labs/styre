#!/usr/bin/env bash
# test/lifecycle/assert-cancel.sh <marker> graceful|orphaned: what a cancelled step of
# .github/workflows/lifecycle-live.yml did (ENG-485 D14), read from the files the step left in
# $CANCEL_DIR (default /tmp): <marker>.log (Styre's stderr) and <marker>.pids (`step <pid>`, then
# the stand-in's `agent <pid> tool <pid>`). scripts/simulate-github-cancel.ts runs it locally
# after replaying GitHub's cancel sequence.
#
#   graceful  Styre was the step's process (`exec styre …`): it handled GitHub's SIGINT, said it was
#             stopping and that it stopped the agent and its command, and neither is running.
#   orphaned  bash was the step's process (no `exec`): Styre's handler never ran, and the agent and
#             its command are still running after the step. On GitHub the job's orphan cleanup then
#             kills them ("Terminate orphan process" under "Complete job"), with no graceful stop.
#
# It only reads: each process is looked up by its own pid (`ps -p`), and nothing is signalled.
set -uo pipefail

marker="${1:?usage: assert-cancel.sh <marker> graceful|orphaned}"
want="${2:?usage: assert-cancel.sh <marker> graceful|orphaned}"
dir="${CANCEL_DIR:-/tmp}"
log="$dir/$marker.log"
pids="$dir/$marker.pids"

fail() {
  echo "assert-cancel: FAIL ($want): $*" >&2
  exit 1
}
[ -f "$log" ] || fail "no log at $log: the step never started styre"
[ -f "$pids" ] || fail "no pid file at $pids"
echo "--- what styre said ($log):"
cat "$log"

step="$(sed -n 's/^step \([0-9][0-9]*\)$/\1/p' "$pids")"
agent="$(sed -n 's/^agent \([0-9][0-9]*\) tool [0-9][0-9]*$/\1/p' "$pids")"
tool="$(sed -n 's/^agent [0-9][0-9]* tool \([0-9][0-9]*\)$/\1/p' "$pids")"
[ -n "$agent" ] && [ -n "$tool" ] || fail "the stand-in agent never started (no agent line in $pids)"

running() { ps -o pid= -p "$1" >/dev/null 2>&1; }
echo "--- after the step (step $step, agent $agent, tool $tool):"
for p in $step $agent $tool; do
  ps -o pid=,ppid=,pgid=,args= -p "$p" 2>/dev/null || echo "pid $p: gone"
done

OPENING='styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…'
case "$want" in
graceful)
  grep -qxF "$OPENING" "$log" || fail "no stopping line: styre did not handle the step's SIGINT"
  grep -qxF "styre: stopped the agent (pid $agent) and 1 of its commands." "$log" ||
    fail "no line saying styre stopped the agent (pid $agent) and its command"
  if grep -qE '^styre: could not (stop|confirm)' "$log"; then fail "styre could not stop everything"; fi
  if running "$agent" || running "$tool"; then fail "the agent or its tool is still running"; fi
  ;;
orphaned)
  if grep -qE '^styre: (stopping —|received a stop request)' "$log"; then
    fail "styre's handler ran: the step's process was styre, not bash"
  fi
  running "$agent" && running "$tool" ||
    fail "the agent or its tool is gone: expected both left running for the job's cleanup"
  echo "the agent and its tool outlived the step; the job's orphan cleanup ends them"
  ;;
*) fail "unknown expectation $want" ;;
esac
echo "assert-cancel: PASS ($want)"
