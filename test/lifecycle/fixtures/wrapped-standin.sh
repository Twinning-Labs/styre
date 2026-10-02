#!/bin/sh
# test/lifecycle/fixtures/wrapped-standin.sh — a wrapper that does NOT exec (§2.2).
"$(dirname "$0")/standin-agent.sh"
