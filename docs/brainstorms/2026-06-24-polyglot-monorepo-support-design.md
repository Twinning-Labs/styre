# Polyglot-monorepo support — foundation design

- **Date:** 2026-06-24
- **Status:** revised after independent 4-reviewer pass (adversarial / feasibility / scope /
  coherence); foundation ready for planning. See §13 for what changed and why.
- **Umbrella:** part of the de-web arc (Linear ENG-167). Fills the gap *between* ENG-169
  (interface-contract vocab) and ENG-171 (plan task-division by module): **per-stack command
  routing**, which neither ticket — as scoped — actually covers. Wants its own ticket, upstream of
  ENG-171.
- **Grounding repo:** `~/code/twinning-tauri` (Svelte frontend at repo root + Rust Cargo workspace
  in `src-tauri/` + `crates/*` + a Node sidecar + Playwright e2e). Cross-checked against `breev`
  and `mylife-space-v2`.

## 1. Problem

Styre's profile is **flat**: one `commands` record (one `build`, one `test`, one `check`,
repo-wide) and one coarse `topology.type`. `verify:check` resolves `profile.commands[checkType]`
(`handlers.ts:302`) and runs it; `verify:integration` runs one repo-level build+test
(`handlers.ts:384`). There is no notion of more than one stack in a repo.

That breaks on a polyglot monorepo. In a Tauri app:

- The Svelte frontend is built/checked with `vite build` / `svelte-check`; the Rust core is built
  and tested with `cargo build`/`cargo test`. **One command per check-type cannot express both.**
  Declaring `test: "cargo test"` silently leaves the frontend untested (and vice-versa).
- The frontend↔Rust boundary is a **runtime contract** (Tauri IPC: `invoke("cmd", args)` in JS ↔
  `#[tauri::command] fn cmd(...)` in Rust, serde types on both sides). Change the Rust signature
  and **`cargo build` still passes** (Rust compiles) and **`vite build` still passes** (TS never
  saw the Rust types) — the break is invisible to *both* per-stack builds.

No currently-scoped ticket fixes the command problem. ENG-171 reworks how the *plan* groups work
units (prose only — never touches `profile.commands` or verify). ENG-169 is prompt-vocabulary only.
So per-stack command routing falls in the gap and is what this foundation builds.

## 2. Scope (and an honest statement of what is touched)

**This spec: detect → store → test-each-stack, for N stacks in one repo.**

The earlier draft claimed "substrate-only, no prompt changes." Review showed that is **not
accurate** and the claim is withdrawn. The change is substrate-centred but it touches **five
production seams** (§10), including the capability-isolation allowlist (`run-dispatch.ts` /
`tool-allowlists.ts`) and one prompt variable (`prompt-vars.ts:79`, `test_command`). What it does
*not* require is any change to the **reasoning** of the design/extract agents: they keep declaring
abstract check-types (`test`/`build`/…) and the substrate maps each to the right stack's command by
diff. So plans stay component-blind and correct; they are just less stack-aware in prose until
follow-on (1). That distinction — *substrate + plumbing, but no change to agent judgement* — is the
real boundary, and it is what keeps the foundation reviewable and the follow-ons clean.

**Immediate follow-ons (own specs, sequenced right after — on the board, not deferred):**

1. **Stack-aware planning** — teach the design/extract prompts to *reason* per-stack (ENG-171
   neighborhood). Quality, not correctness: per-stack testing already works without it (§6).
2. **Cross-stack contract verification** — the hard piece (the Tauri-IPC break). Plugs into the
   repo-level command seam defined here (§6). Needs its own brainstorm.

**No back-compat.** The repo is pre-release. The component model *replaces* the flat `commands`
record outright. `profile.schemaVersion` is bumped, and `parseProfile`/`loadProfile` **must
hard-fail with a clear message** on an old flat-`commands` profile — never silently default — so an
early adopter re-runs `styre setup` rather than silently losing their commands. Single-stack is just
N=1 (one component spanning `**`).

## 3. The component model

The profile's flat `commands` record is replaced by a list of **components** (a.k.a. stacks/
modules) plus a repo-level command set. "Component" is the term used throughout; it is **not** the
same as `work_unit.kind` (work nature: backend/frontend/docs) — a component hosts units of many
kinds.

```jsonc
{
  "schemaVersion": 2,
  "components": [
    {
      "name": "rust-core",
      "kind": "rust",                                  // free-text stack label (agent-proposed)
      "paths": ["src-tauri/**", "crates/**", "Cargo.toml", "Cargo.lock"],
      "commands": {                                    // open map keyed by check-type;
        "build": "cargo build --workspace",            //   value: command string OR { "unavailable": true }
        "test":  "cargo test --workspace",
        "check": "cargo clippy --workspace -- -D warnings"
      },
      "testFilePattern": "(^|/)tests/|#\\[test\\]"
    },
    {
      "name": "frontend",
      "kind": "sveltekit",
      "paths": ["src/**", "static/**", "package.json", "bun.lock", "vite.config.js", "svelte.config.js"],
      "commands": { "build": "vite build", "check": "svelte-check", "test": { "unavailable": true } },
      "testFilePattern": "\\.(test|spec)\\.(ts|js)$"
    },
    {
      "name": "whatsapp-sidecar",
      "kind": "node",
      "paths": ["whatsapp-sidecar/**"],
      "commands": { "build": "bash whatsapp-sidecar/build.sh", "test": { "unavailable": true }, "check": { "unavailable": true } },
      "scriptRunner": true                             // owner-backed shell script — broad Bash scope (§7)
    }
  ],
  "repoCommands": {                                    // span/own no single component; run at integration
    "integration": "playwright test --project=e2e",
    "smoke":       "playwright test --project=smoke"
  }
}
```

- A component is a **path-bounded unit sharing one toolchain + command set**. `paths` is the routing
  key (§6) and must include the **build-affecting root files** a change to which would break that
  stack (root `package.json`, lockfiles, shared `tsconfig`, the workspace `Cargo.toml`) — detection
  attributes these to the component(s) they affect rather than leaving them unmatched (see §6 edge).
- `commands` is an **open map keyed by check-type**. `build`/`test`/`check` are the **must-have
  classes** (the §4 ladder forces each to a command or `{ unavailable: true }`); other keys (e.g.
  `lint`, a dedicated `e2e`) are optional. Every persisted value is either a command string or
  `{ unavailable: true }` — never blank (§4).
- `repoCommands` are first-class and distinct from per-component commands; they run at integration
  (§6) and are the seam follow-on (2) extends. Justified by that imminent second consumer.
- `scriptRunner: true` marks a command that is itself a shell invocation (`bash …`) — allowed
  (owner-backed) but it cannot be tightly Bash-scoped, so it triggers a warning (§7).

## 4. Command resolution policy

`styre setup` is **interactive (TTY)** — setup always wants human eyes and sometimes human input;
it is not fire-and-forget (`styre run` is). For each component, each must-have class
(`build`/`test`/`check`) resolves through a fixed ladder:

1. **Detect** from manifests/conventions (§5).
2. **If not found → prompt the operator** at the TTY ("frontend has no `test` command — supply
   one, or confirm none?").
3. **If supplied → record the command string.**
4. **If the operator confirms none → record `{ unavailable: true }` and emit a loud warning.**

"Blank" is never persisted: a saved command slot is always a command or `{ unavailable: true }`.
The unresolved/"not-yet-decided" state exists **only during the setup conversation** and must be
resolved before the profile is written.

`styre run` (headless) has no TTY. It consumes an already-resolved profile from a prior `styre
setup`; encountering an unresolved must-have is a hard error, not a guess.

> **New capability.** Setup is non-interactive today (its only operator channel is writing the
> profile + printing a "NEEDS INPUT, edit the JSON" note — `setup.ts:117`). This adds a TTY
> prompting layer (with a non-TTY/CI fallback that errors rather than proceeding). That is in scope
> and acknowledged as net-new, not an extension of the existing enrich flow.

## 5. Detection — deterministic scan anchors, agent refines, operator confirms

Setup detection runs **scan-first, then agent-refine, then operator-confirm** — preserving the
ordering of the existing enrich pipeline while putting the agent only where it earns its place.

- **Deterministic scan (authoritative anchors).** Locate manifests and parse **workspace
  membership** (Cargo `[workspace].members`, npm `workspaces`, `go.work`). These are machine-readable
  ground truth and the agent **must not override** them — e.g. the 9 Cargo manifests in
  twinning-tauri collapse into one `rust-core` component by the `[workspace]` declaration, not by
  agent judgement. The scan also pulls candidate commands from manifests (package.json `scripts`,
  cargo conventions).
- **Agent refine (the genuinely fuzzy fields only).** A read-only agent (`setup:discover`, a new
  read-only allowlist entry mirroring `setup:enrich`), emitting through a **zod schema**, resolves
  what deterministic rules get wrong on real repos: **path boundaries for co-located stacks** (the
  decisive case — in a Tauri app the frontend lives at the repo *root* yet must be
  `src/**,static/**` and *not* `src-tauri/**`; "manifest-dir = paths" would wrongly give it `**`),
  **which root scripts belong to which stack** (`lint:rust` = `cargo clippy` living in
  package.json), odd build commands (`bash build.sh`), `repoCommands` classification, and the
  free-text `kind` labels.
- **Command-existence probing.** Each proposed command is probed at setup (is `cargo` on PATH? does
  `npm run test:e2e` exist?). This catches **typos and missing tools only** — it does **not**
  validate correctness (a plausible-but-wrong `cargo test` vs the real `cargo nextest`) and cannot
  catch a malicious string. It is *not* a ground-truth guarantee.
- **Operator-confirm is security-bearing.** Each proposed command string is later executed via
  `sh -c` at verify and seeds the implement Bash allowlist (§7). Operator sign-off on the command
  list is therefore a **security control**, not a cosmetic "looks right?" — the TTY confirm presents
  it as such.

> **Framing correction.** This is *not* a parameterization of `mergeScanAndEnrichment`
> (`merge.ts`), which reconciles a fixed-shape record of scalar tri-states. Components are a
> variable-length, agent-named list; reconciling agent proposals against deterministic
> workspace/manifest anchors (and probing commands) is a **new reconciliation routine**. The
> *pattern* (scan-anchored, agent-enriched, schema'd, read-only, operator-confirmed) carries; the
> code does not.

Result: a concrete, frozen profile. Agent non-determinism is bounded entirely at produce-time
(schema + probe + operator sign-off) and never reaches the runtime gate.

## 6. Verify routing (deterministic, runtime — no agent)

### Check-type → command resolution (the rule that kills silent-green)
`work_unit.verify_check_types` and `ground_truth_signal.signal_type` are **open vocab**; component
`commands` keys are open too but anchored on must-haves `build`/`test`/`check`. For a unit-declared
check-type `C` on a unit whose diff impacts component set `I`:

1. If any component in `I` declares `commands[C]` (a real command) → run each such command.
2. Else if `C` names a `repoCommands` key → it is a **repo-level** check, deferred to
   `verify:integration` (not run per-unit).
3. Else if every impacted component declares `commands[C] = { unavailable: true }` → the §"untested
   degrade" path (below).
4. **Else — the declared check-type resolves to zero runnable commands → `error`, never `pass`.**

Rule 4 is the load-bearing fix. A declared check that executes **nothing** is recorded as an
`error` `ground_truth_signal` (re-dispatch/halt-eligible), exactly as today `handlers.ts:302`
errors loudly on an unknown check-type. **"Pass" requires that at least one real command ran and was
green.** This closes the vacuous-pass hole (a unit declaring `test` whose diff hit no testable
component no longer sails through green).

### Per-unit changed files (multi-commit attribution)
Routing needs *the unit's* changed files — **cumulative across all of the unit's commits**, not just
the latest. Today `changedFilesAt(latestSha)` (`worktree.ts:55`) is a single-commit diff; after a
loopback re-code a unit has multiple commits and the latest may touch a *different* stack than the
bulk of the work. The foundation records the unit's **base sha** (HEAD before its first
`implement:dispatch` commit) and computes `changedFilesBetween(baseSha, latestSha)`. Impacted
components = components whose `paths` glob-match any file in that cumulative diff.

### Per-unit (`verify:check`)
For each declared check-type, resolve per the rule above and run the matched commands; **pass = ≥1
command ran and all that ran are green.**

### A1 behavioral gate, per component
`testFilePattern` is **per-component**. A behavioral unit touching a stack needs a test file
matching *that stack's* pattern within *that stack's* paths (a loop over impacted components instead
of one global `isTestFile`). If an impacted component's `test` is `{ unavailable: true }`, the unit
takes the **untested-degrade** path.

### Untested degrade (decision C, hardened)
A behavioral unit whose impacted component has `test: { unavailable: true }` **proceeds to
reviewer-only** (loop-not-halt) **but emits a first-class `untested-merge-risk` `ground_truth_signal`**
(free-text `signal_type`, no schema change) — surfaced in telemetry and the PR projection, not just
a log line. So it is genuinely loud at decision time and in the durable record, not "warn once then
green forever." Headless `styre run` still proceeds (matching the operator-accepted policy) but the
signal makes the weak gate auditable.

### Integration (`verify:integration`) + repo-level
Runs each component's `build`+`test` plus any `repoCommands` (e2e/smoke). Not diff-routed (runs
unconditionally) — it uses the ticket-latest sha and the doc no longer claims integration is
diff-derived. The e2e suite gives genuine cross-stack coverage for free where it exists, and is the
seam follow-on (2) extends.

### Edge rules
- **Overlap → union** (run all matched components' checks).
- **Build-affecting root files are attributed to their component(s)** at detection (§3 `paths`), so
  a root `package.json`/lockfile change routes to the stack it affects rather than being unmatched.
- **Genuinely unmatched files** (a `README`, a `.github/` workflow) trigger no per-component check —
  but a unit that declared a check and matched *no* runnable command for it hits **Rule 4 (error)**,
  not a silent skip. Unmatched-is-safe is no longer an assumption; zero-executed-is-error is the
  backstop.

## 7. Capability isolation — the implement Bash allowlist (CRITICAL fix)

Today the implement agent's Bash is scoped from `Object.values(profile.commands)`
(`run-dispatch.ts:88`) into per-command `Bash(cmd:*)` entries (`tool-allowlists.ts:30`). The
components model breaks this two ways, both addressed here:

1. **`{ unavailable: true }` objects** would flow into `Object.values` and crash `.map(c =>
   c.trim())`. → The runner-list builder iterates `components[].commands` (and `repoCommands`),
   **filtering out non-string `{ unavailable }` values**.
2. **Union blow-up + unscoped fallback.** Naively unioning all components' commands hands a frontend
   unit `Bash(cargo …)`, `Bash(playwright …)`, `Bash(bash build.sh:*)` — a *widening* of isolation,
   and an **empty** runner list today falls through to bare unscoped `Bash` (`tool-allowlists.ts:32`).

**Design (narrow, never widen, never unscoped):** scope the implement Bash allowlist to the **unit's
expected components** = `files_to_touch ∩ component.paths` (Option 1; `files_to_touch` already exists,
advisory A3 — acceptable because the allowlist is a *capability bound*, not the verify gate). Then:
- Common case (files_to_touch present, matches components) → Bash scoped to **just those components'**
  runners. *Narrower than today.*
- Fallback (files_to_touch empty/no-match) → the **scoped union of all components' build/test/check**
  (`Bash(cmd:*)` each, `{ unavailable }` filtered) — **never bare unscoped Bash.** Equals today's
  effective behavior; never worse.
- An under-scoped unit (agent needs a second stack the plan didn't anticipate) can still *write*
  code; diff-routed verify still runs the right stacks; the under-scope surfaces as a loopback
  signal. Acceptable.

**Owner-backed shell-script runners** (`scriptRunner: true`, e.g. `bash build.sh`) are **allowed**
(the operator owns them) but `Bash(bash build.sh:*)` ≈ `Bash(bash …)` — it cannot be tightly scoped.
Setup **warns** on every `scriptRunner` command so the operator accepts the broad scope knowingly.

The §9 invariant-compliance claim is rewritten accordingly: isolation is *preserved and, in the
common case, tightened* — not, as the first draft wrongly asserted, automatically preserved.

## 8. Worked example — twinning-tauri

Components (per §3 JSON): `rust-core` (`src-tauri/**`,`crates/**`,`Cargo.*`; cargo build/test/clippy),
`frontend` (`src/**`,`static/**`,`package.json`,`vite.config.js`,…; vite/svelte-check; `test`
unavailable), `whatsapp-sidecar` (`whatsapp-sidecar/**`; `bash build.sh`, `scriptRunner`).
`repoCommands.integration` = Playwright e2e.

A unit changing a Rust `#[tauri::command]` signature **and** its Svelte caller has a cumulative diff
touching `src-tauri/**` and `src/**` → impacted = {rust-core, frontend}.
- **Implement:** Bash scoped (via `files_to_touch ∩ paths`) to `cargo …` + `vite build`/`svelte-check`
  — *not* `bash build.sh` or `playwright`.
- **verify:check `test`:** rust-core has `test` → `cargo test --workspace` runs; frontend `test` is
  unavailable → if the unit is behavioral and its frontend portion is behavioral, the
  `untested-merge-risk` signal fires for the frontend side. ≥1 real command ran (cargo) so it is not
  a vacuous pass.
- **verify:integration:** all components' build/test + Playwright e2e — which actually exercises the
  IPC boundary, giving the contract break a real chance of being caught before follow-on (2).

## 9. Invariant compliance (rewritten — honest)

- **Ground truth over self-report.** The agent operates only at produce-time (setup), behind a
  schema + command-probe + **security-bearing** operator sign-off. Runtime verify computes the
  decision deterministically from the cumulative diff and exit codes — no agent, no blob. The one
  residual self-report path (reviewer-only on an untested stack) is now made **loud and durable** via
  the `untested-merge-risk` signal (§6), not silent.
- **Capability isolation.** Setup discovery agent is read-only. Implement Bash is scoped to the
  unit's expected components and **never widens to the union by default, never falls back to unscoped**
  (§7); `scriptRunner` broad scopes are operator-acknowledged via warning.
- **No silent capability gaps.** A declared check that runs zero commands is an `error`, not a pass
  (§6 Rule 4); an untestable stack emits a durable signal; the command ladder forces every must-have
  to a command or an operator-confirmed `unavailable`.
- **Loop-not-halt.** Untestable stacks degrade (with signal) rather than halt.

## 10. Affected sites (blast radius — not "replace one record")

Production (~6): `profile.ts` (schema), `handlers.ts:302` (`verify:check`), `handlers.ts:384`
(`verify:integration`), `handlers.ts:334` (A1 `testFilePattern`), `run-dispatch.ts:88` + `tool-allowlists.ts:30`
(implement Bash allowlist — §7), `prompt-vars.ts:79` (`test_command` injection — must be re-sourced
or dropped), `worktree.ts` (`changedFilesBetween` — new), `setup.ts` + new `setup:discover`
(detection + TTY). Tests (~10+): `profile.test.ts`, `probe.test.ts`, `verify-routing-e2e`,
`diff-gates-e2e`, `verify-handlers`, `tool-allowlists`, `prompt-vars`, plus new detection/TTY tests.

## 11. Out of scope / follow-ons

- **Verify-command sandboxing** — commands run via `sh -c` with a 2-key env denylist
  (`agent-env.ts:9`), not a sandbox. Pre-existing; polyglot amplifies it but does not introduce it.
  **Out of scope** for this foundation; noted for a future hardening ticket.
- **Cross-repo / downstream-consumer contracts** (consumer outside the worktree) — out of reach of
  the single-worktree executor; not in this arc.
- **Immediate follow-ons:** (1) stack-aware planning prompts (ENG-171); (2) cross-stack contract
  verification (new brainstorm; builds on `repoCommands`).

## 12. Ticket implications

- The foundation is the per-stack command-routing gap no current ticket covers → **new ticket**,
  upstream of ENG-171.
- ENG-169 (interface-contract vocab) and ENG-171 (plan task-division) remain prompt-side; follow-on
  (1) is where ENG-171 lands. Follow-on (2) is a new ticket.

## 13. Revision log (post independent review)

Changes from the first draft, by reviewer finding:
- **CRITICAL — capability isolation (§7, new):** owned the `run-dispatch.ts`/`tool-allowlists.ts`
  change; implement Bash now scopes to the unit's expected components, filters `{unavailable}`,
  never falls back to unscoped; `scriptRunner` warning. First draft's §8 isolation claim was wrong
  and is rewritten (§9).
- **CRITICAL — silent-green (§6 Rule 4):** explicit check-type→command resolution; a declared check
  that runs zero commands is `error`, never a vacuous pass. Closes the open-vocab/fixed-class gap.
- **HIGH — diff attribution (§6):** replaced the misleading "styre already does this" with cumulative
  multi-commit per-unit diff (`changedFilesBetween(base,latest)`); loopbacks no longer misroute.
- **HIGH — setup interactivity (§4):** TTY prompting adopted (operator decision); acknowledged as a
  net-new capability, not an extension of enrich.
- **HIGH — "no prompt changes" withdrawn (§2):** honest statement of the five touched seams incl.
  `prompt-vars.ts:79`; the real boundary is "no change to agent *reasoning*."
- **Decision B hardened (§6 edge):** build-affecting root files attributed to their component;
  unmatched-is-safe replaced by zero-executed-is-error.
- **Decision C hardened (§6):** untested degrade now emits a durable `untested-merge-risk` signal.
- **Detection reframed (§5):** scan-first authoritative anchors → agent refines fuzzy fields →
  security-bearing operator confirm; deleted the false "extends merge.ts" claim; existence-probing
  scoped to typo/missing-tool only.
- **Medium/minor:** `schemaVersion` bump + hard-fail load (§2); blast radius enumerated (§10);
  verify-sandbox out-of-scope note (§11); `whatsapp-sidecar` added to §3 JSON; jargon defined.
