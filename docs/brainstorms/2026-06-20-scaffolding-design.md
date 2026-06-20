# Scaffolding Design — Styre TS substrate

> The greenfield scaffolding for the Styre execution core: **file layout, package choices, and
> build sequence** to take the frozen design (`docs/architecture/`) into a buildable TypeScript +
> embedded-SQLite single binary. This is the bridge from "design frozen, no code" to the first
> end-to-end `design → released` run (the cutover acceptance run, minimal-loop §6).
>
> Grounds every decision in the architecture docs; cites them inline. Status: approved 2026-06-20.
> Next: a milestone-by-milestone implementation plan in `docs/plans/` (writing-plans skill).

---

## 1. Decisions settled in this pass

| # | Decision | Rationale | Source |
|---|---|---|---|
| SC-1 | **Runtime + build toolchain = Bun.** `bun build --compile` for the single binary. | True single self-contained binary; native cross-compile to macOS/Linux × arm64/x64 + a static (musl) container build; built-in SQLite/test/TS — best fit for the single-binary + static + zero-ops constraints. Tradeoff: bundled runtime is Bun, not Node (functionally equivalent here). | CLAUDE.md "single self-contained binary"; build-operations §3, §3.1 |
| SC-2 | **SQLite driver = `bun:sqlite`** (built-in, synchronous). | Single-writer daemon (B2) wants synchronous access; no native-addon bundling pain. | control-loop §2.1; schema.sql invariants |
| SC-3 | **Validation = `zod`.** | The validated-interface layer is the load-bearing reliability rule. | control-loop §3a / CL-INV-4 |
| SC-4 | **Build order = walking-skeleton-first** (M1 durable core → M2 mocked end-to-end spine → deepen each step). | De-risks the novel durable-execution core (journal/replay/recover) end-to-end early; gives a runnable acceptance-run target from day one. | minimal-loop §6; control-loop §6 |
| SC-5 | **Single package; the open-core seam is an isolated `src/contracts/` module, not a workspace/published package.** | The commercial plane integrates via *artifacts* (Linear ticket contract, `profile.md`, NDJSON stdout) from a separate repo — it never imports Styre's TS. A published package buys nothing now; an isolated, versioned module honors YAGNI while staying fork-proof. | build-operations §2, §5; CLAUDE.md "clean plug-in target, never get forked" |
| SC-6 | **No Anthropic SDK at cutover.** Structured output uses the `claude -p` leaf + content-body sidecar + zod. | The forced-schema SDK path is increment I-A, post-cutover; the sidecar disambiguation holds at cutover. | minimal-loop §3; control-loop §3a |
| SC-7 | **Seam frozen at M7, not built first.** A minimal `ticket-contract` parser appears early (M2/M3 to feed input); the seam is versioned/locked at M7 once its producer (engine telemetry/profile data) exists. | Operator chose walking-skeleton-first over seam-first; avoids contracts going brittle from later-stage changes. Operator is ambivalent on the timing and accepted this. | build-operations §7 (seam = "first build priority") reconciled with SC-4 |

Lighter follow-on choices derived from the above (not separately gated): test runner = `bun test`;
lint/format = Biome (one fast binary); CLI parser = `citty` (fallback: Bun `util.parseArgs`);
subprocesses = `Bun.spawn`.

---

## 2. Module / file layout

A single Bun package. `src/` mirrors the architecture docs so each doc maps to a directory; the
open-core seam is quarantined in `src/contracts/` (SC-5).

```
styre/
  package.json  tsconfig.json  biome.json  bunfig.toml
  README.md                      # links docs/design/ per the docs convention
  Dockerfile                     # slim image over the static (musl) linux binary
  .github/workflows/             # ci.yml, release.yml
  prompts/                       # ported AGENT_PROMPTS.md assets (first-class, not vendored)
  docs/                          # architecture/ (existing), design/, brainstorms/, plans/
  src/
    index.ts                     # binary entry: argv → CLI command
    cli/                         # setup · daemon · run · status · inbox · config · pause · logs · uninstall
    daemon/
      loop.ts                    # event loop §2.2 (drain → poll → pick ready → spawn, K=2)
      resolver.ts                # next_step_key + advance_one_step (minimal-loop §1)
      recover.ts                 # crash recovery §6.1 (orphan-kill, reset/probe)
      failure-policy.ts          # Loopback Atlas §8 + per-route resets (minimal-loop §2)
      budgets.ts                 # K_DISTINCT / B2 / B3, failure signatures, counters (§4, §8.2)
    engine/
      step-journal.ts            # workflow_step upsert, replay, effectful write-ahead §3
      signals.ts                 # durable signals: insert/await/deliver/consume §7
      idempotency.ts             # dispatch_id-prefixed keys + probe helpers (CL-3)
    steps/
      registry.ts                # step_key → {guard, run, postcondition, tools, model}
      design.ts implement.ts verify.ts docs.ts review.ts merge.ts released.ts
      contract.ts                # pure vs effectful step types (Guard/Input/Output/postcond)
    db/
      schema.sql                 # the SoT DDL (ported from docs/architecture/schema.sql)
      migrate.ts  migrations/    # self-bootstrap §10, schema_meta-versioned
      client.ts                  # open + PRAGMAs (WAL/foreign_keys/busy_timeout); single-writer
      repos/                     # typed DAO per table (ticket, work_unit, workflow_step, signal, …)
    dispatch/
      dispatch.ts                # spawn `claude -p --allowed-tools … --model …` w/ timeout, journal pid
      render-prompt.ts           # ported leaf + CL-PROFILE completeness gate
      tool-allowlists.ts models.ts worktree.ts sidecar.ts   # capability isolation, CL-COMMIT, §3a sidecar
    verify/
      ground-truth.ts            # run profile commands → ground_truth_signal (S3/S4)
      checks-system.ts           # generic translator (CL-CHECKS): github + none now
      scope-diff.ts              # ported leaf, advisory (A3)
    review/findings.ts           # review_finding + daemon-derived blocks_ship (critical-floor)
    projector/
      enqueue.ts drain.ts        # write-half (delta vs projection_state) / read-half §4
      adapters/linear.ts adapters/github.ts  linear-id-cache.ts
    contracts/                   # ── THE OPEN-CORE SEAM (§5): stable, versioned, isolated ──
      ticket-contract.ts         # styre_config + AC checklist + context-files + trigger (zod)
      profile.ts                 # project-profile artifact schema + load/validate
      telemetry.ts               # NDJSON stdout stream + per-ticket summary
    config/                      # config.ts (4-tier precedence) · defaults.ts · paths.ts (XDG)
    service/install.ts           # render launchd plist / systemd unit from one daemon def
    schema/                      # shared zod schemas (work-unit extract, finding, …)
    util/                        # time.ts (UTC store / local render, DS-1) · exec.ts · ids.ts · log.ts
```

**Conventions:**
- Tests colocated (`*.test.ts`) for units; `test/` for integration runs.
- The `docs/plans/` an *agent* writes at runtime (step S1a output) lives in the **target repo**, not
  Styre's own repo — no conflict with Styre's own dev docs convention.
- `src/contracts/` is the only module the commercial plane's artifact contracts depend on; changes
  there are treated as public-API changes (versioned).

**Invariant→module map** (where the load-bearing rules live, so they can't be violated by accident):
- Single-writer SoT (B2 / CL-INV-7) → `db/client.ts` (the only write surface) + `engine/*`.
- One-way projection (move 2 / CL-INV-6) → `projector/*`; nothing else holds outward creds.
- Exactly-once + replay (B3 / CL-INV-2/3/5) → `engine/step-journal.ts` + `engine/idempotency.ts`.
- Capability isolation (move 4) → `dispatch/tool-allowlists.ts` + `dispatch/worktree.ts`.
- Validated interface (§3a / CL-INV-4) → `schema/*` (zod) + `dispatch/sidecar.ts`.
- Clean-break stage vocab (DS-2) → `daemon/resolver.ts` (the only place stages transition).
- UTC store / local render (DS-1 / CL-INV-8) → `util/time.ts`, applied only at the CLI render edge.

---

## 3. Package choices

**Runtime deps — deliberately tiny** (Bun supplies the rest):
- `zod` — validated-interface layer (§3a / CL-INV-4). Mandatory.
- `citty` — lightweight subcommand parser for the multi-command binary (fallback: Bun's built-in
  `util.parseArgs`, zero-dep).
- SQLite = `bun:sqlite` (built-in). Subprocesses = `Bun.spawn` (built-in). No deps for either.

**Dev deps:** `typescript`, `@types/bun`, `@biomejs/biome` (lint+format in one fast binary).

**Test:** `bun test` (built-in) — replay/recover unit tests + integration runs.

**Build / release:**
- `bun build --compile --target=bun-{darwin,linux}-{arm64,x64}` → per-platform binaries;
  `bun-linux-x64-musl` for the static container build.
- `Dockerfile` copies the musl binary into a slim base (the fleet/CI artifact, build-operations §3.2).
- GitHub Action wraps the binary; Homebrew tap + `curl|sh` script as release placeholders.
- CI matrix: `bun install` → `biome check` → `bun test` → `bun build` compile-smoke per target.

**Host contract (runtime, not bundled):** `git`, `gh`, the `claude` CLI (control-loop §10).

---

## 4. Build sequence (walking-skeleton first, SC-4)

Front-loads the novel durable core; the seam is built once the engine produces the data that shapes
it (SC-7).

| Milestone | Delivers | Proves / acceptance |
|---|---|---|
| **M0 Skeleton** | package/tsconfig/biome/bunfig, dir tree, CI, `styre --version`, `styre migrate` (DB from `schema.sql`) | repo builds + compiles to a binary; DB loads clean |
| **M1 Durable core** ⭐ | `db/client`+`migrate`+`repos`, `engine/step-journal` (replay + write-ahead), `signals`, `idempotency`, `recover()` | control-loop §6: a succeeded step returns its recorded result on replay; a `running` step recovers (orphan-kill + reset/probe) |
| **M2 Resolver + loop** ⭐ | `next_step_key`, `advance_one_step`, `loop()` (K=2), `failure-policy`/atlas shape — **with mocked step handlers** | **walking skeleton**: one fast-track ticket `design → released` end-to-end, all dispatch/verify/projector mocked; crash-resume mid-run |
| **M3 Dispatch real** | worktree, render-prompt (CL-PROFILE), allowlists, models, `claude -p` spawn+pid, sidecar zod | `design:dispatch` + `implement:dispatch` produce real committed diffs (CL-COMMIT); postconditions enforced |
| **M4 Verify real** | ground-truth runner, checks-system (github/none), scope-diff (S3/S4) | ground-truth gates fire on real profile commands; behavioral-test gate (A1) |
| **M5 Review real** | `review/findings` + daemon-derived verdict (blocks_ship, critical-floor); `design:extract`/`design:review` via sidecar | blocking-finding loopbacks route per §8 (V1/V3); plan-review (S1c) gates full-track |
| **M6 Projector real** | `enqueue` (delta vs projection_state) + `drain` + linear/github adapters + id-cache; merge steps S6–S10 | one-way projection (move 2); idempotent push/pr-ensure/await/merge spine (CL-3) |
| **M7 Seam + telemetry** | `contracts/` (ticket-contract, profile, telemetry NDJSON) frozen, 4-tier config, per-ticket summary | the §5 public API locked once real data exists (SC-7); telemetry = structured stdout stream |
| **M8 Install/ops** | `setup` (probe/migrate/seed/id-cache/service install), launchd/systemd unit rendering, mgmt CLI (status/inbox/config/pause/resume/logs/uninstall), `run` ephemeral-DB mode | GOAL-INSTALL: one-command bring-up on macOS + Linux |
| **M9 Packaging** | cross-compile matrix, container (musl), GitHub Action, brew tap, `curl\|sh`, release workflow | all distribution targets (build-operations §3.1) |

⭐ M1–M2 are the spine; M3–M9 deepen each step from mock → real, one subsystem at a time.

**Cutover acceptance run** (the north star, minimal-loop §6): a clean fast-track backend ticket
flows `design:dispatch → design:extract → implement → verify → verify:integration → review →
merge:push → pr-ensure → await-checks → await-human → released`, every step journaled, every
transition mirrored by the projector, a crash at any point resuming from the journal. The walking
skeleton (M2) runs this with mocks; M3–M6 turn each leg real; M7–M9 make it installable and
shippable.

---

## 5. Out of scope (explicitly deferred)

- **The autonomy layer** — supervisor, memory/RAG, the Unified Gate Layer, learning loop
  (brainstorm §5/§5.8). Post-cutover increments I-C/I-D. The `§X DEFERRED` schema tables stay
  commented; no module is scaffolded for them.
- **Forced-schema structured output** (increment I-A) — cutover uses the sidecar (SC-6).
- **`human_plan_approval` gate** — schema-defined but not wired (minimal-loop §7).
- **Auto-merge / `pr_merge` projection** — the human merges at cutover (projector §3).
- **`.deb`/`.rpm`, a programmatic REST/IPC API** — later additions (build-operations §3; §5 item 4).
