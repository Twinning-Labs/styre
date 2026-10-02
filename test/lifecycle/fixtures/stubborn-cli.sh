#!/bin/sh
# test/lifecycle/fixtures/stubborn-cli.sh: ignores SIGTERM (review round 1, finding 1).
trap '' TERM
while :; do sleep 1; done
