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
- **One-way projection.** Linear and GitHub are never read for control flow — they are write-only projections.
- **Ground-truth verdicts.** Build/test/CI output decides outcomes; agent self-scoring is discarded.
- **Clean-break stage vocab.** Stages are `design → implement → verify → review → merge → released`. No legacy gerund stages, no hardcoded `ui` stage.
- **Capability isolation.** Agents get no `gh`/Linear/branch tools and no ambient API key; the worktree is their only writable surface.

For the security and isolation model, see [`SECURITY.md`](SECURITY.md).

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
