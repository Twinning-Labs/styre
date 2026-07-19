# Toolchain preflight — design (rewrites ENG-332)

**Date:** 2026-07-19
**Status:** design, pending independent review
**Supersedes:** the original ENG-332 ("resolver: run provision before the design dispatches"). The provision-first reorder survives as a *secondary* component of this ticket; the headline is now a run-start toolchain preflight.
**Siblings:** ENG-326 (agent-CLI preflight — shares the `preflightBinary` primitive, stays a separate ticket), ENG-331 (dump/resume an escalated run — the recoverability half).

---

## 1. Problem

Ground truth — `styre run STYRE-1` against `styre-events` (2026-07-16): burned **seven design dispatches** (all `clean-success`), completed four design steps, then died at step 5:

```
provision: php 'composer install' exited 127: sh: composer: command not found
```

`composer` was not installed. Every one of those dispatches was spent to discover a fact knowable at second zero.

The original ENG-332 fix was "move `provision` above the design dispatches" so the real install fails before the spend. That is correct but incomplete, and its headline value has since been eroded by ENG-331: once an escalated run dumps and resumes, the design dispatches are **journaled** (`done()` is succeeded-only, `resolver.ts:25-27`) and a resume re-runs only the failed `provision` step — so the design spend is *deferred, not wasted*, in the interactive case. What remains, and what this ticket targets, is:

1. **Fail-fast for the operator** — learn "install composer" at second zero, not after minutes of Opus design work.
2. **The no-resume path (CI / fleet / ephemeral)** — where the dump is discarded and the fix is "repair the image, re-run from scratch." There, every still-broken iteration costs 4 design dispatches without a preflight, `$0` with one. This is the OSS binary's primary use case (the CI/cloud/fleet primitive).
3. **A clean invariant** — "environment fault before any spend," not "environment fault after the design stage, recoverable via resume."

## 2. Why not just make `styre setup` ensure the environment?

Tempting — "setup should guarantee setup" — but it conflates two different things:

- **The requirement** ("this repo needs composer") — a *durable repo fact*.
- **The presence** ("composer is installed *here*") — an *environment fact* about the machine that runs the work.

`styre setup` is a **describe** pass: it probes the repo and writes a *portable* `profile.json` (one of the open-core seam's versioned public APIs). Its output travels — to CI runners, to fleet workers, to the commercial plane. Three structural reasons the *install* cannot move into setup:

1. **No worktree at setup time.** `styre run` mints a fresh worktree per ticket (`worktreeFor` → `ensureWorktree`). `node_modules/` and the editable install live *inside that worktree*. Setup has nothing to install into.
2. **Provision re-arms mid-run.** `resetProvisionIfManifestTouched` (`provision.ts:235-243`) reinstalls when an implement dispatch commits a manifest change — the dependency set changes *because of the work the ticket is doing*. That is inherently a control-loop event; setup runs before any ticket.
3. **Ground truth requires the real install.** A PATH check answers "is composer present"; it does not answer "does `composer install` succeed against this lockfile in this environment." Only running the install surfaces broken lockfiles, dead registries, version conflicts, missing system libs — and it must run against the *run's* worktree, not a throwaway checkout.

And the killer caveat: **profile.json travels; the toolchain does not.** A presence check *at setup* checks the wrong machine in the fleet model, where setup runs once (committed profile) and run executes on many ephemeral workers. So the requirement is setup's to *record*; the presence is the run's to *check*, on the machine that actually executes.

## 3. Design — three layers

### Layer 1 — Setup records the requirement (durable)

- Add `requires: string[]` to `ComponentSchema` (`src/dispatch/profile.ts`). Bump `ProfileSchema.schemaVersion` **3 → 4**.
- **Hard bump:** `parseProfile` throws on a v3 profile with a "re-run `styre setup` to regenerate a schemaVersion-4 profile" message, exactly as it already does for v1/v2. Consequence (deliberate): a v4 profile *always* carries `requires`, so the preflight is never silently a no-op — its behavior is deterministic, not "maybe empty."
- Each setup **detector** populates `requires` with the binaries its `prepare` command actually needs — the knowledge lives where it is unambiguous. The php detector emits `["composer"]`; the node detector emits the package manager it resolved from the lockfile (`["pnpm"]` vs `["npm"]` vs `["yarn"]`); python emits its interpreter/installer; etc. `requires` is the tool(s) `prepare` invokes — **not** the command string re-parsed (parsing `cd web && npm ci` for its tool is the exact fragility this design exists to avoid).
- Setup **also** runs the presence check on the setup machine and prints an **advisory, non-fatal** warning for anything missing (e.g. "detected `composer`; not on PATH — install with your platform package manager"). Record always, warn helpfully, gate nowhere at setup. Setup must not hard-fail on a missing runtime tool: it legitimately runs in describe-only / build environments that lack them, and the profile it emits is meant to travel.

### Layer 2 — Run-start preflight (the new gate)

- A shared primitive `preflightBinary(name, versionSpec?)` → `{ ok } | { missing } | { unsupportedVersion, found, required }`. Resolves the binary (`Bun.which`), confirms it is on PATH/executable, and — only when a `versionSpec` is given — runs `<name> --version` and asserts the range. ENG-326 calls it *with* a versionSpec for the agent CLI; **this ticket calls it presence-only** for each `requires` entry.
- **Presence-only for repo tools.** Version compatibility ("composer too old", "wrong Node major") is left to `provision`, which runs the real install and surfaces it as ground truth. Hand-maintaining version ranges for every ecosystem duplicates what the install already does correctly.
- **Placement:** runs very early in `styre run` — after the profile loads, **before** ticket ingestion / any tracker API call / any dispatch. (Same "before we spend or hit an API" reasoning ENG-331 gives for its `--db` guard: `fetchTicket` precedes `insertProject`, so a late guard burns a tracker call.) It reads `requires` across all components and aggregates **every** missing tool into one message, so the operator fixes once rather than iterating.
- **On a miss:** exit with a distinct **non-retry** code — proposed `69` (`EX_UNAVAILABLE`, "a required resource is unavailable"), with a note in the ticket that the exact number must reconcile with ENG-338's forthcoming exit-code taxonomy so they do not collide. The message names the missing tool(s) and the install hint if setup recorded one. **No SoT dump.** The preflight runs before anything is journaled and before any spend, so there is nothing to resume — the fix is a plain re-run, not `--resume`. (This is the clean contrast with a *provision* failure, which has real design state worth preserving — that is ENG-331's job, not this one's.)

### Layer 3 — Provision stays, positioned first (the backstop)

- No change to the provision handler, `planProvision`, or `isComponentReady`.
- Keep the ~4-line **provision-first reorder**: move the `provision` block above the four design dispatches in `resolver.ts` `case "design"` (it already sits inside `case "design"` at `:112-114`, just below the dispatches — see the "Hoist" comment at `:110-111`; this moves it above them). This makes the *non-tool* faults that only a real install reveals (broken lockfile, dead registry, version conflict) also fail before design spend, in the no-resume / CI-loop case. Provision provably depends on nothing design produces: design commits only under `docs/plans/` (`commitScope: planScope`, `handlers.ts:394`; `planScope = isPlanPath`, `commit-scope.ts:39`), so it cannot touch a dependency manifest — freshness lost by moving provision above design is zero.

## 4. Data flow

```
styre setup <repo>
  detect components ──> each detector sets Component.requires[]
                        + advisory presence check (warn, non-fatal)
  write profile.json (schemaVersion 4)

styre run <ticket>
  load profile
  ──> RUN-START PREFLIGHT: for each component, preflightBinary(tool) presence-only
        any missing? ──> print all missing + hints, exit 69, NO dump   [STOP]
        all present?  ──> continue
  ingest ticket, enter design stage
  ──> resolver: provision (now FIRST in case "design")
        real install; non-tool faults escalate here (ENG-331 dump/resume)
  ──> design dispatches ... (only reached once env is sound)
```

## 5. Interfaces / boundaries

| Unit | Does what | Depends on |
| --- | --- | --- |
| `preflightBinary(name, versionSpec?)` | Resolve a binary, check presence (+ optional version); return a typed result. Pure of policy. | `Bun.which`, `<name> --version` |
| `Component.requires[]` | Declares the tool(s) `prepare` needs. Set by detectors, read by preflight. | profile schema v4 |
| run-start preflight | Aggregate `requires` across components, call `preflightBinary` presence-only, exit 69 on any miss. | profile, `preflightBinary` |
| setup advisory check | Same call, warning-only, never gates. | profile, `preflightBinary` |
| provision (unchanged) | Real install into the worktree; ground-truth backstop; re-arms on manifest edits. | worktree, `profile.components` |

## 6. Non-goals (do not re-litigate)

- **Version-checking repo tools** at the preflight — provision owns "present but wrong version" via ground truth.
- **The agent-CLI probe** — ENG-326, shares `preflightBinary`, ships separately.
- **Dump/resume of an escalated (provision) run** — ENG-331.
- **Moving the install into setup** — structurally impossible (§2).
- **Removing the in-loop provision step** — a standalone `styre provision` entry point could share `planProvision`, but the loop step must stay for the re-arming case.
- **Re-parsing `prepare` to guess its tool** — the reason `requires` is detector-populated (§3, Layer 1).

## 7. Testing

- `preflightBinary`: present → ok; missing → `{ missing }`; version path exercised by ENG-326.
- Run-start preflight: a missing tool → exit 69, **zero** dispatch rows, **no** dump; all present → run proceeds.
- Setup: a detector populates `requires`; a missing tool → advisory warning emitted, setup still **succeeds**.
- Profile parse: v4 round-trips; a v3 profile throws the re-run message.
- Resolver: a fresh `design`-stage ticket resolves `provision` **before** `design:dispatch`; provision reuse still holds (implement gates find it `done`); `resetProvisionIfManifestTouched` still re-arms.
- `bun run lint` + `bun test` green.

## 8. Acceptance criteria (for the rewritten ENG-332)

- [ ] `Component.requires: string[]` exists; `schemaVersion` is 4; v3 profiles throw a re-run message.
- [ ] Setup detectors populate `requires` with the actual tool(s) each `prepare` invokes (npm vs pnpm vs yarn distinguished from the lockfile).
- [ ] Setup emits an advisory, non-fatal warning for tools missing on the setup machine; setup still succeeds.
- [ ] `preflightBinary(name, versionSpec?)` primitive exists, shared with (but not blocked on) ENG-326.
- [ ] `styre run` runs the preflight after profile load and before any dispatch/tracker call; a missing tool exits `69`, prints all missing tools + hints, writes **no** dispatch rows and **no** SoT dump.
- [ ] Exit code reconciled with ENG-338's taxonomy (no collision).
- [ ] `provision` resolves before `design:dispatch` in `case "design"`; reuse + manifest re-arm unregressed.
- [ ] Tests per §7; `bun run lint` + `bun test` green.

## 9. Refs

- Ground truth: STYRE-1 SoT — steps 1-4 `succeeded`, step 5 `provision` `failed` (`attempt=1`); `d0001`-`d0007` all `clean-success`.
- Code: `src/dispatch/profile.ts` (`ComponentSchema`, `ProfileSchema.schemaVersion`, `parseProfile`); `src/dispatch/components.ts` (`EXTENSIONS_BY_KIND` — the kind→data precedent); `src/daemon/resolver.ts:25-27,110-114` (`done`, the provision block); `src/dispatch/provision.ts:55,235-243` (`planProvision`, manifest re-arm); `src/dispatch/handlers.ts:394` (`planScope`); `src/dispatch/commit-scope.ts:39` (`isPlanPath`); `src/setup/detect-components.ts` / detectors (populate `requires`); `src/cli/run.ts` (preflight placement); `src/cli/park.ts` (ENG-331 dump/resume, `--db` guard precedent).
- Siblings: ENG-326 (`preflightBinary`), ENG-331 (dump/resume), ENG-338 (exit-code taxonomy).
