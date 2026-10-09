#!/usr/bin/env bash
# test/lifecycle/cancel-prepare.sh <marker>: prepares a GitHub cancel job of
# .github/workflows/lifecycle-live.yml (ENG-485 D14). It makes a repository for `styre setup` and a
# runtime config whose agent CLI is the fake claude in hang mode (it becomes the stand-in agent,
# with a tool command in a group of its own), and writes the environment of the long step to
# $GITHUB_ENV (to stdout when that is not set). The step itself writes `step <pid>` to $CANCEL_PIDS;
# the stand-in appends `agent <pid> tool <pid>`; Styre's stderr goes to $CANCEL_LOG. Both live in
# $CANCEL_DIR (default /tmp), where test/lifecycle/assert-cancel.sh reads them.
#
# ANTHROPIC_API_KEY here is a placeholder for the setup gate, which checks only that the variable is
# set: the stand-in agent never authenticates, and the real secret stays in the smoke job.
set -euo pipefail

marker="${1:?usage: cancel-prepare.sh <marker>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
base="${RUNNER_TEMP:-$(mktemp -d)}/$marker"
logs="${CANCEL_DIR:-/tmp}"
mkdir -p "$base/repo" "$logs"
git -C "$base/repo" init -q -b main
printf "source 'https://rubygems.org'\n" >"$base/repo/Gemfile"
cat >"$base/config.json" <<JSON
{"telemetry":false,"agent":{"provider":"claude","command":"$ROOT/test/lifecycle/fixtures/fake-claude.sh","models":{"deep":"d","standard":"s","cheap":"c"}}}
JSON
rm -f "$logs/$marker.log" "$logs/$marker.pids"

{
  echo "CANCEL_REPO=$base/repo"
  echo "CANCEL_CONFIG=$base/config.json"
  echo "CANCEL_OUT=$base/profile.json"
  echo "CANCEL_LOG=$logs/$marker.log"
  echo "CANCEL_PIDS=$logs/$marker.pids"
  echo "XDG_STATE_HOME=$base/state"
  echo "XDG_CONFIG_HOME=$base/config"
  echo "DO_NOT_TRACK=1"
  echo "STYRE_FAKE_AGENT=hang"
  echo "STANDIN_SLEEP=4317"
  echo "STANDIN_PIDFILE=$logs/$marker.pids"
  echo "ANTHROPIC_API_KEY=placeholder-for-the-setup-gate"
} >>"${GITHUB_ENV:-/dev/stdout}"
