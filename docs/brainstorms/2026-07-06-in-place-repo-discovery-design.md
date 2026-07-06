# Path-free disposable wiring — repo-root discovery + fixed-path marker for `--in-place`

**Status:** Design (brainstorm output) — design settled through extended operator dialogue; approved to write up. Independent review next, then plan. An increment **on top of** the in-place execution work (PR #52).
**Date:** 2026-07-06
**Scope:** make `styre run --in-place` (and `styre setup`) **path-free** in a disposable container: styre **discovers** the repo root instead of being told, and the disposability signal moves to a **fixed container-root marker** (`/.styre-disposable`) — retiring the bench-specific detached-HEAD heuristic. **Does NOT** change the in-place *mechanics* (the `worktreePath===repoPath` seam, the resume derivation) — those shipped in #52; this changes only *how the repo root is resolved* and *the safety gate*.
**Builds on:** PR #52 (in-place execution — the flag, the seam, `assertInPlaceSafe`/`assertInPlaceIdentity`, resume). This **modifies** #52's `assertInPlaceSafe` gate and adds discovery.
**CLAUDE.md invariants:** capability isolation (move 4); single transactional writer (B2); config precedence (per-ticket > workspace > profile > defaults).

---

## 0. Why (what #52 leaves on the table)

#52 makes in-place *work*, but it still assumes the repo path is already correct — it reads `profile.targetRepo` (recorded by `styre setup <repo>`). Two problems for a disposable container:

1. **The caller must know/compute the repo path** to run `styre setup <repo>` — but a disposable container is *purpose-built to hold one repo*; asking the caller to compute the path styre is sitting inside is redundant.
2. **#52's safety gate accepts a detached HEAD**, which is a **SWE-bench artifact** (it checks out a base *commit* → detached). A normal disposable container does `git clone` → lands on a *named* branch, so detached-HEAD both misses the common case and could false-pass a developer mid-`bisect`. The real disposability signal should be explicit, not a HEAD-state heuristic.

The insight that resolves both: **a purpose-built image already encodes where the code is, as its `WORKDIR`**, and `docker run`/`docker exec` apply `WORKDIR` as the process cwd automatically. So styre launched by a harness already has its cwd inside the repo — it can *discover* the root rather than be told.

---

## 1. `--in-place` ⇒ discover; otherwise require the path

Couple discovery to the flag (both are consequences of the one premise "I am running inside the disposable checkout"):
- **`--in-place` set:** styre **discovers** the repo root (§2); no path required.
- **`--in-place` absent:** the path must come from the profile (`styre setup <repo>`), as today; error if unresolved.

This is a clean binary — the removed combinations ("explicit path *and* in-place", "discover *but* worktree") aren't useful.

---

## 2. Two-tier repo-root resolution (in-place)

Resolve `repoRoot`, in order:
1. **cwd git toplevel:** `git rev-parse --show-toplevel` from styre's cwd. For a purpose-built image this succeeds — docker set cwd = `WORKDIR` = the code checkout. **The common, zero-config path.**
2. **Marker-carried path (fallback):** if (1) fails (cwd not in a git repo — e.g. an odd `WORKDIR`, or an interactive/sshd launch that lands in `$HOME`), read the **contents** of `/.styre-disposable`; if non-empty, use that path (and validate it *is* a git repo via `git -C <path> rev-parse --show-toplevel`).
3. **Neither → hard error:** `--in-place: no git repo at the working directory and no path in /.styre-disposable`.

*(styre cannot read the image's `WORKDIR` as separate metadata from inside the container — there is no in-container API for it; by run time it has already been applied as cwd, so "read cwd" IS reading the applied WORKDIR. The marker fallback covers the cases where cwd wasn't set to the repo.)*

---

## 3. The disposability marker — fixed container path, dual role

`/.styre-disposable` at the **container root** (a fixed path — the writer needs *no* repo-root knowledge, resolving the operator's "bench shouldn't have to figure out the path" concern):
- **Presence** = "this container is throwaway" — the disposability declaration (container-scoped, which is semantically correct: disposability is a property of the *container*, not the repo).
- **Contents** (optional) = the repo-root path, used only as the §2.2 discovery fallback.

The bench/CI wiring becomes path-aware in exactly **one** trivial place, and only if it wants the fallback:
```
touch /.styre-disposable                 # empty: rely on WORKDIR/cwd discovery
# or, belt-and-suspenders:
echo /testbed > /.styre-disposable       # also carry the path for the fallback
styre run --in-place                     # no path on the styre CLI
```

---

## 4. Safety gate rework (modifies #52's `assertInPlaceSafe`)

Replace #52's `(detached-HEAD OR marker) AND tracked-clean` with:

> **`--in-place` refused unless `/.styre-disposable` exists AND `repoRoot` has no un-committed *tracked* work** (`git status --porcelain --untracked-files=no` empty).

- **Drop detached-HEAD entirely** (§0 — a bench artifact, unreliable as a general signal, both misses and false-passes).
- The **fixed-path marker** is now the sole disposability signal — a deliberate, system-level "everything here is throwaway" declaration nobody sets on a real workstation by accident (needs write at container `/`).
- Keep the **tracked-dirty** refusal (`--untracked-files=no`, so the editable env's `.so`/`.egg-info` residue doesn't false-refuse).
- Keep the **loud banner** on entry: `IN-PLACE: mutating <repoRoot> on branch <branch>`.

Combined with the explicit `--in-place` flag, that is a two-independent-signal gate (image-declared marker + invocation-declared flag) plus the active-work guard.

---

## 5. The single override point (route the discovered path everywhere)

`profile.targetRepo` is the **one** source the repo path flows from (verified): `insertProject` sets `project.target_repo` from it (`run-ticket.ts:98`), the forge/checks adapters read `profile.targetRepo` directly (`ports.ts:23,26`), and the preflight reads it (`run.ts:76-77`). So the override is a single assignment:

> when `--in-place`, set `profile.targetRepo = repoRoot` (§2) **before** `insertProject`/ports/preflight run.

Then dispatch (`project.target_repo` → `worktreeFor`), the forge, and the preflight all use the discovered root consistently — no split.

---

## 6. `styre setup` path-free too

`setup`'s `repo` is a required positional (`setup.ts:185`). Make it **optional**: when omitted, default `repoDir = git rev-parse --show-toplevel` of cwd (the same discovery as §2.1); error if cwd isn't a git repo. So an in-container flow is fully path-free:
```
styre setup && styre run --in-place
```
`setup` still does its real job — probing manifests to find each component's **code dir** (`component.dir`, relative to root) + commands. Discovery only supplies the *root*; the profile still supplies *where the code is within it* and *how to build/test it*. (This is why `run --in-place` still needs a profile.)

---

## 7. Identity assertion → belt-and-suspenders

#52's `assertInPlaceIdentity` (fail fast if the env's `<pkg>` isn't installed under `target_repo`) was load-bearing *because a told path could be wrong*. With discovery, `repoRoot` **is** the checkout styre runs in — the same one the container's editable env was built against — so the mismatch can't arise by construction. Keep the assertion (cheap; still catches a genuinely broken image whose env points elsewhere), but it is now defense-in-depth, not the primary guard.

---

## 8. Invariants / safety

- **Capability isolation:** unchanged; the discovered `repoRoot` is the writable surface, bounded by the (marker-declared) disposable container. The gate is the strongest local check; isolation beyond it remains delegated to the container contract (as #52 §7).
- **Fail-safe direction:** every unresolved/ambiguous case errors (no repo found, no marker, tracked-dirty) — never a silent mutate.
- **Config precedence:** the `--in-place` discovery override sits at the invocation layer (above the profile), consistent with per-ticket > profile precedence.

---

## 9. Risks / open questions

1. **★ Resume path-consistency.** On `--resume`, `inPlace` is derived from the DB (`project.target_repo`, #52 §5), so dispatch is consistent — but the **forge** reads `profile.targetRepo` (`ports.ts`), which on a reloaded profile is the *un-overridden* value. In a disposable/bench run the forge is likely moot (the harness extracts the result locally, no PR), but the plan must either re-apply the §5 override on resume or confirm the forge path is unused in-place. Name it, don't assume.
2. **★ `WORKDIR` ≠ code dir.** Discovery assumes cwd is inside the repo. True for purpose-built images (WORKDIR = checkout) launched via `docker run`/`exec`; false for an odd `WORKDIR`, or interactive sshd (lands in `$HOME`). The §2.2 marker-path fallback + the §2.3 hard error cover these — but the plan should test the fallback, not just the happy path.
3. **Multiple git repos in one container.** cwd discovery yields exactly one root (whichever cwd sits in); if a container holds several, the marker-path (or the launch cwd) disambiguates. Out of scope to auto-resolve; document that in-place = one repo per container.
4. **Marker contents hygiene.** The marker path is operator/image-supplied (not agent-controlled), but it's interpolated into a `git -C <path>` call — validate it resolves to a real git repo before use (§2.2), and never pass it unquoted.
5. **Sequencing vs #52.** #52 isn't merged; this modifies its `assertInPlaceSafe`. If #52 merges first, this is a clean follow-up; else it stacks. The plan targets post-#52 main.

---

## 10. Evidence

- **Setup takes a required path:** `src/cli/setup.ts:185` (`repo: { type: "positional", required: true }`), `:92` `repoDir = resolve(args.repo)`.
- **Single override point:** `profile.targetRepo` → `insertProject` (`run-ticket.ts:98` `targetRepo: deps.profile.targetRepo`) → `project.target_repo`; forge/checks read `profile.targetRepo` directly (`ports.ts:23,26`); preflight reads it (`run.ts:76-77`).
- **#52's gate to modify:** `assertInPlaceSafe` in `src/dispatch/in-place.ts` (detached-OR-marker + tracked-dirty).
- **Docker mechanics (external):** `docker run`/`exec` apply the image `WORKDIR` as the process cwd; sshd instead uses `$HOME` — hence the cwd-then-marker fallback.

## 11. Changelog
- *2026-07-06 (v1)* — first spec of path-free disposable wiring: `--in-place` implies two-tier repo-root discovery (cwd git-toplevel via WORKDIR, then `/.styre-disposable` marker contents, then hard error); disposability marker moves to the fixed container path `/.styre-disposable` (dual role: presence = gate, contents = path fallback); **detached-HEAD dropped** from the gate (bench artifact); single `profile.targetRepo` override routes the discovered root everywhere; `styre setup` repo arg made optional-with-discovery; identity assertion demoted to belt-and-suspenders. Named the resume forge-path consistency + WORKDIR-≠-code-dir risks.
