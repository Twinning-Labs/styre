# Contributing to Styre

Thin guide. The depth lives in the architecture docs — read them first.

## Prerequisites

- [Bun](https://bun.sh) (runtime, package manager, test runner, and bundler)

## Dev loop

```sh
bun install          # install dependencies
bun test             # run the test suite
bun run lint         # Biome lint check
bun run typecheck    # TypeScript type-check (no emit)
bun run build        # compile → dist/styre
```

## Before you change anything

Read the architecture docs in order, starting at [`docs/architecture/README.md`](docs/architecture/README.md). That index lists the files and the order to read them. The load-bearing invariants are non-negotiable:

- **Single writer.** Only the runner (`styre run`) writes SQLite; workers return results.
- **One-way projection.** The issue tracker (Linear/Jira) and forge (GitHub) are never read for control flow — they are write-only projections.
- **Ground-truth verdicts.** Build/test/CI output decides outcomes; agent self-scoring is discarded.
- **Clean-break stage vocab.** Stages are `design → implement → verify → review → merge → released`. No legacy gerund stages, no hardcoded `ui` stage.
- **Capability isolation.** Agents get no `gh`/tracker/branch tools and no tracker/forge credentials in their environment; each step gets exactly its allowlisted tools, and the worktree is the only place their file tools can write. (See [`SECURITY.md`](SECURITY.md) for the exact env-scrub policy.)

- **One door for processes.** Only `src/util/process/door.ts` (and `proc-table.ts`'s `ps` and `getconf` calls) starts a process; a source guard enforces it. See the invariant in `CLAUDE.md`. The same guard refuses, anywhere in `src/`, the APIs that run the event loop from inside a callback (`bun:test` and its matchers, `HTMLRewriter`, `Bun.build`, `Bun.plugin`, `Bun.serve`, `Bun.Transpiler`, macros, IPC), because on macOS that loses a child's exit (oven-sh/bun#33261, ENG-489).

For the security and isolation model, see [`SECURITY.md`](SECURITY.md).

## Process lifecycle checks (ENG-485)

`bun test` covers the stop handling with stand-in agents, real signals and real terminals (`test/lifecycle`, `test/util/process`). Tests always point `XDG_STATE_HOME` at a temporary folder, even when you have set it, so they never touch your real launch records. A test claims every process it starts through `test/helpers/own-processes.ts` and cleans up only those, by pid and start time; `test/lifecycle/test-process-guard.test.ts` refuses `process.kill` anywhere else under `test/`. Four manual scripts go further. None runs in CI on every PR.

| Script | What it does | Cost |
|---|---|---|
| `bun run scripts/smoke-lifecycle.ts --standin` | The live smoke's free mode: every scenario (Ctrl-C, `kill`, `kill -9` then `styre ls`, a timeout, `Ctrl-\`) against a stand-in `claude`, plus the control run that must leak. Run it before every live run. | free |
| `bun run scripts/smoke-lifecycle.ts --live [--model <claude model>]` | The same with the real `claude` CLI, installed and signed in. | seven real dispatches on the cheap model (`claude-haiku-4-5-20251001` by default) |
| `bash scripts/smoke-lifecycle-container.sh --standin` or `--live` | The smoke inside a Linux container (needs docker). `--live` needs `ANTHROPIC_API_KEY` in the environment; the script passes it by name only. | as above |
| `bun run scripts/simulate-github-cancel.ts` | Replays GitHub's cancel (SIGINT, 7.5 s, SIGTERM, 2.5 s, SIGKILL) against a compiled `styre setup`, with and without `exec`. Set `$STYRE_BIN` to use a built binary. | free |
| `bun run scripts/measure-lifecycle-latency.ts [--rounds <n>] [--dispatches <n>]` | Dispatch latency before and after ENG-485 (median and p90), and the cost of the sweep, an empty group stop, the per step `git rev-parse` and the leftover check. At least 2 rounds: the noise is the spread between them. | free |

- **The control run** and the latency script's "before" side use the branch `baseline/pre-eng-485` (main at 9f51460, before ENG-485), exported with `git archive`. Fetch it if you do not have it: `git fetch origin baseline/pre-eng-485:refs/remotes/origin/baseline/pre-eng-485`. Both scripts refuse to run without it, or if it has `src/util/process/signals.ts`. Nobody commits to it.
- **`.github/workflows/lifecycle-live.yml`** runs the smoke on a GitHub Ubuntu VM (free mode, then live, with the `ANTHROPIC_API_KEY` secret) and the cancel test through a real `run:` step, with and without `exec`. It runs by hand only (`workflow_dispatch`), so it can run once it is on `main`. Run it twice: once letting the 3 minute timeout fire, and once cancelling by hand. In the job without `exec`, read "Terminate orphan process" under "Complete job".
- Bound every live run with `timeout -s TERM …`, not a SIGALRM based limit: the smoke cleans up on SIGINT, SIGTERM and SIGHUP only.
- Never weaken who a test cleanup or a stop may signal on your own machine. A break that widens it belongs in a throwaway container (`docker run --rm --ulimit core=0 …`).

## Where things go

| Artifact | Directory |
|---|---|
| Maintained reference — the substrate spec, glossary, ticket template, and the runtime/config/conventions references | `docs/architecture/` |
| Brainstorms (exploratory decision-shaping docs; append-only history) | `docs/brainstorms/` |
| Plans (implementation/scaffolding plans; append-only history) | `docs/plans/` |

These three are the only doc folders. `docs/architecture/` is kept current with the code — when a change alters a documented behavior, update the reference in the same PR. `docs/brainstorms/` and `docs/plans/` are append-only history: add new dated files, never rewrite old ones. Do not invent new top-level doc folders without maintainer sign-off.

## Workflow rules

These are hard rules, not guidelines:

- **Never commit directly to `main`.**
- Branch with `feat/` for features and improvements; `fix/` for bug fixes.
- Merge back via **PR only** — no direct pushes.
- **No auto-merge, ever.** Do not run `gh pr merge` or use `--auto`. The operator merges every PR personally.
- Your job ends at "PR is open and ready."

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/). The CHANGELOG is generated from commit messages by git-cliff — non-conforming commits may be omitted.

Examples:

```
feat(cli): add --resume flag to styre run
fix(projector): retry on transient Linear 5xx
docs: update architecture index
```
