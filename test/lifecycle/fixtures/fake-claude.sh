#!/bin/bash
# test/lifecycle/fixtures/fake-claude.sh: stands in for the `claude` CLI where `styre setup` needs it,
# so the real command can be driven in a terminal (Task 15b). `--version` and `--help` satisfy the
# agent CLI preflight. A dispatch then does what STYRE_FAKE_AGENT says:
#   answer (the default): reports the tools it was given, in the mode Styre asks for, and answers
#     with an empty enrichment block, as `claude -p --output-format stream-json` would;
#   hang: becomes the stand-in agent (standin-agent.sh): a tool command in its own group, waiting.
case "$1" in
  --version)
    echo "2.1.280 (Claude Code)"
    exit 0
    ;;
  --help)
    cat <<'HELP'
Usage: claude [options]

Options:
  --restricted                     Restrict the session
  --tools <tools>                  The tools the session may use
  --allowedTools <tools>           Tools allowed without asking
  --permission-mode <mode>         (choices: "default", "dontAsk")
  --strict-mcp-config              Use only the given MCP servers
  --output-format <format>         (choices: "text", "json", "stream-json")
HELP
    exit 0
    ;;
esac
if [ "$STYRE_FAKE_AGENT" = hang ]; then
  exec "$(dirname "$0")/standin-agent.sh"
fi
tools=""
while [ $# -gt 0 ]; do
  if [ "$1" = --tools ]; then tools="$2"; fi
  shift
done
cat >/dev/null # the prompt
if [ -z "$tools" ]; then list="[]"; else list="[\"$(printf '%s' "$tools" | sed 's/,/","/g')\"]"; fi
printf '{"type":"system","subtype":"init","tools":%s,"permissionMode":"dontAsk","mcp_servers":[]}\n' "$list"
cat <<'RESULT'
{"type":"result","subtype":"success","result":"```styre-setup-enrich\n{\"topology\":{\"detail\":\"\"},\"data\":{\"detail\":\"\"},\"caching\":{\"detail\":\"\"},\"observability\":{\"detail\":\"\"},\"configSecrets\":{\"detail\":\"\"},\"documentation\":{\"detail\":\"\"},\"releasePackaging\":{\"detail\":\"\"}}\n```"}
RESULT
