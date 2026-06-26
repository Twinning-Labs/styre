# OSS-Boundary Documentation Consistency Pass — Plan

> **For agentic workers:** execute task-by-task. Every task MUST follow the **Terminology Mapping** and **Boundary Model** below verbatim — consistency across files is the whole point.

**Goal:** Make the Styre repo's documentation internally consistent for the **OSS core only**. Today the docs narrate a pre-boundary world where a persistent "daemon" is the protagonist; the shipped binary (`run`/`setup`/`migrate`, no `daemon`) reflects the *later* open-core boundary decision (daemon = commercial). This pass aligns every doc to the code + boundary. Also fixes the three operator-reported gaps: missing brew install, daemon pervasion, incomplete Develop section.

**Branch:** `feat/docs-front-door` (continues PR #38 — these are corrections to that PR's docs).

## Boundary Model (the frame every task applies)

Two repos, one seam:
- **`Twinning-Labs/styre`** (this repo, GPLv3) — the OSS execution **core**. `styre run <ticket>` drives **one** ticket through a deterministic control loop and **exits at PR-ready**. Ephemeral (fresh per-run temp DB by default). Plus `styre setup` (writes the project profile) and `styre migrate` (bootstraps the SoT). Emits NDJSON telemetry to **stdout**.
- **`Twinning-Labs/control-plane`** (future, private, **not yet created**) — the commercial SaaS. A **persistent daemon** that orchestrates *many* `styre run` invocations: multi-ticket pickup, dependency-aware scheduling, K-concurrency, the **needs-you inbox**, dashboards. Integrates ONLY through the versioned **seam** (Linear ticket contract, project-profile artifact, NDJSON telemetry/state export). It **never forks or imports** the core; the core has **zero** knowledge of it.

**The control loop has an inner and an outer layer:**
- **Inner, per-ticket loop** (resolve `next_step_key` → dispatch → persist → project → loopback, drive one ticket to PR-ready) = **OSS core**, run by `styre run`.
- **Outer, multi-ticket loop** (poll for ready tickets, K-concurrency, persistent supervision, inbox) = **commercial plane**.

## Terminology Mapping (apply in EVERY task)

| Old (wrong for OSS) | New (OSS) |
|---|---|
| "the daemon" as single-writer/engine/orchestrator role | **"the runner"** / **"`styre run`"** / "the run process" |
| "only the daemon writes SQLite" | "only the runner writes SQLite" |
| ASCII diagram box `daemon` | `styre run (single writer)` |
| "a single TypeScript daemon" | "a single-process control loop" / "the runner" |
| "restart the daemon" (crash-resume) | "`styre run --resume`" |
| "the daemon picks up a ticket" | "`styre run` drives one ticket" |
| "the daemon continues advancing tickets" (plural) | "the runner advances the ticket" (singular) |
| `styre daemon` (command) | **does not exist in OSS — remove** (it's the commercial plane's runtime) |
| `styre setup` "installs the host service (launchd/systemd)" | `styre setup` "probes the repo and writes the project profile (`profile.json`)" |
| "K (concurrency cap)" / `max_concurrent_features` | **commercial-plane concept** — fence as "(commercial Control Plane)" or remove from OSS narrative |
| "needs-you inbox", `styre inbox`, `styre resume`, `styre abandon`, `--after-fix` | **commercial-plane** — in OSS, an escalation exits nonzero; a session-interruption **parks (exit 75)** and resumes with **`styre run --resume`** |
| management CLI: `inbox`/`pause`/`resume`/`uninstall` | commercial-plane |

**Rule:** the `src/daemon/` directory name stays (it's the real module — the control-loop engine); a codemap may list it, but annotate it as "the control-loop engine" — never imply the OSS binary *is* a daemon or has a `styre daemon` command.

**OSS resume/park ground truth** (verified vs `src/cli/run.ts`, `src/cli/park.ts`): `styre run --resume <ident> --profile <p>` (+ `--accept-head`, `--inspect`); park sets exit code **75**. SECURITY.md is the correct terminology template — it already uses "the runner."

## Verbatim content blocks (transcribe these where a task says to)

**README — new `## Install` section:**
```markdown
## Install

Styre ships as a single self-contained binary via Homebrew (macOS & Linux):

```sh
brew install twinning-labs/styre
```

Upgrade with `brew upgrade styre`; remove with `brew uninstall styre` (and `brew untap twinning-labs/styre` to drop the tap). Prebuilt binaries for macOS (arm64/x64) and Linux (arm64/x64) are also attached to each [GitHub Release](https://github.com/Twinning-Labs/styre/releases).
```

**README — corrected `## Develop` section:**
```markdown
## Develop

Prerequisites: [Bun](https://bun.sh). On macOS you also need the Xcode Command Line Tools (`xcode-select --install`) — the build re-signs the compiled binary with `codesign`, without which macOS (Apple Silicon) kills it on launch.

```sh
git clone https://github.com/Twinning-Labs/styre.git
cd styre
bun install
bun test
bun run lint
bun run build         # → dist/styre (single self-contained binary)
./dist/styre --version
./dist/styre migrate  # bootstraps the SQLite SoT under $XDG_STATE_HOME/styre/
```
```

**README — `## How the commercial plane fits` (the one place daemon/inbox/scheduling appear):**
```markdown
## How the commercial plane fits

Styre's core is free, open source, and ends at PR-ready. A commercial **Control Plane** (a separate product in its own repository — not yet public) runs *on top of* this core: a persistent service that orchestrates many `styre run` invocations with multi-ticket scheduling, dependency-aware ticket selection, a needs-you inbox, and dashboards. It plugs in only through Styre's versioned seam — the Linear ticket contract, the project-profile artifact, and the NDJSON telemetry/state export — and never forks or imports the core. The core has no knowledge of the plane; you can run the OSS core on its own, forever.
```

---

## Tasks

### Task A — README.md (Install + Develop + daemon reframe + seam paragraph)
**Files:** Modify `README.md`.
- Add the `## Install` block (verbatim above), placed before the `## Develop` / commands area and after the qualification section.
- Replace the `## Develop` block with the corrected version (verbatim above) — adds `git clone` + macOS Xcode-CLT/codesign prereq.
- ASCII diagram: relabel the `daemon (single writer / SQLite SoT)` box → `styre run (single writer / SQLite SoT)`; the `results returned to daemon` arrow → `results returned to the runner`.
- Prose: the "The daemon — running in your terminal or as a local service — holds credentials, commits…" sentence → reframe around the runner (`styre run` holds creds, commits, is the sole writer). No "daemon" as the OSS protagonist.
- Consolidate ALL commercial mentions (continuous pickup, scheduling, inbox, persistent daemon) into the single `## How the commercial plane fits` section (verbatim above). Remove daemon/inbox from elsewhere.
- Commands section: OSS surface only — `styre setup`, `styre run`, `styre migrate` (+ `styre run --resume`). No `styre daemon`.
**Verify:** `grep -niE 'styre daemon|the daemon|daemon \(single' README.md` → only acceptable hits are inside `## How the commercial plane fits` (the word "daemon" describing the plane). No `daemon` in the diagram, the trust prose, or commands. `grep -n 'brew install twinning-labs/styre' README.md` and `grep -n 'git clone' README.md` → match.

### Task B — docs/architecture/README.md (architecture index)
**Files:** Modify `docs/architecture/README.md`.
- L5 "single TypeScript daemon driving a local SQLite journal…" → "a single-process control loop (`styre run`) driving a local SQLite journal…".
- Reading-order blurb for control-loop.md: "the daemon, the event loop" → "the control loop, the per-ticket event loop".
- Single-writer invariants (L45, L64): "the daemon" → "the runner".
- Codemap dir list (L72): keep `daemon` in the list but annotate, e.g. "`daemon` (the control-loop engine)".
- Add a one-line pointer to the README's "How the commercial plane fits" for anything multi-ticket/persistent.
**Verify:** `grep -niE 'the daemon|single typescript daemon' docs/architecture/README.md` → none except the annotated codemap dir name. Vocab guard (no gerund/ui-stage) clean.

### Task C — docs/architecture/glossary.md
**Files:** Modify `docs/architecture/glossary.md`.
- Single-writer "daemon" entries (SoT, projector, signal, work_unit) → "the runner".
- `### K (concurrency cap)` → rewrite as a **commercial-plane** term: prefix the definition "*(Commercial Control Plane.)* …" OR remove it. Recommended: keep but clearly fence as commercial, since OSS `run` is single-ticket.
- `### needs-you inbox` → rewrite as commercial-plane; add that the OSS equivalent for a session-interruption is parking (exit 75) + `styre run --resume`; `styre inbox`/`abandon` are commercial.
- Preserve alphabetical order + `### heading` anchors (so execution-model deep-links keep resolving).
**Verify:** `grep -niE 'the daemon' docs/architecture/glossary.md` → none. K and needs-you-inbox entries explicitly marked commercial. Heading anchors for the 8 linked terms still present.

### Task D — docs/architecture/execution-model.md
**Files:** Modify `docs/architecture/execution-model.md`.
- All single-writer/engine "daemon" → "the runner".
- "When the daemon picks up a ticket" → "When `styre run` starts on a ticket"; "restart the daemon" → "`styre run --resume`"; "the daemon continues advancing tickets" → "the runner keeps advancing the ticket".
- Rewrite the **needs-you inbox** section (L168–177) for OSS reality: in run-only mode, an escalation the loop can't resolve makes the run **exit nonzero**; a session-interruption (credits/limit) **parks (exit 75)** and resumes with **`styre run --resume <ticket> --profile <p>`** (`--accept-head`/`--inspect` available). Note the persistent needs-you inbox + `styre inbox`/`abandon` are the **commercial plane**. Remove `styre resume`/`styre abandon`/`--after-fix` as OSS commands.
**Verify:** `grep -niE 'the daemon|styre inbox|styre abandon|styre resume |--after-fix' docs/architecture/execution-model.md` → none (commercial inbox only referenced as commercial). `grep -n 'styre run --resume' docs/architecture/execution-model.md` → match.

### Task E — CONTRIBUTING.md + CLAUDE.md
**Files:** Modify `CONTRIBUTING.md`, `CLAUDE.md`.
- CONTRIBUTING.md L23 "Only the daemon writes SQLite" → "Only the runner (`styre run`) writes SQLite".
- CLAUDE.md: single-writer "daemon"/"daemon persists"/"daemon holds creds and commits"/"daemon computes decisions" → "runner". "Concurrency cap K=2" → fence as commercial-plane. "Intended commands": drop `styre daemon` (or mark commercial); fix `styre setup` to "probe + write profile" (not migrate-DB/host-service); the management CLI (`inbox`/`pause`/`resume`/`uninstall`) → mark commercial-plane. Keep `styre run`/`styre setup`/`styre migrate` as the OSS surface.
**Verify:** `grep -niE 'styre daemon|only the daemon|the daemon (holds|persists|computes)' CLAUDE.md CONTRIBUTING.md` → none as OSS claims. `bun test` still green (no code touched).

### Task F — docs/architecture/build-operations.md (run modes + seam)
**Files:** Modify `docs/architecture/build-operations.md`.
- §3 run modes: OSS = `run`/`setup`/`migrate`; move `daemon` (persistent, launchd/systemd-supervised, K-concurrency) under a clearly-labeled **commercial Control Plane** subsection. Fix "Primary mode | daemon | daemon | run" table and "daemon = the OSS solo/local model" (L187/205) — the OSS model is `styre run` (ephemeral); the persistent daemon is the plane.
- L200 "three run modes (setup / daemon / run)" → note this 2026-06-20 decision was superseded by the OSS boundary (OSS = setup/run/migrate; daemon = commercial).
- Keep/strengthen §5 (the seam) — it's the public contract; frame it as the OSS↔plane integration boundary.
**Verify:** `grep -niE 'styre daemon' docs/architecture/build-operations.md` → only inside the commercial-plane subsection. The run-modes table shows OSS = run/setup/migrate.

### Task G — control-loop.md + minimal-loop.md + projector.md (frozen deep spec, reframe OSS-only)
**Files:** Modify `docs/architecture/control-loop.md`, `docs/architecture/minimal-loop.md`, `docs/architecture/projector.md`.
- Add a top banner to each: "This describes the per-ticket control loop that **`styre run`** executes (the OSS core). The multi-ticket outer loop (pickup, K-concurrency, persistent supervision, the needs-you inbox) is the **commercial Control Plane** and is fenced as such below."
- Single-writer/engine "daemon" → "the runner". Preserve decision-ID tags (B1/B2/CL-*), invariants, and technical accuracy.
- Fence the **outer-loop** content as commercial: the `while true: poll ready tickets / if inflight >= K: break` event loop, K/`max_concurrent_features`, the persistent host-service supervision, the needs-you inbox. Do NOT delete (these are the design record) — clearly mark them "(commercial Control Plane)".
- This is delicate: keep each doc coherent. If a reframe would break coherence, prefer fencing + a banner over deletion, and note it for review.
**Verify:** each file opens with the banner; `grep -niE 'the daemon' <file>` → none as the OSS single-writer (now "the runner"); K/inbox/persistent-supervision passages are commercial-fenced. No decision-ID tags lost.

### Task H — brainstorm.md changelog note (append-only)
**Files:** Modify `docs/architecture/brainstorm.md` (APPEND ONLY — never edit existing lines).
- Add a new entry to the §11 changelog (2026-06-26): record that the OSS/commercial boundary supersedes the pre-boundary "three run modes setup/daemon/run" and "daemon = OSS solo/local model" framing; the OSS core is `run`/`setup`/`migrate` and the persistent daemon is the commercial plane; note the schema is 14 active tables + 1 deferred `memory_record` stub (the earlier "16 tables" §12 count is stale). Point to this plan + the reframed docs.
**Verify:** only an addition at the changelog section; `git diff` shows no edits to pre-existing brainstorm lines.

---

## Final consistency review
After all tasks: one whole-set Opus review checking the Terminology Mapping is applied uniformly, the boundary is consistent across every doc, "daemon" appears ONLY as the commercial plane (or the annotated `src/daemon/` dir name / fenced frozen-spec outer loop), brew + Develop fixes are correct, and execution-model's glossary anchors still resolve.
