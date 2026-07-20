# M3b Agent Smoke

## Purpose

Manually verifies the real configured agent provider runs non-interactively through
`selectAgentRunner` and that the flag names + JSON field names in
`src/agent/providers/claude.ts` (`buildClaudeArgs` / `parseClaudeJson`) match the live CLI.

This smoke is **not a CI test** — it requires the agent CLI installed and authenticated.

## Status: VERIFIED

Smoke run against `claude` v2.1.183 (Claude Code) on 2026-06-21.

`which claude` → `/opt/homebrew/bin/claude`

### Confirmed flags (buildClaudeArgs)

- `-p` — print mode (non-interactive)
- `--output-format json` — correct; produces a single JSON line on stdout
- `--model <id>` — correct
- `--allowedTools <tools>` — correct (the alias `--allowed-tools` also accepted, but `--allowedTools` is the canonical form shown in `--help`)

No corrections needed to `buildClaudeArgs`.

### Confirmed JSON fields (parseClaudeJson)

The `claude -p --output-format json` output is a single JSON object with:

```json
{
  "total_cost_usd": 0.0366606,
  "usage": {
    "input_tokens": 9,
    "output_tokens": 417,
    ...
  }
}
```

- `total_cost_usd` — correct (mapped to `costUsd`)
- `usage.input_tokens` — correct (mapped to `tokensIn`)
- `usage.output_tokens` — correct (mapped to `tokensOut`)

No corrections needed to `parseClaudeJson`.

## Prerequisites

- `claude` CLI installed and authenticated (run `claude login` if needed)
- A local git repository with at least one commit (the smoke creates a worktree on `feat/styre-smoke`)

## How to Run

```bash
# Create a throwaway git repo if you don't have one handy:
git init /tmp/smoke-repo && cd /tmp/smoke-repo && git commit --allow-empty -m "init"

# Run the smoke:
bun run scripts/smoke-agent.ts /tmp/smoke-repo
```

Expected output:

```
agent pid: <pid>
completed: true exit: 0 timedOut: false
usage: { costUsd: <number>, tokensIn: <number>, tokensOut: <number> }
stdout (first 500): {"type":"result","subtype":"success",...}
```

## What the smoke exercises

1. `selectAgentRunner` resolves the `claude` adapter from `DEFAULT_AGENT_CONFIG`
2. `claudeAgentRunner` spawns `claude -p --output-format json --model … --allowedTools …`
3. The subprocess runs the trivial prompt ("Create a file HELLO.txt …") in the worktree
4. `parseClaudeJson` extracts `costUsd`/`tokensIn`/`tokensOut` from stdout

## Notes

- The smoke creates a git worktree under a temp directory; the worktree is not cleaned up after the run.
- This is the Step 4 verification mandated by the M3b task brief. The real flag/JSON shape
  matches what is coded in `src/agent/providers/claude.ts` — no production changes were needed.
