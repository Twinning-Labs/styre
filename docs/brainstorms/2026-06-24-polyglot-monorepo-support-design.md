# Polyglot-monorepo support — foundation design

- **Date:** 2026-06-24
- **Status:** design approved (brainstorm); foundation ready for planning
- **Umbrella:** part of the de-web arc (Linear ENG-167). Fills the gap *between* ENG-169
  (interface-contract vocab) and ENG-171 (plan task-division by module): **per-stack command
  routing**, which neither ticket — as scoped — actually covers. Likely wants its own ticket.
- **Grounding repo:** `~/code/twinning-tauri` (Svelte frontend + Rust Cargo workspace + Node
  sidecar + Playwright e2e). Cross-checked against `breev` and `mylife-space-v2`.

## 1. Problem

Styre's profile is **flat**: one `commands` record (one `build`, one `test`, one `check`,
repo-wide) and one coarse `topology.type`. `verify:check` resolves `profile.commands[checkType]`
and runs it; `verify:integration` runs one repo-level build+test. There is no notion of more than
one stack in a repo.

That breaks on a polyglot monorepo. Concretely, in a Tauri app:

- The Svelte frontend is built/checked with `vite build` / `svelte-check`; the Rust core is built
  and tested with `cargo build`/`cargo test`. **One command per check-type cannot express both.**
  Declaring `test: "cargo test"` silently leaves the frontend untested (and vice-versa).
- The frontend↔Rust boundary is a **runtime contract** (Tauri IPC: `invoke("cmd", args)` in JS ↔
  `#[tauri::command] fn cmd(...)` in Rust, serde types on both sides). Change the Rust signature
  and **`cargo build` still passes** (Rust compiles) and **`vite build` still passes** (TS never
  saw the Rust types) — the break is invisible to *both* per-stack builds.

No currently-scoped ticket fixes the command problem. ENG-171 reworks how the *plan* groups work
units (prose only — never touches `profile.commands` or verify). ENG-169 is prompt-vocabulary
only. The runtime-context brainstorm gestured that ENG-169 would own a "per-`kind` command map,"
but ENG-169's actual scope contains no command work. So per-stack command routing falls in the gap.

## 2. Scope

**This spec (the foundation): detect → store → test-each-stack. Substrate-only — no prompt
changes.** Verify routing is derived from the committed *diff*, and the extract agent already
declares abstract check-types (`test`/`lint`/`build`); the substrate maps each to the right
stack's command. The agent never needs to know components exist for per-stack testing to work.
This keeps the foundation small, deterministic, independently testable, and reviewable without
touching agent behaviour. It fully solves the polyglot **command** problem.

**Immediate follow-ons (own specs, sequenced right after — explicitly on the board, not deferred):**

1. **Stack-aware planning** — teach the design/extract prompts to *reason* per-stack so plans are
   stack-aware (ENG-171's neighborhood). Improves plan quality; not required for per-stack testing.
2. **Cross-stack contract verification** — the hard piece (the Tauri-IPC break). Plugs into the
   repo-level command seam defined here (§5). Needs its own brainstorm.

**No back-compat.** The repo is pre-release / under development. The component model *replaces* the
flat `commands` record outright — no version shim, no synthesized-component migration. Single-stack
is simply N=1 (one component spanning `**`).

## 3. The component model

The profile's flat `commands` record is replaced by a list of **components** (a.k.a. stacks/
modules) plus a repo-level command set:

```jsonc
{
  "components": [
    {
      "name": "rust-core",
      "kind": "rust",                                  // free-text stack label (agent-proposed)
      "paths": ["src-tauri/**", "crates/**"],          // glob set defining the component's surface
      "commands": {                                    // value: command string OR { "unavailable": true }
        "build": "cargo build --workspace",
        "test":  "cargo test --workspace",
        "check": "cargo clippy --workspace -- -D warnings"
      },
      "testFilePattern": "(^|/)tests/|#\\[test\\]"      // per-component (A1 behavioral gate)
    },
    {
      "name": "frontend",
      "kind": "sveltekit",
      "paths": ["src/**", "static/**"],
      "commands": { "build": "vite build", "check": "svelte-check", "test": { "unavailable": true } },
      "testFilePattern": "\\.(test|spec)\\.(ts|js)$"
    }
  ],
  "repoCommands": {                                    // span/own no single component
    "integration": "playwright test --project=e2e",
    "smoke":       "playwright test --project=smoke"
  }
}
```

- A component is a **path-bounded unit sharing one toolchain + command set**. It is *not* the same
  as `work_unit.kind` (work nature: backend/frontend/docs); a component can host units of many kinds.
- **Must-have command classes are `build`, `test`, `check`.** Each value is either a concrete
  command string or `{ unavailable: true }` (operator-confirmed absence). There is no third
  persisted state — see §4 for how `unavailable` is reached without ever silently meaning "unknown."
- `repoCommands` are first-class and distinct from per-component commands; they run at integration
  time (§5) and are the seam follow-on (2) builds on.

## 4. Command resolution policy

For each component, each must-have class (`build`/`test`/`check`) resolves through a fixed ladder
at `styre setup`:

1. **Detect** from manifests/conventions (§5).
2. **If not found → ask the operator** ("frontend has no `test` command — supply one?").
3. **If supplied → record the command string.**
4. **If the operator declines → record `{ unavailable: true }` and emit a loud warning**
   ("⚠ frontend: no test command — styre cannot ground-truth-test this stack").

"Blank" is never persisted. A command slot in the saved profile is *always* either a command or
`{ unavailable: true }`. The unresolved/"not-yet-decided" state exists only **during the setup
conversation** and must be resolved before the profile is written — this is what stops styre from
treating "never checked" as "no test needed."

`styre run` (headless) has no operator to ask. It consumes an already-resolved profile produced by
an earlier `styre setup`; if it ever encounters an unresolved must-have, it errors rather than
guessing.

## 5. Detection — agent-led, deterministically anchored

Reuses and extends the existing setup-enrich producer pattern (`src/setup/merge.ts`:
deterministic scan is ground truth; the agent enriches/resolves only what the scan cannot).

- **Agent-led discovery.** A read-only agent globs the repo and proposes the component model
  (names, `kind`, `paths`, candidate commands), emitted through a **zod schema**. This is the right
  tool for the inherently-fuzzy mapping that deterministic rules get wrong on real repos — e.g. in
  twinning-tauri, `lint:rust` = `cargo clippy` lives in the *root package.json*; the Node sidecar
  builds via `bash build.sh`; which root scripts are "frontend" vs "repo-level e2e" is judgment.
- **Deterministic anchors (the agent must respect, not override).** Manifest locations and
  **workspace membership** (`[workspace].members` in Cargo, `workspaces` in package.json, `go.work`).
  A workspace declaration is a machine-readable "these manifests are one build unit" — so the 9
  Cargo manifests in twinning-tauri collapse into one `rust-core` component, not nine. Workspace
  files are *anchors/hints*, not hand-written per-ecosystem parsers we must own.
- **Command-existence probing.** Each agent-proposed command is probed at setup (does
  `npm run test:e2e` exist? is `cargo` on PATH?) — converting self-report into a probed fact.
- **Operator-confirm.** Setup shows the proposed component list (with command assignments) for the
  operator to confirm or edit.

Result: a concrete, frozen profile. Discovery non-determinism is bounded entirely at produce-time
(behind a schema, a probe, and operator sign-off); it never reaches the runtime gate.

## 6. Verify routing (deterministic, runtime — no agent)

### Per-unit (`verify:check`)
1. Compute the unit's changed files from its diff (styre already does this for the A1 gate).
2. **Impacted components** = every component whose `paths` glob-match a changed file
   (**union** on overlap — a file matching several components marks all of them).
3. For each `check_type` the unit declares, run **that check's command for each impacted component
   that has one**. A unit touching `src-tauri/**` *and* `src/**` runs both `cargo test` and the
   frontend test — exactly the Tauri-IPC case.
4. Pass = every command that ran is green.

### A1 behavioral gate, per component
`testFilePattern` is **per-component**. A behavioral unit touching a stack needs a test file
matching *that stack's* pattern within *that stack's* paths. If the impacted component's `test` is
`{ unavailable: true }`, the unit **proceeds reviewer-only with a loud warning** (loop-not-halt),
and the warning fires twice — once at setup, and again the first time a behavioral unit verifies
weakly in that stack.

### Integration (`verify:integration`) + repo-level
Runs each component's `build`+`test`, **plus** any declared `repoCommands` (the e2e/smoke suite).
The e2e suite gives genuine cross-stack coverage *for free* where the repo already has one, and is
the seam follow-on (2) extends.

### Edge rules
- **Overlap → union** (run all matched components' checks). No precedence puzzle.
- **Unmatched files** (root `README`, `.github/`, top-level config) trigger **no per-component
  check** — a docs/config change has no stack toolchain. But if a *behavioral* unit's **entire**
  diff is unmatched, warn (likely a missing component in the profile).

## 7. Worked example — twinning-tauri

Detected components: `rust-core` (`src-tauri/**`,`crates/**`; cargo build/test/clippy), `frontend`
(`src/**`,`static/**`; vite/svelte-check/eslint; `test` unavailable), `whatsapp-sidecar`
(`whatsapp-sidecar/**`; `bash build.sh`). `repoCommands.integration` = Playwright e2e.

A unit that changes a Rust `#[tauri::command]` signature **and** its Svelte caller touches both
`src-tauri/**` and `src/**` → verify runs `cargo test --workspace` **and** the frontend checks,
then at integration runs the Playwright e2e. The IPC break now has a real chance of being caught by
e2e instead of slipping past two green per-stack builds — even before the deep contract work in
follow-on (2).

## 8. Invariant compliance

- **Ground truth over self-report.** The agent operates only at produce-time (setup), behind a
  schema + command-probe + operator sign-off. The runtime verify gate reads concrete commands/paths
  and computes the decision deterministically from the diff and exit codes — no agent, no blob.
- **Capability isolation.** The discovery agent is read-only (no write/Bash/gh/Linear), like the
  existing enrich agent.
- **No silent capability gaps.** The build/test/check ladder forces every must-have to a command or
  an operator-confirmed `unavailable`+warning; an untestable stack is loud, never silent.
- **Loop-not-halt.** A stack with no test command degrades behavioral units to reviewer-only with a
  warning rather than halting.

## 9. Follow-on sequence (immediate)

1. **Stack-aware planning** (prompt change; ENG-171 neighborhood): design/extract reason per-stack.
2. **Cross-stack contract verification** (hard; new brainstorm): verify the producer↔consumer
   contract (Tauri IPC, etc.) across stacks in the worktree, building on `repoCommands` (§5).

Cross-repo / downstream-consumer contracts (consumer outside the worktree) remain out of reach of
the single-worktree executor and are *not* in this arc.

## 10. Ticket implications

- The foundation (this spec) is the per-stack-command-routing gap no current ticket covers → wants
  a **new ticket**, upstream of ENG-171.
- ENG-169 (interface-contract vocab) and ENG-171 (plan task-division) remain prompt-side; follow-on
  (1) is where ENG-171 actually lands. Follow-on (2) is a new ticket.
