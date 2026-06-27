# PostHog Analytics for the Styre OSS CLI — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorm). Next: implementation plan.
**Scope:** Add anonymized product analytics to the open-source `styre` binary, sending a small,
curated set of events to a paid PostHog (US Cloud) project.

---

## 1. Goal & audience

Understand **OSS adoption in the wild** — who installs the binary and how they use it. The five
metrics the operator asked for, plus a product-analytics layer on top.

This is an **adoption** question, not an ops question, which forces two foundational decisions:

- **The binary itself phones home** (anonymized, opt-out). Server-side aggregation of the existing
  NDJSON stream would only see runs we orchestrate — not external users.
- **We do *not* forward the NDJSON stream.** That stream is a per-dispatch firehose carrying
  repo-identifying detail and is the open-core seam for the commercial plane. Analytics is a
  separate, curated, edge-level concern.

### Non-goals (explicitly out)

- **No cost or token data**, not even bucketed — a user's API spend is their concern.
- **No PII / proprietary / identifying data**: raw ticket idents (`ENG-5`), repo paths, commands,
  branch SHAs, failure signatures, raw escalation text — never on the wire.
- **No fleet/CI identity provisioning** (no `STYRE_ANON_ID`, no env-injected IDs). The OSS product
  does not support fleet operations; a forker can add it if they need it.
- **No new behavior in the engine/daemon.** Analytics lives at the CLI edge only.

---

## 2. Consent model

**Opt-out, honoring `DO_NOT_TRACK`** — the de-facto CLI standard (Next.js, Homebrew, Astro).

Resolution order (disabled if *any* says off):

1. `DO_NOT_TRACK` env present (any truthy value per the standard) → **off**
2. `STYRE_TELEMETRY=0` env, or runtime config `telemetry: false` → **off**
3. otherwise → **on**

On first run, print a **one-time notice to stderr** (stdout is reserved for the NDJSON stream)
explaining what is collected and how to disable it. The "notice shown" flag is persisted alongside
the anonymous ID. When disabled, `createAnalytics` returns a no-op object: **no file writes, no
network, nothing.**

---

## 3. Identity model

Two random identifiers, **neither derived from anything real** (no machine ID, username, repo, API
key, or hash-of-name — a salted hash with a salt compiled into an OSS binary is only pseudonymous).

- **`distinct_id`** — the anonymized "user"/install. A random UUIDv4 generated on first run and
  persisted to **`$XDG_STATE_HOME/styre/telemetry.json`** (default
  `~/.local/state/styre/telemetry.json`). Reused on every subsequent run. Styre generates and
  persists it automatically; the user never sets anything. (Lives in `state/`, not `config/`,
  per XDG semantics: machine-generated durable state, like a history file, alongside park dumps.)
- **`project_id`** — for "projects handled" and "issues per project". A random UUIDv4 generated at
  `styre setup` and stored **inside `profile.json`**. Travels with the profile, so the same project
  is stable across runs, while the slug/name never leaves the machine. Older profiles without a
  `project_id` lazily get one written back on first run.

### Ephemeral CI caveat (documented, not engineered around)

A file-based ID can only persist if the filesystem persists. A CI container that wipes `$HOME`
each run defeats any file-based storage by construction. The recipe is the standard one: **cache
`~/.local/state/styre/` in the CI config.** Absent that, CI runs mint a fresh `distinct_id` and are
counted as transient users — a property of the environment, not a gap in Styre. `project_id` is
unaffected (it rides in the checked-in `profile.json`).

---

## 4. Event catalog

A handful of curated events. Every event carries shared **super-properties**: `distinct_id`,
`styre_version`, `os` (darwin/linux), `arch` (arm64/x64), `ci` (bool).

### `setup_completed`
Fired by `setup.ts` after `profile.json` is written.

| Property | Source | Notes |
|---|---|---|
| `project_id` | generated/stored in profile | random UUID |
| `checks_system` | profile | `github` / `external` / `none` |
| `component_count` | profile | integer |
| `component_kinds` | profile | allow-listed kinds: backend/frontend/data/… |
| `stack_bucket` | profile `promptVars` | coarse: node/python/go/rust/… (allow-listed) |
| `topology_type` | profile `runtimeContext.topology.type` | coarse enum |

### `run_started`
Fired by `run.ts` after ticket ingest (so crashed/parked runs still register in the funnel).

| Property | Source | Notes |
|---|---|---|
| `project_id` | profile | |
| `resumed` | CLI args | bool (`--resume`) |
| `tracker` | runtime config | `linear` |
| `forge` | runtime config | `github` |

### `run_completed`
Fired by `run.ts` after `driveToTerminal` returns. The highest-value event. Parked runs flow
through here too (they return a summary with `outcome=parked`).

| Property | Source | Notes |
|---|---|---|
| `project_id` | profile | |
| `outcome` | summary | `pr-ready` / `done` / `blocked` / `no-progress` / `parked` |
| `terminal_stage` | summary | design/implement/verify/review/merge — *where runs die* |
| `ticks_bucket` | summary `ticks` | bucketed (e.g. 1–5 / 6–20 / 21–50 / 50+) |
| `dispatch_count_bucket` | summary | bucketed |
| `cycle_count_bucket` | summary `cycle_count` | bucketed — self-correction volume |
| `duration_bucket` | wall clock | bucketed |
| `first_time_ci_pass` | derived from signals | bool — §5.3 quality rate |
| `autonomous_fix` | derived from dispatch outcomes | bool — recovered from red without a human |
| `failure_bucket` | mapped from `escalation_reasons` | fixed enum (see below); raw text never sent |
| `complexity_grading` | runtime config | bool — feature adoption |
| `on_plan_defect` | runtime config | `escalate` / `redesign` |

`failure_bucket` enum (the only failure detail that leaves the machine):
`budget-exhausted` · `plan-defect` · `reviewer-blocking` · `build-red-persistent` ·
`scope-violation` · `human-gate` · `no-progress` · `parked-credits` · `dispatch-failed` · `unknown`.

### `cli_error`
Fired by the `run.ts` catch block.

| Property | Source | Notes |
|---|---|---|
| `command` | CLI | `run` / `setup` / `migrate` |
| `exit_code` | process | integer |
| `error_class` | exception | constructor name only — **never the message** |

### Derived dashboards (no extra events needed)
- **Activation funnel:** `setup_completed → run_started → run_completed{pr-ready}`.
- **Where runs die:** distribution of `terminal_stage` on non-success outcomes.
- **Quality rates:** `first_time_ci_pass`, `autonomous_fix` (the §5.3 headline rates).
- **Reliability / credit limits:** `outcome=parked` + `resumed=true` rate.
- **Feature adoption:** `complexity_grading`, `on_plan_defect`, `tracker`, `forge`.
- **Platform matrix:** `os` × `arch` × `styre_version`.

---

## 5. Architecture — the CLI edge, not the telemetry sink

Product analytics is **not** wired into the `TelemetrySink` (NDJSON) path: that sink is the
open-core seam, fires per-dispatch (wrong granularity), and threads through the engine. Instead a
self-contained module fires a few events from the **command layer**, reading results already
computed. The engine/daemon never import it. The whole thing is strippable by deleting one folder.

```
src/telemetry/analytics/
  id.ts          read-or-create distinct_id; owns the first-run-notice flag (state/telemetry.json)
  consent.ts     resolve enabled/disabled (DO_NOT_TRACK, STYRE_TELEMETRY, config flag)
  properties.ts  THE ALLOW-LIST CHOKEPOINT: typed property builders + bucketers + failure-bucket map
  client.ts      posthog-node wrapper: capture() + bounded shutdown(); fail-silent
  index.ts       createAnalytics(config) -> { setupCompleted, runStarted, runCompleted,
                 cliError, shutdown } | no-op object when disabled
```

### The allow-list chokepoint (the core safety guarantee)
`properties.ts` is the **only** place a property bag is constructed. It accepts typed, coarse inputs
and returns a plain object with an enumerated set of keys. There is no `...spread` of a summary or
profile object anywhere near PostHog, so a field added to a summary later can never silently leak.
A unit test asserts every emitted bag contains **only** allow-listed keys.

### Transport
- **`posthog-node` SDK** (operator's choice), host **`https://us.i.posthog.com`** (US Cloud).
- Init tuned for a short-lived CLI (immediate-ish send); **`await posthog.shutdown()`** on exit to
  flush, wrapped in a ~2s `Promise.race` timeout so the CLI never hangs on a slow network.
- The PostHog **project API key is a write-only client key compiled into the binary** — visible in
  the OSS source, which is normal for product-analytics client keys.
- Must be verified to bundle cleanly under `bun --compile` (pure-JS dep; expected fine, but tested).

### Hook points (4 calls)
1. `setup.ts` — after `profile.json` written: generate/store `project_id`, fire `setup_completed`.
2. `run.ts` — after ticket ingest: `run_started`.
3. `run.ts` — after `driveToTerminal` returns: `run_completed`.
4. `run.ts` — catch block: `cli_error`.
   `finally`: `await analytics.shutdown()` (bounded).

### Safety defaults
- All `capture()` calls are fire-and-forget; only `shutdown()` is awaited (bounded).
- Network/transport errors are swallowed; telemetry never changes an exit code or blocks a run.
- Disabled → no-op object: zero file writes, zero network.

---

## 6. Config & schema touch-points

- **Runtime config** (`src/config/runtime-config.ts`): add `telemetry: z.boolean().default(true)`.
  Resolution still honors `DO_NOT_TRACK` / `STYRE_TELEMETRY` env regardless of config.
- **Profile schema** (`src/setup/…`): add optional `project_id: string` (UUID). Optional ⇒ no
  forced migration; absent ⇒ lazily generated and written back on first `run`.
- No SQLite schema change. (`metric_event` stays the deferred, unwritten denormalization it is.)

---

## 7. Testing

Mirror `test/telemetry/`:
- Inject a **capturing fake client**; assert outcome→event mapping and bucketing.
- **Guard test:** every property bag contains only allow-listed keys (forbidden field can't regress).
- Consent matrix: `DO_NOT_TRACK`, `STYRE_TELEMETRY=0`, config flag → no-op (no writes, no calls).
- ID lifecycle: first run creates + persists; second run reuses; disabled creates nothing.
- `failure_bucket` mapping from representative `escalation_reasons`.
- Bundle smoke: compiled binary emits an event against a stub host (or with capture stubbed).

---

## 8. Decision log (all DECIDED)

| # | Decision | Choice |
|---|---|---|
| D1 | Audience | OSS users in the wild → binary phones home |
| D2 | Consent | Opt-out + honor `DO_NOT_TRACK` |
| D3 | Granularity | Curated product events, not NDJSON forwarding |
| D4 | Cost/tokens | Excluded entirely |
| D5 | Excluded fields | ticket idents, repo paths, commands, SHAs, failure signatures, raw reasons |
| D6 | `distinct_id` | random UUID in `~/.local/state/styre/telemetry.json`, auto-persisted |
| D7 | `project_id` | random UUID in `profile.json` |
| D8 | Fleet/CI identity | none (no `STYRE_ANON_ID`); cache the state dir in CI |
| D9 | Placement | CLI edge module `src/telemetry/analytics/`, not the sink |
| D10 | Transport | `posthog-node` SDK |
| D11 | Host | US Cloud `https://us.i.posthog.com` |
