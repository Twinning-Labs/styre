# The file-disposition model — one page

**Status:** reference / consolidation (precursor to the scope-guard-disposition brainstorm)
**Date:** 2026-07-19
**Why this exists:** the rules for "which files an agent dispatch is allowed to leave behind" were
built up across four brainstorms (ENG-296 / 297 / 300 / 323) and now live scattered across
`commit-scope.ts`, `check-path.ts`, `run-dispatch.ts`, `worktree.ts`, and two prompt files. Nobody can
hold the whole thing in their head. This page states the *current* model and the failure taxonomy we
have *actually observed*, so the redesign starts from ground truth, not memory.

---

## 1. The model today: an agent must sort every file into one of three buckets

When a write-capable dispatch finishes, styre looks at every file that dispatch created or changed and
decides whether to **commit it, drop it, or reject the whole attempt.** The agent is expected to have
pre-sorted its files into three buckets:

| Bucket | Where it goes | What styre does | Taught in |
|---|---|---|---|
| **Deliverable** | declared in the sidecar (`new_files` / `checksAuthored[].test_file`), or a canonically-named check, or an admitted support file | committed | the step's prompt |
| **Throwaway** | a `styre_scratch/` folder (any depth) | **swept** (deleted) before the guard ever runs | `implement.md`, `checks.md` only |
| **Anything else** (a stray new file) | loose in the work tree | **rejects the whole attempt** → loopback → retry budget | (only the *consequence* is taught) |

The third row is the problem. A new file that lands in neither of the first two buckets is treated as a
scope violation.

## 2. The guard: per-step `commitScope`, "reject-not-drop"

The gate is `commitScope` on a dispatch spec (`run-dispatch.ts:190-207`). It runs **after** the scratch
sweep (`run-dispatch.ts:173`) and **after** pre-existing untracked cruft is excluded — so it judges only
files *this* dispatch created. If any judged file is out of scope, styre reverts the attempt, marks the
dispatch `dispatch-failed`, and throws `out-of-scope files (declare them... or delete them if they are
throwaway/debug files): <paths>`. That throw routes through `failure-policy.ts` → `resetToPending` →
**retry** (bounded by `maxAttempts` → escalate on exhaustion).

**"Reject-not-drop" is a deliberate decision**, stated in code: `commit-scope.ts:16-18` — *"any new file
is out of scope (→ reject-and-retry, **never a silent drop**; the retry-feedback nudges the agent to
declare it or delete it)."* The 2026-07-15 scratch brainstorm chose it explicitly ("guard untouched,
respects reject-not-drop"). Overturning it is the central question of the next brainstorm.

### The five scope-gated write steps (this is cross-cutting, not checks-only)

| Step | Scope factory | New-file rule |
|---|---|---|
| `implement` | `implementScope` | new file must be in `new_files`; else reject. Malformed sidecar ⇒ **reject all** new files. |
| `checks:dispatch` | `checksScopeFor` | new file must be declared, canonical `{ident}_ac{id}_test.*`, or a `styre_checks/` support file; else reject. Malformed sidecar ⇒ **defer (allow all)**. |
| checks re-author | `checksScopeFor([acId])` | same, scoped to one AC. |
| `plan` (design) | `planScope` | everything must be under `docs/plans/`. |
| `docs:revise` | `docScope` | everything must be under `docs/`. |

Two things to notice: (a) `implement` and `checks` both hard-reject stray new files, so the disposition
problem is not unique to checks; (b) they disagree on the malformed-sidecar case (implement rejects all,
checks defers to allow-all) — an existing inconsistency.

## 3. The accretion pattern (why this keeps growing)

The allow-list is a whitelist that has needed one new clause per legitimate file shape:

- **ENG-296** — recognize the canonical check filename regardless of committed path.
- **ENG-297** — pin real checks into `styre_checks/`.
- **ENG-300** — the scratch drawer + sweep (`styre_scratch/` deleted before the guard).
- **ENG-323** — auto-admit support files (`__init__.py`, `conftest.py`) inside `styre_checks/` next to a
  canonical test (`check-path.ts:88-110`; four conditions, cap of 2 per dir).

Each shipped because a real run hit a file shape the whitelist didn't cover. This is the treadmill the
operator flagged: "we seem to be discovering scenarios every run."

## 4. Failure taxonomy — what we have actually observed

Grounded in the SMOKE=2 × (5 darkreader + 5 astropy) batch:

| Class | Meaning | Status | Evidence |
|---|---|---|---|
| **needed-support** | the check needs a helper (`__init__.py`/`conftest.py`) to run | **FIXED** by ENG-323 | `__init__.py` now passes the gates; darkreader 5/5 pass |
| **throwaway-loose** | the agent wrote a scratch/debug file loose in the tree instead of `styre_scratch/` | **LIVE — the failure we are here for** | 3 astropy runs failed this way → scope reject → loopback → retry budget exhausted |
| **source-smuggle** | the agent edits tracked source (or adds a real source module) inside a tests-only step | **the guard's actual job** — never observed failing, but it is *why* the guard exists | — |

The decisive fact: the throwaway-loose failures happened **even though `checks.md` already tells the agent
to use `styre_scratch/`** (`checks.md:40-48`). The convention is in the forward prompt and the agent
ignored it. So the mechanism depends on the agent *voluntarily complying with a folder convention*, and
agents do not reliably comply.

## 5. Two invariants we want to hold (from the operator, 2026-07-18)

Neither is fully honored today; both are inputs to the redesign:

- **INV-A — conventions live in forward prompts, uniformly, for every write-capable agent.** Today the
  `styre_scratch/` convention is only in `implement.md` and `checks.md`; the re-author, `plan`, and
  `docs` write steps don't teach it.
- **INV-B — failure feedback identifies *why it failed*, and nothing else.** It must not carry standing
  conventions or load-bearing instructions. Today the rejection message editorializes ("...or delete
  them if they are throwaway/debug files"), which is an instruction, not a diagnosis — and a dangerous
  one, since the feedback cannot know whether the rejected file was throwaway or genuinely needed.

## 6. The open question (for the next brainstorm)

**Should the guard *reject* an undeclared new file, or *discard* it — and what is the guard's actual
job?** A stray new untracked file is, by construction, not an edit to tracked source. If the guard's real
job is to stop *source-smuggle* (edits to tracked files / new real modules in a tests-only step), then
rejecting *every* undeclared new file is over-broad, and the whole `styre_scratch/` convention exists to
paper over rejections the guard itself creates. The alternative — commit the deliverable set, **discard**
stray new files, reject only tracked-source edits — would delete the throwaway-loose failure class and
make the convention non-load-bearing (a stronger form of INV-A). Its cost: it overturns reject-not-drop,
and needed-support files must still survive (so some ENG-323-style logic stays). That trade is what the
brainstorm decides.

---

## Pointers

- **Code:** `src/dispatch/commit-scope.ts` (the five scopes), `src/dispatch/check-path.ts` (allow-list
  clauses), `src/dispatch/run-dispatch.ts:170-220` (sweep → guard → reject/commit), `src/dispatch/worktree.ts:209-244`
  (`sweepScratch`), `src/dispatch/handlers.ts` (wiring: 252, 395, 534, 576, 930), `src/daemon/failure-policy.ts`
  (retry routing), `prompts/checks.md:40-48` + `prompts/implement.md:24-28` (scratch guidance).
- **Prior designs (the scattered lore this consolidates):**
  `docs/brainstorms/2026-07-15-scratch-drawer-design.md` (ENG-300),
  `docs/brainstorms/2026-07-15-checks-implement-prompt-hardening-design.md`,
  `docs/brainstorms/2026-07-16-checks-support-files-design.md` (ENG-323),
  and their plans under `docs/plans/`.
