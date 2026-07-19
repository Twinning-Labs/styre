# Toolchain preflight — design (rewrites ENG-332)

**Date:** 2026-07-19
**Status:** design, revised after independent adversarial review
**Supersedes:** the original ENG-332 ("resolver: run provision before the design dispatches"). The provision-first reorder survives as a *secondary* part of this ticket; the headline is a run-start toolchain preflight.
**Siblings:** ENG-326 (agent-CLI preflight — now fully independent, see §9), ENG-331 (dump/resume an escalated run — the recoverability half).

> **Revision note.** The first draft of this doc proposed a new `Component.requires` field, a profile `schemaVersion` 3→4 bump, and per-detector population. Independent review killed that mechanism: `requires`-scoped-to-`prepare` is empty for go/jvm (they have no `prepare`) and names the wrong tool for node (its verify commands use `npm` while `prepare` may use `pnpm`). The corrected mechanism below probes the component's **actual command strings** via the existing `probeCommandExists`, which needs no schema change, no detector change, and no setup change. See §10 for the full review resolutions.

---

## 1. Problem

Ground truth — `styre run STYRE-1` against `styre-events` (2026-07-16): burned **seven design dispatches** (all `clean-success`), completed four design steps, then died at step 5:

```
provision: php 'composer install' exited 127: sh: composer: command not found
```

`composer` was not installed — a fact knowable at second zero. The run paid for the entire design stage to discover it.

The original ENG-332 ("move `provision` above the design dispatches") is correct but incomplete, and its headline value has been eroded by ENG-331: once an escalated run dumps and resumes, the design dispatches are journaled (`done()` is succeeded-only, `resolver.ts:25-27`) and resume re-runs only the failed step — so for **prepare-bearing** ecosystems the design spend is *deferred, not wasted*. What remains, and what this ticket targets:

1. **Fail-fast for the operator** — "install composer" at second zero, not after minutes of design work.
2. **The no-resume path (CI / fleet / ephemeral)** — where the dump is discarded and the fix is "repair the image, re-run." The OSS binary is the CI/cloud/fleet primitive.
3. **Coverage the reorder structurally cannot give.** `provision` **skips any component with no `prepare`** (`provision.ts:58`). Go and JVM components have no `prepare` (`go.ts:15`, `jvm.ts` emit only build/test commands), so the provision-first reorder does *nothing* for them — a missing `go`/`mvn` still dies at the first `verify` inside implement, after the design spend. A preflight that probes the **build/test** commands is the only thing that fails those fast.

**Honest value split (corrected after review):** the reorder (§3B) already banks the design-spend saving for prepare-bearing ecosystems, so the preflight does **not** save "4 design dispatches" over the reorder — the reviewer was right that the first draft double-counted that. The preflight's genuine, non-overlapping value is: (a) it covers go/jvm/verify-tools the reorder can't; (b) it aggregates **every** missing tool into one message where provision fails on the first `127` and makes you iterate; (c) a clean non-retry exit + no dump, versus provision's park→dump→`75` "resumable" path, which is misleading for a missing binary; (d) a PATH check is cheaper than minting a worktree and attempting a real install.

## 2. Why not just make `styre setup` ensure the environment?

Tempting — "setup should guarantee setup" — but it conflates two things:

- **The requirement** ("this repo needs composer") — a *durable repo fact*.
- **The presence** ("composer is installed *here*") — an *environment fact* about the machine that runs the work.

`styre setup` is a **describe** pass: it probes the repo and writes a *portable* `profile.json` (a versioned open-core-seam artifact). Its output travels — to CI runners, fleet workers, the commercial plane. Three structural reasons the *install* cannot move into setup:

1. **No worktree at setup time.** `styre run` mints a fresh worktree per ticket. `node_modules/` and the editable install live inside it. Setup has nothing to install into.
2. **Provision re-arms mid-run.** `resetProvisionIfManifestTouched` (`provision.ts:235-243`) reinstalls when an implement dispatch commits a manifest change — the dependency set changes *because of the work the ticket is doing*. Setup runs before any ticket.
3. **Ground truth requires the real install.** A PATH check answers "is composer present"; only running the install surfaces broken lockfiles, dead registries, version conflicts, missing system libs — and it must run against the *run's* worktree.

And the caveat that settles it: **profile.json travels; the toolchain does not.** A presence check *at setup* checks the wrong machine in the fleet model, where setup runs once (committed profile) and run executes on many ephemeral workers. So the presence check belongs at **run**, on the machine that actually executes. (This is also why the first draft's "advisory warning at setup" was cut — it fought this very argument, was a third integration point, and the run-start check already covers everything with a better message.)

## 3. Design — two parts, no new profile/setup surface

### Part A — Run-start toolchain preflight (the new gate)

**What it checks.** For each component in the profile, it probes the leading program of every command the run will execute — `prepare`, `build`, `test`, `check` — using the **existing** `probeCommandExists` (`src/setup/discover-schema.ts:55-69`), which already:
- special-cases `npm run <script>` (verifies the script exists in `package.json`, not a binary literally named "npm run"), and
- otherwise resolves the first whitespace token via `command -v`.

This is strictly more correct than a bare `Bun.which(tool)` and needs no re-parsing of compound commands (the detectors emit clean `<tool> <args>` strings; cwd is carried by `dir`, not `cd` in the command).

**Faithful, not normalized (M2).** The probe checks *exactly* the program the command will run. It must **not** be made interpreter-aware (e.g. probing `python3` when the command says `pip`): provision runs the command verbatim through `sh -c`, so if the probe and the execution disagree, the preflight either false-passes (probe `python3`, command runs `pip`, provision dies) or drifts. A faithful bare-`pip` probe correctly predicts that provision will choke. The bare-`pip`/`python` non-portability that `python.ts:22-33` emits is a *pre-existing* detector/provision issue (it would fail provision too, independent of any preflight) and is filed as a **separate follow-up** (§9), not fixed here.

**Placement — fresh-run path only.** The preflight runs in the fresh-run branch of `styre run` **after** the `--resume`/`--inspect` early-return (`run.ts:115-123`) and **before** ticket ingestion / any dispatch (realistically right after the ticket-arg check at `run.ts:125-127`). It does **not** run for `--inspect` (contracted to print diagnostics and exit 0 without running — often on a different, legitimately tool-less machine) or for `--resume`. Unlike `assertResolved` (`run.ts:86`), which checks the *machine-independent* profile and so can sit before the mode branch, the preflight is *machine-dependent* and must not gate the read-only/recovery modes.

**Resume needs no preflight.** On resume the ground-truth steps re-run and *are* the check: a provision failure re-runs provision (and worktree-resume force-re-arms it anyway, `park.ts:245-247`); a go/jvm tool gap is caught by the build/test step re-running; a paused-after-success step means the tool was present when it ran. A missing tool on resume therefore surfaces as a provision/verify escalation (park-again, exit 75, with `command not found` naming the tool) — a slightly less clean message than the fresh path's exit-69, accepted because resume is already the recovery flow.

**On a miss.** Aggregate **every** missing tool across all components into one message; each entry names the tool and the component + command that needs it (no per-tool install-hint table — bare tool names have nowhere to carry one, and inventing one was the first draft's internal contradiction). Exit **69** (`EX_UNAVAILABLE`), a **non-retry** exit that burns no dispatch attempt. **No SoT dump** — nothing has run and nothing is journaled, so the fix is a plain re-run, not `--resume`.

### Part B — Provision-first reorder (secondary, ~4 lines)

Move the `provision` block above the four design dispatches in `resolver.ts` `case "design"` (it already sits in `case "design"` at `:112-114`, just below the dispatches — the "Hoist" comment at `:110-111`; this moves it above `design:dispatch` at `:98`). This fails the *non-tool* install faults that only a real install reveals — broken lockfile, dead registry, version conflict — before the design spend, for prepare-bearing ecosystems. Safe: design commits only under `docs/plans/` (`commitScope: planScope`, `handlers.ts:394`; `planScope = isPlanPath`, `commit-scope.ts:39`), so provision cannot depend on design output — zero freshness lost. No change to the provision handler, `planProvision`, or `isComponentReady`.

### Explicitly out of the mechanism

- **No `Component.requires` field.** **No profile `schemaVersion` bump.** **No detector changes.** **No `mergeComponents` threading.** **No `styre setup` changes.** The corrected mechanism reads only the command strings already in the profile.

## 4. Data flow

```
styre setup <repo>            (UNCHANGED — no new field, no advisory)
  -> profile.json (schemaVersion 3, as today)

styre run <ticket>            (fresh-run path)
  resolve profile; assertResolved  (unchanged, machine-independent)
  --resume / --inspect ? -> early-return, NO preflight
  fresh run:
    RUN-START PREFLIGHT: for each component, probeCommandExists(prepare|build|test|check)
        any missing? -> print ALL missing (tool + component/command), exit 69, NO dump  [STOP]
        all present?  -> continue
    ingest ticket, enter design stage
    resolver: provision (now FIRST in case "design")
        real install; non-tool install faults escalate here (ENG-331 dump/resume)
    design dispatches ...       (reached only once env is sound)
```

## 5. Interfaces / boundaries

| Unit | Does what | Depends on |
| --- | --- | --- |
| `probeCommandExists(repoDir, command)` *(existing, reused)* | Resolve a command's leading program (or `npm run` script). Presence only. | `command -v`, `package.json` |
| run-start preflight *(new)* | Iterate components × {prepare,build,test,check}, call `probeCommandExists`, aggregate misses, exit 69. Fresh-run path only. | profile, `probeCommandExists` |
| provision *(unchanged)* | Real install into the worktree; ground-truth backstop; re-arms on manifest edits; the resume-path tool-check. | worktree, `profile.components` |

*Implementation note:* `probeCommandExists` currently lives in `src/setup/`. If importing it into the run/cli path crosses a layer boundary awkwardly, lift it to a neutral module (e.g. `src/dispatch/` or a shared util) shared by setup and run — a mechanical move, no behavior change.

## 6. Non-goals (do not re-litigate)

- **A `requires` field / schema bump / detector or setup changes** — rejected by review (§10); the command-probe needs none.
- **Interpreter-aware normalization of the probe** — would diverge from what provision runs (§3A, M2).
- **Version-checking tools** — provision owns "present but wrong version" via the real install (ground truth).
- **The agent-CLI probe** — ENG-326, now fully independent (§9).
- **A resume-path preflight** — the ground-truth steps re-running are the check (§3A).
- **Dump/resume of an escalated (provision) run** — ENG-331.
- **Fixing bare-`pip`/`python` portability** — separate follow-up (§9).

## 7. Testing

- Fresh-run, a component command's tool missing → exit **69**, **zero** dispatch rows, **no** dump, message lists the tool + component/command.
- Multiple missing tools → one aggregated message (not fail-on-first).
- A **go** repo missing `go` (no `prepare`) → caught by probing `go build`/`go test`; a **node** repo missing `npm` though `prepare` is `pnpm` → caught by probing `npm run …`.
- All present → run proceeds normally.
- `--inspect` on a parked dump on a tool-less machine → still exits **0**, runs no preflight.
- `--resume` runs no standalone preflight; a missing tool re-surfaces via provision/verify escalation.
- Resolver: a fresh `design`-stage ticket resolves `provision` **before** `design:dispatch`; provision reuse still holds (implement gates find it `done`); `resetProvisionIfManifestTouched` still re-arms.
- `bun run lint` + `bun test` green.

## 8. Acceptance criteria (for the rewritten ENG-332)

- [ ] `styre run` (fresh-run path only) probes each component's `prepare`/`build`/`test`/`check` tool via `probeCommandExists`, after the resume/inspect early-return and before any dispatch or ticket ingestion.
- [ ] Every missing tool is aggregated into one message; each names the tool and the component + command needing it. Exit **69**, zero dispatch rows, no SoT dump.
- [ ] go/jvm components (no `prepare`) are covered via their build/test commands (missing `go`/`mvn` caught).
- [ ] Exit code **69** is documented in the exit-code list and collides with nothing in use today (0/1/2/65/75). Final cross-command reconciliation is ENG-338's job — **not** a blocker here.
- [ ] `provision` resolves before `design:dispatch` in `case "design"`; provision reuse + manifest re-arm unregressed.
- [ ] **No** profile schema change, **no** setup change, **no** detector change.
- [ ] `--inspect` and `--resume` behavior unchanged (no preflight added to either); `--inspect` still exits 0 on a tool-less machine.
- [ ] Tests per §7; `bun run lint` + `bun test` green.

## 9. Follow-ups (filed separately, not this ticket)

- **Python bare-`pip`/`python` portability** — the detector emits non-portable `pip …`/`python …` (fails on python3-only machines) which also fails provision today; align emitted commands (or provision) with `resolvePythonInterpreter`'s `python3`-then-`python` logic (`provision.ts:180-185`).
- **Optional `styre setup` advisory** — if a same-machine "tell me at setup time" courtesy is wanted, it's a clean small ticket reusing the same probe.
- **Document / reconsider `--inspect`** — it exists in `CLAUDE.md` + `--help` but no user-facing docs; decide whether to document or retire it.
- **ENG-326 (agent-CLI preflight)** — stays separate; now fully decoupled: the corrected mechanism reuses `probeCommandExists` rather than building a generic `preflightBinary`, so ENG-326 has no build dependency on this ticket and owns its own version-aware agent-CLI check.

## 10. Adversarial review resolutions

Three independent code-grounded reviewers ran against the first draft. Key findings and how this revision resolves them:

- **Blocker — `requires`-from-`prepare` is blind to go/jvm and wrong for node** (`go.ts:15`, `jvm.ts`, `node.ts:32-34,46`). *Resolved:* dropped the field entirely; probe the actual command strings (`prepare`+`build`+`test`+`check`) via `probeCommandExists`, which covers all ecosystems.
- **Blocker/inflation — §1 double-counted the 4-dispatch saving Layer 3 already banks.** *Resolved:* §1 rewritten to the honest, non-overlapping value (go/jvm coverage, aggregation, clean exit, cheaper check).
- **Major — the "deterministic, never a silent no-op" claim was false** (zod `.default([])`; omitted `schemaVersion` rides the default past the throw). *Resolved:* no schema bump, claim removed.
- **Major — `string[]` cannot carry the promised install hint.** *Resolved:* no hint table; the message names the tool + the component/command needing it.
- **Major — `mergeComponents` would silently drop a new field** (`discover-schema.ts:24-49`). *Resolved:* no new field, so no threading needed.
- **Major — one-concern violation; ENG-332 is the repo's cited exemplar** (`ticket-template.md`). *Resolved:* mechanism simplification removed the schema/detector/setup work; the ticket is now the run-start check + the ~4-line reorder — a single concern.
- **Major — hidden ENG-326 build dependency + untested versionSpec.** *Resolved:* no shared primitive built here; ENG-326 fully independent (§9).
- **Major — setup advisory contradicts the "wrong machine" argument, not free, duplicates `probeCommandExists`.** *Resolved:* setup advisory dropped (follow-up if wanted).
- **Major — `--inspect`/`--resume` placement** (`run.ts:63,115-123`). *Resolved:* preflight is fresh-run-only; resume relies on ground-truth re-run; inspect untouched (§3A).
- **Major/M2 — bare-`pip` portability.** *Resolved:* faithful probe (must match execution); portability fix filed as a follow-up (§9).
- **Minor — exit `69` need not block on ENG-338** (only 0/1/2/65/75 in use). *Resolved:* ship 69 now, document it; reconciliation is ENG-338's job.

## 11. Refs

- Ground truth: STYRE-1 SoT — steps 1-4 `succeeded`, step 5 `provision` `failed` (`attempt=1`); `d0001`-`d0007` all `clean-success`.
- Code: `src/setup/discover-schema.ts:55-69` (`probeCommandExists` — reused); `src/setup/lang/{go,node,python,jvm,php,ruby}.ts` (command/prepare shapes); `src/dispatch/provision.ts:58,180-185,235-243` (`prepare`-skip, `resolvePythonInterpreter`, manifest re-arm); `src/daemon/resolver.ts:25-27,98,110-114` (`done`, provision block); `src/dispatch/handlers.ts:394` / `src/dispatch/commit-scope.ts:39` (design commit scope); `src/cli/run.ts:63,86,115-127` (inspect/resume branch, `assertResolved`, fresh-run seam); `src/cli/park.ts:190-196,245-247` (`--inspect` output, resume re-arm).
- Siblings: ENG-326 (agent-CLI preflight, independent), ENG-331 (dump/resume), ENG-338 (exit-code taxonomy).
