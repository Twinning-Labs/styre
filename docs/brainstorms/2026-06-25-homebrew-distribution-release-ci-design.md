# Homebrew distribution: release CI + dedicated tap — design

- **Ticket:** ENG-222
- **Date:** 2026-06-25
- **Status:** brainstorm complete; independently reviewed (feasibility + security + adversarial); findings incorporated; **runner labels amended 2026-06-25 (macos-13 retired → macos-15/macos-15-intel).**
- **Scope:** the OSS release engine (cross-platform build + publish CI) with a Homebrew formula as the last mile.

> **Amendment (2026-06-25):** GitHub retired the `macos-13` runner (the original x64 macОS label), which hung the first release. The macOS labels are now **`macos-15`** (darwin-arm64) and **`macos-15-intel`** (darwin-x64 — the free Intel successor for public repos). All 4 native slices remain; Intel-Mac support is kept. Node-runtime actions were also bumped to node24 majors to clear the Node-20 deprecation warning.

## Goal

Ship `styre` via Homebrew so a user can `brew install twinning-labs/styre`. A **single human-triggered**
release auto-computes the version, generates the changelog, builds all four platform slices, publishes a
GitHub Release, and bumps a dedicated tap — **minimal interaction for versioning, a deliberate manual gate
before anything reaches users.**

Today there is no release path at all: `ci.yml` only lints/typechecks/tests/compile-smokes, `package.json`
is pinned at `0.0.0`, there are no tags, and nothing is published. Homebrew is the named primary install
channel in `build-operations.md` §3.

## Settled pillars (decided in the ticket, carried unchanged)

- **One release workflow**, `.github/workflows/release.yml` in `Twinning-Labs/styre`, **`workflow_dispatch`
  only**, with a `dry_run` toggle. No tag-push or schedule trigger — the human dispatch *is* the gate.
- **git-cliff is the single engine** for both the next semver and `CHANGELOG.md`, parsing Conventional
  Commits from the squash-merged `main` history.
- **Squash-merge-only** on `Twinning-Labs/styre` (already set) → `main` is a clean 1-PR-per-commit log, so
  the PR title *is* the commit + changelog line. Branch-level history is preserved on the PR page.
- **Org-owned GitHub App** (`styre-release-bot`) mints short-lived installation tokens at runtime for every
  push — never a PAT, never `GITHUB_TOKEN` for cross-repo writes. Installed on both `styre` and
  `homebrew-styre`. Pushes appear as `styre-release-bot[bot]`. No expiry rotation (see Risks).
- **Dedicated tap** `Twinning-Labs/homebrew-styre` holding `Formula/styre.rb`.
- **Ad-hoc codesign only** (no Developer-ID notarization) — Homebrew downloads via curl, so there is no
  Gatekeeper quarantine to clear.

## Decisions made this session

### D1 — Build topology: native-per-arch (4 runners), NOT 2-runner cross-compile

**This revises the ticket's original wording** (which described a 2-runner `bun build --target`
cross-compile). Chosen instead: a **4-job matrix, each slice built on its true architecture.**

| runner            | target        | codesign       | smoke              |
|-------------------|---------------|----------------|--------------------|
| `macos-15`        | darwin-arm64  | ad-hoc, native | `./styre --version`|
| `macos-15-intel`  | darwin-x64    | ad-hoc, native | `./styre --version`|
| `ubuntu-latest`   | linux-x64     | n/a            | `./styre --version`|
| `ubuntu-24.04-arm`| linux-arm64   | n/a            | `./styre --version`|

**Why:** with cross-compile, the linux-arm64 slice cannot be run on an x64 runner (no emulation by default),
so it would ship **without a real-architecture smoke test** — a broken arm64 binary would not surface until
a user's `brew install`. Native-per-arch builds *and runs* `styre --version` on every slice's true arch
before publish, and makes codesign trivial (each mac runner signs its own native binary). All four runner
labels are GA GitHub-hosted images. `bun:sqlite` is a Bun built-in embedded in the runtime by `--compile`,
so it ships correctly per-target (the existing CI compile-smoke already exercises `migrate` on linux-x64).

### D2 — Versioning scheme: standard semver, first release `v0.1.0`

A committed `cliff.toml`. With no prior tag, the first computed version is **`v0.1.0`**. Intended bumping:

| commit            | bump  | example          |
|-------------------|-------|------------------|
| `feat:`           | minor | `0.1.0 → 0.2.0`  |
| `fix:` / `chore:` | patch | `0.1.0 → 0.1.1`  |
| `BREAKING CHANGE:`| major | `0.1.0 → 1.0.0`  |

**⚠️ Non-default — must be configured explicitly.** git-cliff's default pre-1.0 behavior bumps a
`BREAKING CHANGE` to the *minor* (`0.1.0 → 0.2.0`), because `0.x` has no stable-API contract. The table above
(breaking → major even from `0.x`) is the operator's chosen behavior and **only takes effect if `cliff.toml`
is configured to force major bumps pre-1.0** (`bump.major_version_bump` / equivalent). The plan must pin this
in `cliff.toml`; do not assume the post-1.0 default applies. The `workflow_dispatch` + `dry_run` preview is
the human guard — a dry run prints the computed version (and the commit that drove the bump — see "Binding the preview") before
any real release.

### D3 — Changelog/version commit: direct fast-forward push to protected `main` by the bot

The release commits the bumped `package.json` + updated `CHANGELOG.md` **directly to `main`** as
`styre-release-bot[bot]`, via a **fast-forward-only push**. `main` branch protection allows the bot on a
**fast-forward-only bypass — force-push is denied** (revised this session; see D4). If `main` advanced since
the release's pinned SHA, the FF push is rejected and the release **aborts before publishing anything** (it
publishes nothing and the operator re-dispatches against the new HEAD).

**Rejected alternative:** a human-merged changelog *PR*. It fits the "operator merges everything" rule but
breaks the single-flow model — the release would have to tag before the changelog landed, or stall
mid-workflow. Direct FF push by an automated release identity keeps the release one flow; the bot only ever
writes the changelog/version commit, only from this workflow.

### D4 — Branch-protection bypass is fast-forward-only (force-push removed)

The bot's `main` bypass is **fast-forward push only; force-push is denied.** This is what makes the
compute→publish race (see Recovery below) a *loud abort* rather than a silent clobber of a just-merged human PR,
and it removes history-rewrite as a blast-radius if the App private key ever leaks. The workflow never needs
more than a fast-forward push.

Exact `main` protection config (classic branch-protection rules; **verified configured 2026-06-25**):

- **`styre-release-bot` is the sole actor on "Allow specified actors to bypass required pull requests"**
  (`required_pull_request_reviews.bypass_pull_request_allowances.apps`). This is load-bearing: without it the
  bot cannot push the `chore(release):` commit at all (direct pushes to `main` are otherwise PR-gated). No
  user or team is on the bypass list.
- **"Allow force pushes" disabled** (`allow_force_pushes.enabled = false`) — fast-forward-only for everyone,
  bot included.
- **"Require linear history" enabled** (`required_linear_history = true`) and **"Require a pull request before
  merging" enabled** — humans still go through PRs; only the bot bypasses, and only with a fast-forward.

### D5 — Release pinned to one immutable dispatch SHA

The entire release is pinned to a single commit SHA captured at dispatch (`SHA0`). git-cliff computes
against `SHA0`, all four builds build from `SHA0`, the bump+changelog commit is made on top of `SHA0`, and
the tag points at that pushed commit. Nothing in the flow references "`main` HEAD at push time." This closes
the race where commits landing between compute and publish would be silently absorbed into the release
without appearing in the changelog, and guarantees the tag represents exactly the source that was built.

## Release flow (exact ordering)

Let `SHA0` = the `main` HEAD captured at dispatch.

1. **Compute (pinned to `SHA0`).** Run git-cliff against `SHA0` → next version `vX` + changelog +
   release-notes snippet. If there is **nothing releasable since the last tag → clean no-op exit.**
2. **Per-effect idempotency probe (not a blanket version check).** Probe external state and record what
   already exists for `vX`: does tag `vX` exist? does Release `vX` exist with **all 4** assets? does the tap
   formula already carry **this build's** sha256s? A re-run applies only the missing effects (see Recovery) —
   it never blanket-exits merely because a tag exists.
3. **Build matrix (D1), all from `SHA0`.** Stamp `vX` into `package.json` in the working tree → fan out the
   4 jobs → each `bun build --compile`, codesign (mac), **run `styre --version` on its real arch**, then
   `tar.gz` the binary + emit `sha256`, upload as a workflow artifact. Artifact names follow the fixed
   template in Artifact naming below.
4. **Publish gate — only if all 4 build jobs succeeded** (the publish job `needs:` all four). Mint the App
   token(s) here, in the publish job (so the 1-hour token lifetime can't expire during the build matrix):
   1. Commit bumped `package.json` + updated `CHANGELOG.md` **on top of `SHA0`** as `chore(release): vX`
      (this type is in cliff's skip set — see `cliff.toml` below). **Fast-forward-push to `main`; if rejected because `main`
      advanced → abort the release, publish nothing, exit non-zero.** Then **tag the pushed commit** `vX`
      (probe first: skip if tag already present from a prior partial run).
   2. Create/repair the GitHub Release `vX` (notes from git-cliff) and upload any of the 4 tarballs +
      checksums **not already present** (probe-then-apply).
   3. Rewrite `homebrew-styre`'s `Formula/styre.rb` with the 4 new `url` + `sha256` and push (tap token) —
      **only if the formula doesn't already carry this build's sha256s.** Tap push is last (the user-facing
      last mile and the resumable final commit point). The tap-bump script treats url/sha256 as data, not
      shell-expanded strings.
5. **`dry_run=true`** runs steps 1 and 3 (compute + build + checksum all 4 slices) and **skips every write**
   — no commit, no tag, no Release, no tap push, and **no token minting** (nothing to authenticate). It
   prints the version, the changelog diff it *would* have produced, and **the commit(s) that drove each bump
   segment** — in particular any `BREAKING CHANGE:` source — and the pinned `SHA0`.

**Binding the preview to the run:** a dry run reports `SHA0` and `vX`. The real run accepts optional
`expected_sha` / `expected_version` inputs; if `main` moved or the computed version differs from what the
operator previewed, the real run **aborts** rather than silently shipping a different artifact than the one
eyeballed.

## Recovery / idempotency (the publish step is NOT atomic — make it resumable)

Step 4 performs three sequential, non-transactional side effects across two repos plus a Release. They are
made safe by **per-effect probe-then-apply** (the codebase's CL-3 invariant: idempotency key + probe
external state before applying), not by a coarse "tag exists → no-op" guard. Recovery for each partial state:

| partial state after a failed run         | re-run behavior                                                        |
|------------------------------------------|------------------------------------------------------------------------|
| FF push rejected (main advanced)         | nothing published; abort; re-dispatch picks new `SHA0`/recomputes `vX`  |
| commit pushed, tag/downstream failed     | compute detects `chore(release): vX` is HEAD → pins `SHA0` to its parent (`resuming`); publish probes `origin/main` and SKIPS the commit effect, then heals tag+Release+tap. Never re-commits (no "nothing to commit" abort, no duplicate commit). |
| commit+tag done, Release assets partial  | probe Release → upload only the missing tarballs/checksums              |
| commit+tag+Release done, tap push failed | tap shas read from the published Release assets; probe tap formula ≠ that → push the formula bump (heals it) |
| tag exists at HEAD (fully released)      | compute short-circuits to a clean no-op exit                            |

The key change from the original design: a re-run **never blanket-exits on "tag `vX` exists."** That would
have cemented the "tag exists but tap stale" state the ticket explicitly fears. The placeholder tap formula
(bootstrap below) is treated as a *resumable* state, not a terminal one.

## Components

### `release.yml` (in `Twinning-Labs/styre`)
- Trigger: `workflow_dispatch` with `dry_run` (bool) and optional `expected_sha` / `expected_version` inputs.
- Jobs: `compute` (capture `SHA0`, git-cliff, per-effect probe) → `build` (4-way matrix, all from `SHA0`) →
  `publish` (`needs: [compute, build]`, skipped when `dry_run`, mints tokens here).
- Token minting via `actions/create-github-app-token@v2`: one token scoped to `styre` authorizing **three
  operations — the FF commit, the tag, and Release creation/asset upload** (all `Contents:write`); one token
  scoped to `homebrew-styre` for the tap bump. Both minted in the publish job.
- **All third-party actions pinned to a full commit SHA** (not `@v2`) — they run while the App token is in
  scope, so a mutable-tag compromise would be code-execution against protected `main`.
- Document the authorized dispatcher set; today single-operator, but any write-access contributor can
  `workflow_dispatch` — revisit a `github.actor` allowlist guard when contributors are added.
- `ACTIONS_STEP_DEBUG` must not be enabled on this workflow (token hygiene).

### `cliff.toml` (in `Twinning-Labs/styre`)
- Conventional-commit parsers; `CHANGELOG.md` body template; release-notes template for the Release body.
- **Pin pre-1.0 major-bump behavior** to match D2 (breaking → major even from `0.x`).
- **Skip rule for `chore(release):`** so the bot's own release commit never contributes to the next bump.
- First-release range: seed an explicit baseline (e.g. a `v0.0.0` tag on a baseline commit, or a tag-pattern)
  so the first changelog over pre-lint history is intentional, not "all history, best effort." Pre-lint and
  bot commits are unvalidated input to cliff — the first changelog is curated against the baseline.

### `build.sh` (existing, generalized)
- Today: `bun build --compile ./src/index.ts --outfile dist/styre` + ad-hoc `codesign` on Darwin.
- Change: parameterize target + outfile so the matrix can drive it per slice; keep the Darwin ad-hoc
  codesign branch (needed for the binary to run on Apple Silicon — exit-137 fix).

### `ci.yml` (existing, one job added)
- Add a **PR-title-only** job using `amannn/action-semantic-pull-request` (SHA-pinned), on `pull_request`
  events, enforcing Conventional Commits on the PR title — squash makes the PR title the commit + changelog
  line. **Note:** this guards human PRs only; the bot's direct-to-main `chore(release):` commit is not lint-
  checked (it is constructed by the workflow, so its format is controlled there).
- Existing lint/typecheck/test/compile-smoke job is unchanged.

### `Twinning-Labs/homebrew-styre` (new repo)
- `Formula/styre.rb`: `on_macos`/`on_linux` × arm64/x64 → four `url` + `sha256` pairs, `bin.install
  "styre"`, `test do` running `styre --version`. Include `license`, `desc`, `homepage`, `version` stanzas up
  front so `brew audit --strict` passes (style nits otherwise fail the hard AC gate).
- **Bootstrap:** the repo starts with an **explicitly non-installable placeholder formula** (fails with a
  clear "no release yet" error, not a silent half-install); the first real release's tap-bump step fills in
  real urls + shas. A first release that tags/Releases but fails the tap push leaves the placeholder — which
  the per-effect guard treats as resumable (re-run heals it).

### Artifact naming (single source of truth)
- Fixed filename template, e.g. `styre-vX-<os>-<arch>.tar.gz` + `.sha256`, defined once and referenced by
  both the build step and the formula generator. This is a real (open-core-adjacent) contract: renaming the
  artifact 404s every existing formula `url`.

### Repo settings (not code)
- `Twinning-Labs/styre` squash default commit message = **"Pull Request Title and Description"**.
- `main` branch protection (verified 2026-06-25): `styre-release-bot` is the **sole PR-bypass actor**,
  **force-push disabled**, **linear history required** (full config in D4).
- Secrets on `styre`: `STYRE_RELEASE_APP_ID`, `STYRE_RELEASE_APP_PRIVATE_KEY`.

## Post-release verification

A smoke job (after publish, after all Release assets are uploaded so `--online` audit can resolve every
`url`): `brew tap twinning-labs/styre` + `brew install` + `styre --version` on **macOS-arm64, macOS-x64,
Linux-x64, and Linux-arm64** (all four, so every formula branch's url/sha selection is exercised, not just
the binary — closing the same gap D1 exists to close), plus `brew audit --strict --online styre`. If
`--online` proves flaky on asset-upload timing, gate on `brew audit --strict` and treat `--online` as
advisory.

## Out of scope (separate specs)

- `curl | sh` installer, OCI/container image, GitHub Action wrapper.
- Developer-ID **notarization** (ad-hoc signing is sufficient for curl-downloaded Homebrew artifacts).
- musl/static Linux builds; homebrew-core submission.
- Any change to `styre setup` launchd/systemd service install — Homebrew only puts `styre` on PATH.

## Risks / standing assumptions

- **App private key has no rotation** (settled pillar). A leaked or expired key silently breaks all releases;
  FF-only bypass (D4) caps the leak blast-radius to "can publish a release," not "can rewrite history."
- **Runner-label longevity:** GitHub periodically retires macOS images — `macos-13` was retired and the labels
  moved to `macos-15` (arm64) + `macos-15-intel` (free x64 successor) on 2026-06-25. Labels are pinned (not
  `-latest`) per GitHub's recommendation; re-pin to the then-current versions when GitHub retires these.

## Acceptance criteria (from ENG-222)

- [x] `Twinning-Labs/styre` merge strategy is squash-only.
- [ ] Squash default commit message is set to "Pull Request Title and Description".
- [ ] `ci.yml` has a PR-title lint check enforcing Conventional Commits on PR titles.
- [ ] `Twinning-Labs/homebrew-styre` exists with a working `Formula/styre.rb` covering darwin-arm64, darwin-x64, linux-x64, linux-arm64.
- [ ] `release.yml` runs on manual trigger only, auto-computes the version via git-cliff, and requires no manual version entry.
- [ ] git-cliff generates/updates `CHANGELOG.md` and FF-commits it back to `main` on release using the GitHub App token; `main` branch protection allows the bot to fast-forward push (force-push denied).
- [ ] Tap push authenticates via the org GitHub App installation token scoped to `homebrew-styre` (no PAT).
- [ ] A `dry_run` run computes version + changelog and builds + checksums all 4 targets, publishing nothing and committing nothing.
- [ ] A real run produces a GitHub Release (notes from git-cliff) with 4 signed/checksummed tarballs and bumps the tap formula in one flow; partial-arch failure publishes nothing; post-gate partial failure is resumable to a consistent state.
- [ ] Version embedded in the released binary (`styre --version`) matches the release tag (no `0.0.0`).
- [ ] `brew install twinning-labs/styre` succeeds and `styre --version` runs on all four targets; `brew audit --strict` passes.
- [ ] Re-running a release is per-effect idempotent: it heals missing effects and is a genuine no-op only when tag + all Release assets + tap formula already match this build.

## Deviations from the ticket to fold back into ENG-222

1. **Build topology** → native-per-arch (4 runners), not 2-runner cross-compile (D1).
2. **Branch-protection bypass** → fast-forward-only; force-push removed (D4). (The ticket said "allow the App
   to push"; tighten to FF-only.)
3. **Idempotency** → per-effect probe-then-apply, not a per-version blanket no-op; partial-failure recovery
   table added. (The ticket's "guarded no-op" AC is refined: a re-run *heals* missing effects.)
4. **git-cliff pre-1.0 config** → breaking-→-major is non-default and must be pinned in `cliff.toml` (D2).
5. **Release pinned to an immutable dispatch SHA**; `dry_run` preview optionally binding via `expected_sha`
   (D5 + Binding the preview).
6. Post-release `brew install` smoke covers all four targets (was two).

## Review findings incorporated (independent feasibility + security + adversarial pass, 2026-06-25)

- **Adversarial Blocker 1** (per-version guard cements partial failures) → per-effect probe-then-apply +
  recovery table.
- **Adversarial Blocker 2** (compute→publish race + force-push clobber) → immutable `SHA0` pin (D5), FF-only
  abort-on-race (D4), tag the pushed commit.
- **Feasibility** (git-cliff pre-1.0 semantics; SHA-pin the flow; `brew audit` stanzas + asset ordering;
  2-of-4 formula branches untested) → D2 config note, D5, formula stanzas + audit ordering, 4-target smoke.
- **Security** (force-push excess; SHA-pin actions; enumerate token's 3 ops + mint in publish job; dispatcher
  set; log hygiene; quote sha256 in tap script) → D4, action SHA-pinning, token notes, dispatcher note.

## Open follow-ups (not blocking this spec)

- Exact `cliff.toml` commit-type → changelog-section mapping is an implementation detail for the plan.
- A `github.actor` dispatcher allowlist is deferred until contributors with write access exist.

## Refs

- `docs/architecture/build-operations.md` §3 (distribution intent), §5 (open-core seam)
- `scripts/build.sh` (existing `bun build --compile` + ad-hoc codesign)
- `.github/workflows/ci.yml` (existing lint/typecheck/test/compile-smoke)
- `src/version.ts`, `package.json` (version source of truth)
- git-cliff — https://git-cliff.org
- `actions/create-github-app-token` — runtime App installation token
- `amannn/action-semantic-pull-request` — PR-title Conventional Commits lint
- CLAUDE.md CL-3 invariant — idempotency key + probe external state before applying
