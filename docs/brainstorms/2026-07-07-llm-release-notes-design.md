# LLM-authored release notes & changelog — design

**Date:** 2026-07-07
**Status:** design, pending operator review
**Branch:** `feat/llm-release-notes`

## Problem

Both release artifacts are rendered by **git-cliff** straight from squash-merge commit
subjects, grouped by conventional-commit type:

- **`CHANGELOG.md`** (committed to the repo), and
- **the GitHub Release body**

come out as raw commit lines, e.g.:

```
### Features
- In-place execution for disposable checkouts (branch in the repo root, not a worktree) (#52)
```

That is the commit message verbatim — developer-facing, carries the `(#NN)`, reads like a
`git log`. We want **Claude Code-changelog quality**: user-facing prose a reader who never saw
the code can understand.

## Scope

**In scope:** replace the *prose* of the two artifacts with Claude-authored, user-facing notes.

**Explicitly out of scope (deferred, operator's call):**

- How the next **version number** is computed. git-cliff's `--bumped-version` (standard semver
  collapse: any feats → one minor bump) is unchanged.
- How releases are **cut** (the dispatch/build/tag/push ordering, the FF-push race). Unchanged.

Only the text inside the artifacts changes. The version, the tag, the build, the push all behave
exactly as they do today.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Who writes the prose | Claude, from the release's commits + diffstat |
| Model | **Sonnet** (styre's implement tier; exact model id confirmed against the `claude-api` skill at build time) |
| Grouping | Keep `### Features` / `### Bug Fixes` (etc.) type headings; Claude-authored bullets inside |
| GitHub Release body | This version's notes |
| `CHANGELOG.md` | **Prepend** the new version's section; old sections never rewritten (was: fully regenerated each release) |
| API access | Minimal direct call to the Anthropic **Messages API** via `fetch` (no new runtime dep; not the `claude -p` CLI) |
| If the LLM fails | **Fall back to git-cliff** rendering — a release is never blocked by notes generation |
| Preview | The existing `dry_run` path previews the *actual* Claude notes before you publish |
| Manual override | New optional `release_notes` dispatch input — used verbatim, skips the LLM |
| Secret | `ANTHROPIC_API_KEY` added to the repo, wired into the `compute` (preview) and `publish` jobs |

## Architecture

Two small, single-purpose pieces plus workflow wiring. git-cliff **stays** — it still computes
the version bump and is the fallback renderer.

### `scripts/release-notes.ts` (the only piece that touches the network)

```
release-notes.ts <version> <sinceRef> <headRef>
  → prints the notes markdown (grouped sections for THIS version) to stdout
```

Steps:

1. Gather the change set for `sinceRef..headRef`:
   - `git log <sinceRef>..<headRef> --no-merges --format=…` capturing each commit's **subject +
     body**. Because we squash-merge, the body already carries the PR description — real context,
     not just the one-liner. `chore(release)` commits are filtered (same skip rule as `cliff.toml`).
   - `git diff --stat <sinceRef>..<headRef>` for scope context (which files, how much).
2. Build the prompt (below) and call the Messages API (model = Sonnet, low temperature).
3. Print the returned markdown to stdout.
4. **On any failure** (missing `ANTHROPIC_API_KEY`, non-2xx, timeout, empty output): print nothing
   to stdout and exit non-zero, so the workflow's fallback branch runs git-cliff instead. The
   failure is logged as a `::warning::`, never fatal.

Testability: the git-gathering and prompt-building are pure and unit-tested; the single `fetch` is
the only side effect (injectable/movable behind a thin function so tests don't hit the network).

### `scripts/prepend-changelog.ts` (pure, no network)

```
prepend-changelog.ts  — pure function (existingChangelog, newSection, version) → mergedChangelog
```

- Keeps the `# Changelog` header, inserts the new `## [x.y.z] - <date>` section immediately after
  it, above all prior sections.
- **Idempotent:** if a section for this version already exists, it is replaced, not duplicated
  (protects re-runs / the heal path).
- Fully unit-tested with no network.

### Workflow changes (`.github/workflows/release.yml`)

- **`compute` job (dry-run preview):** the "Dry-run preview" step calls `release-notes.ts` (with
  `ANTHROPIC_API_KEY`) so the operator previews the *actual* Claude notes, falling back to
  `git cliff` if it fails. Version + full changelog preview unchanged.
- **`publish` job:**
  - "Render release notes" step: if the `release_notes` input is non-empty, write it verbatim to
    `RELEASE_NOTES.md`; else run `release-notes.ts` → `RELEASE_NOTES.md`; on failure fall back to
    the current `git cliff --unreleased --strip all` command.
  - "Render full changelog" step: instead of `git cliff -o CHANGELOG.md` (full regenerate), run
    `prepend-changelog.ts` to splice the just-rendered `RELEASE_NOTES.md` section onto the existing
    `CHANGELOG.md`.
  - Everything downstream (stamp + commit + FF-push, tag, GitHub Release, tap bump) is **unchanged**
    — it still commits `package.json` + `CHANGELOG.md` and posts `RELEASE_NOTES.md` as the body.
- **New input** `release_notes` (string, default `""`) on `workflow_dispatch`.
- **New secret** `ANTHROPIC_API_KEY` referenced by the two jobs.

## Data flow

```
        commits (subject+body) + diffstat  for  <lastTag>..<releaseSha>
                              │
                     scripts/release-notes.ts ──(Messages API, Sonnet)──▶ grouped notes md
                              │                         │ (on failure)
                              ▼                         ▼
                     RELEASE_NOTES.md   ◀── git cliff --unreleased (fallback)
                        │        │
                        │        └────────────▶ GitHub Release body  (unchanged publish step)
                        ▼
             prepend-changelog.ts(CHANGELOG.md, RELEASE_NOTES.md)
                        │
                        ▼
                  CHANGELOG.md  ──▶ committed to main  (unchanged publish step)
```

## Prompt design (sketch — refined at implementation)

- **System:** you write release notes for the `styre` CLI in the register of the Claude Code
  changelog — user-facing, plain language, present tense. Rules: no `type(scope):` prefixes; no PR
  numbers; no marketing fluff; drop internal-only churn (pure refactor/test/ci/chore) unless it is
  user-visible; each bullet is a self-contained sentence understandable by someone who never saw
  the diff.
- **Grouping:** emit `### Features` (from `feat`), `### Bug Fixes` (from `fix`), `### Performance`
  (from `perf`); omit a heading if its group is empty; omit internal-only groups. This mirrors the
  `cliff.toml` taxonomy so the fallback output has the same shape.
- **User content:** the version, and the change set — each commit's subject + body — plus the
  diffstat.
- **Output:** the grouped markdown section body only (no `## [version]` heading — the workflow /
  `prepend-changelog.ts` adds the version heading and date).

## Idempotency & heal

- On a **resume re-run** (the release commit is already on `main`, `resuming=true`), the commit
  step is skipped as today — so notes are **not** regenerated and `CHANGELOG.md` is not touched.
  No double-generation.
- The GitHub Release is created probe-then-apply (only if absent), so its body is written once.
- `prepend-changelog.ts` replacing an existing same-version section makes an accidental re-render
  safe.
- Builds stamp `package.json` only (never read `CHANGELOG.md`), so non-deterministic notes never
  affect the binaries or the `D5` "reproduce base" guarantee.

## Risks / trade-offs

- **Non-determinism:** the same commits can yield slightly different prose across runs. Mitigated
  by low temperature, the dry-run preview, and the `release_notes` verbatim override.
- **`CHANGELOG.md` is now append-managed**, not regenerated. Past LLM sections can't be rederived
  by git-cliff, so we must never `git cliff -o CHANGELOG.md` again (it would wipe prior prose). The
  workflow uses `prepend-changelog.ts` exclusively.
- **New CI dependency on an API key.** The fallback to git-cliff means a missing/invalid key
  degrades quality but never blocks a release.
- **Direct Messages API call** diverges from the core's `claude -p` CLI adapter. Justified: this is
  a one-shot CI/ops text generation, not an agentic tool-use run; a single `fetch` avoids installing
  and authing the agent CLI in the release runner. Exact request shape + model id validated against
  the `claude-api` skill at implementation.

## Testing

- `prepend-changelog.ts`: pure unit tests — insert into empty/header-only/populated changelog;
  idempotent replace of an existing same-version section; header preserved.
- `release-notes.ts`: unit-test the git-gathering (commit subject+body parse, `chore(release)`
  filter) and prompt assembly against a fixture commit range; the `fetch` is stubbed. One manual
  smoke against a real range (mirrors the existing agent smoke convention).
- Fallback: force a failure (unset key) and assert the workflow step falls back to git-cliff output.
```
