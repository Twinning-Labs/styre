# Path-free disposable wiring — repo-root discovery + repo-scoped marker for `--in-place`

**Status:** Design v3 (brainstorm output) — v2 corrected the v1 marker-at-`/` hole; v3 folds in the v2 re-review (resume disposability gap + honest "declaration not proof" framing). Part of the in-place execution work (**PR #52**); this is the discovery/gate increment, not a separate PR.
**Date:** 2026-07-06
**Scope:** make `styre run --in-place` (and `styre setup`) **path-free at the CLI** in a disposable container by **discovering** the repo root (cwd/`WORKDIR`), while keeping the disposability signal **repo-scoped** (a marker *inside* the repo). **Does NOT** change the in-place mechanics (the `worktreePath===repoPath` seam, resume derivation) already in #52; changes only repo-root resolution + the safety gate + `setup`.
**Builds on / modifies:** #52's `assertInPlaceSafe` (`src/dispatch/in-place.ts`), `run.ts` preflight, `park.ts` resume, `setup.ts`.
**CLAUDE.md invariants:** capability isolation (move 4); single transactional writer (B2).

---

## 0. Why (what #52 leaves, and what v1 got wrong)

#52 makes in-place *work* but still needs the repo path set via `styre setup <repo>`; and its gate accepts a **detached HEAD**, which is a SWE-bench artifact (it checks out a base *commit*), not a general "disposable" signal. So two goals: **discover** the repo (don't make the caller pass it), and use a **reliable** disposability signal.

**v1 mistake (caught by review):** v1 moved the marker to the container root `/.styre-disposable`. That is **unsafe** — "the container is disposable" ≠ "the repo is disposable." A marker at `/` vouches for the *container*, but `git checkout -B`/commits mutate the *repo*, and those decouple exactly where real source enters a container: **bind mounts, named volumes, `docker commit`ed layers**. Example: `docker run -v $PWD:/testbed <image-with-/.styre-disposable> styre run --in-place` — marker present, flag present, freshly-mounted clone tracked-clean → styre commits into the host's real repo through the mount. **v2 fixes this: the disposability marker must be a property of the mutated bytes — i.e. inside the repo.**

The path-free-CLI goal is met by **discovery**, not by the marker's location.

---

## 1. `--in-place` ⇒ discover; otherwise require the path

- **`--in-place` set:** styre **discovers** the repo root (§2); the CLI needs no path.
- **`--in-place` absent:** the path comes from the profile (`styre setup <repo>`), as today; error if unresolved.

Clean binary — the removed combinations ("explicit path *and* in-place", "discover *but* worktree") aren't useful.

---

## 2. Repo-root resolution (in-place) — cwd only, fail closed

Resolve `repoRoot = git rev-parse --show-toplevel` from styre's cwd. For a purpose-built image this is the checkout — `docker run`/`docker exec` apply the image `WORKDIR` as the process cwd, so a harness-launched styre already sits inside the repo. **If it fails (cwd not in a git repo) → hard error** (`--in-place: no git repo at the working directory; launch with WORKDIR / docker -w set to the checkout`).

**No marker-carried-path fallback** (v1 had one; review F2/F3 killed it): a path read from a marker (a) reintroduces "operate on a repo cwd isn't in" and (b) can disagree with the gate (marker validates repo A, cwd-discovery mutates repo B). Discovery is cwd-only; the marker is a *presence* signal inside the discovered repo (§3), never a path source. (Implementation: the git wrappers throw, so tier-1 is a `try/catch` around a new small `discoverRepoRoot()` helper — the existing `worktree.ts` `git()` is private and throws.)

---

## 3. The disposability marker — inside the repo (repo-scoped)

`<repoRoot>/.styre-disposable` — a marker **at the discovered repo root**, checked *after* discovery:
- **Presence** = "this checkout is throwaway." Repo-scoped, so it vouches for the actual mutated bytes.
- **Robust against bind mounts by construction:** a bind mount *overlays* the repo dir, so an image-baked `<repo>/.styre-disposable` is hidden by the mount, and a developer's real checkout won't contain one — **only a genuinely disposable, image-built checkout shows the marker.** (Contrast v1's `/.styre-disposable`, which a base image or a colliding tool could carry regardless of what's mounted at the repo.)

Placement is trivial for whoever built the disposable checkout — they know where the code is (it's `/testbed` by SWE-bench convention, or `$WORKDIR` in a Dockerfile): `touch $REPO/.styre-disposable` at image build. styre finds the repo via discovery and checks the marker inside it, so **nothing is passed on the CLI**.

---

## 4. Safety gate (rework of #52's `assertInPlaceSafe`)

> **`--in-place` refused unless `<repoRoot>/.styre-disposable` exists AND `repoRoot` has no un-committed *tracked* work** (`git status --porcelain --untracked-files=no` empty).

- **Drop detached-HEAD** (§0 — a bench artifact). The repo-scoped marker is the general signal, so dropping detached-HEAD leaves a *repo-scoped* signal intact (the v1 danger was dropping detached-HEAD *and* moving the marker off the repo — v2 keeps the marker on the repo).
- **Tracked-dirty** refusal kept (`--untracked-files=no`, so the editable env's `.so`/`.egg-info` residue doesn't false-refuse).
- **Loud banner** on entry: `IN-PLACE: mutating <repoRoot> on branch <branch> (HEAD <sha>)`.
- Gate reads marker **presence**; §2 never reads marker *contents* — one role, no A-vs-B disagreement.

---

## 5. Single override point — and re-apply it on resume

`profile.targetRepo` is the one source the path flows from (`insertProject`→`project.target_repo`; forge/checks via `ports.ts`; the preflight). `Profile` is a plain mutable object and the *same* instance reaches ports (`run.ts:102`) and `runTicket`/`insertProject` (`run.ts:119`), so **one assignment** routes the discovered root everywhere on the fresh-run path:

> `profile.targetRepo = repoRoot` inside the `--in-place` preflight block (`run.ts:72-78`), after discovery, before ports/registry/runTicket.

**Resume path-routing (review + feasibility MUST):** the preflight block is skipped on resume (`!args.resume`), and `resumeRun` rebuilds forge ports from the *un-overridden* profile (`park.ts:263`) — while `styre run`'s terminal state is *PR-ready*, so the forge **does** run. Fix: in `resumeRun`, `if (inPlace) profile.targetRepo = project.target_repo;` (the value is already read at `park.ts:184`) before ports are built. So both paths route the discovered root consistently.

**Resume disposability re-check (v3, adversarial F1 — MUST):** the fresh-run gate (`assertInPlaceSafe`) is deliberately skipped on resume, and the identity assertion (§7) returns early for a **non-python** repo (`in-place.ts:51-52`) — so a non-python in-place repo currently resumes with **no disposability check at all**, then `checkout -B`s + commits against `project.target_repo`. That is a clobber path. Fix: on an in-place resume, re-check **marker presence** (`<repoRoot>/.styre-disposable`) — a cheap, **language-agnostic**, repo-scoped check that is still valid mid-run (the marker is a file, unaffected by the branch/commits the run made). Do **not** re-run the tracked-dirty half on resume (the run's own in-progress commits legitimately dirty the tree mid-run); **presence** is the resume gate. This makes §8's "no marker → refuse" true on the resume path too.

---

## 6. `styre setup` — path-free, but with the SAME gate

`setup`'s `repo` positional (`setup.ts:185`) becomes **optional**: when omitted, `repoDir = discoverRepoRoot(cwd)` (§2). But setup runs **agent enrichment with repo write** (`setup.ts:98,102`) — so no-arg discovery must **also require the disposability gate** (review F5, else a stray `styre setup` points an agent-with-write at whatever repo cwd sits in, with no guard; the headless approval at `setup.ts:157` runs *after* enrichment, too late):

> no-arg `setup` refused unless `<repoRoot>/.styre-disposable` exists (same repo-scoped marker). An explicit `setup <repo>` keeps today's behavior (the operator named the target).

`setup` still probes manifests for each component's **code dir** (`component.dir`) + commands — discovery only supplies the *root*.

---

## 7. Identity assertion — stays load-bearing

#52's `assertInPlaceIdentity` is **kept load-bearing** (not demoted — v1's "mismatch impossible by construction" was wrong, review F4): a **symlinked `WORKDIR`** makes `git rev-parse --show-toplevel` return the realpath while `pip install -e` may have recorded the symlink path — a real divergence the assertion catches. Discovery *narrows* the mismatch (the told-path case is gone); it does not eliminate it. Keep the per-component check exactly as #52 ships it.

**But it is python-only** (`in-place.ts:51-52` returns early with no python components), so it is **not** a general safety backstop — the language-agnostic disposability guard is the marker (§4 fresh-run, §5 resume re-check), not this.

---

## 8. Invariants / safety

- **The gate now guards the mutated object.** The disposability signal (repo-scoped marker) + tracked-dirty are both properties of `repoRoot` itself — not the container — so the common misuse (a bind-mounted real repo whose mount hides any image-baked marker) is refused, not clobbered.
- **Fail-closed on the checks styre can make:** no repo at cwd → error; no marker → refuse (fresh run AND resume, §5); tracked-dirty → refuse; setup no-arg without marker → refuse.
- **Honest limit — the marker is a *declaration*, not *proof* (adversarial F2).** Presence of `<repo>/.styre-disposable` is a file, and anything that can write the repo dir (a committed file, a devcontainer hook, a CI step, a `docker cp`, a seeded named volume) can plant it — which is exactly the party styre is about to grant repo-write. So the marker + the explicit `--in-place` flag + tracked-dirty are strong **defense-in-depth against *misuse*** (a mistaken `--in-place` on a real checkout won't have all three), but **not a cryptographic guarantee** against a container deliberately/accidentally set up to carry the marker on real bytes. Ultimate disposability remains the **caller's container contract** — the same honest stance #52 §7 takes for isolation. (A stronger, non-forgeable signal — verifying `repoRoot` sits on the container's own ephemeral overlay, not a host mount — was considered and **deferred**; operator chose the simple marker for now. See §9.)
- **Capability isolation** unchanged; the discovered `repoRoot` is the writable surface, bounded by a checkout the marker (inside it) *declares* throwaway.

---

## 9. Risks / open questions

1. **`WORKDIR` ≠ code dir / not set.** Discovery needs cwd inside the repo — true for purpose-built images via `WORKDIR` + `docker run/exec`; false for an odd `WORKDIR` or an sshd launch ($HOME). v2 **fails closed** (hard error) rather than guessing; the caller sets `WORKDIR`/`-w`. The plan should test the error path.
2. **★ The marker is forgeable by any repo-dir writer (adversarial F2/F3).** Presence is a plain file, so besides a *committed* `.styre-disposable`, a devcontainer hook / CI step / `docker cp` — or an **empty named volume mounted over the image path, which copies the image's contents (marker included) into the volume on first use** — can carry it onto real bytes (the mount-overlay defense holds for *bind* mounts specifically, not all mount types). Accepted for now (operator: keep the simple marker) as **misuse defense, not proof** (§8). Doc guidance: `.styre-disposable` should be `.gitignore`d and image-created, never committed. **Deferred stronger option:** verify `repoRoot` is on the container's own ephemeral overlay (not a host mount) via `/proc/self/mountinfo` — non-forgeable, but Linux-specific and may false-refuse volume-mounted CI; revisit if the misuse bar proves insufficient.
3. **★ Override-or-throw ordering (plan invariant, feasibility F4).** The gate's safety depends on discovery **overriding** `profile.targetRepo` before the gate runs and **hard-erroring** on discovery failure — if the `try/catch` around `discoverRepoRoot()` swallows a failure and falls through, the gate silently validates the profile's *stale* `targetRepo` (a different repo than cwd). Likewise the `setup` marker gate must sit **inside `runSetup` before the enrichment agent** (`setup.ts:98,102`), not merely in the citty wrapper. The plan must encode both as ordering invariants with explicit error-path tests.
4. **Symlinked WORKDIR** (§7) — handled by keeping the identity assertion; plan should include a symlink test.
5. **Multiple repos in one container** — cwd discovery yields the one repo cwd sits in; document in-place = one repo per container.
6. **Nit (F5):** `lstat` the marker to require a regular file (`existsSync` follows a symlinked/dir `.styre-disposable`); and log a discovered-vs-profile `targetRepo` mismatch (the override silently wins — an operator who pointed `--profile` at the wrong project gets only the §4 banner).
7. **Sequencing vs #52** — this lives on the #52 branch; it modifies `assertInPlaceSafe` from #52 directly (same PR).

---

## 10. Evidence

- **Setup required path / agent enrichment:** `setup.ts:185` (`repo` required positional), `:92` resolve+existsSync, `:98,:102` probe + agent enrichment (repo write), `:157` post-enrichment approval.
- **Single override point:** `profile.targetRepo` → `insertProject` (`run-ticket.ts:98`) → `project.target_repo`; forge/checks read `profile.targetRepo` (`ports.ts:23,26`); preflight (`run.ts:76-77`). `Profile` is a plain mutable zod object (`profile.ts:117`, no freeze); same instance to ports (`run.ts:102`) + runTicket (`run.ts:119`).
- **Resume gap:** `resumeRun` builds ports from `profile.targetRepo` (`park.ts:263`); preflight skipped via `!args.resume` (`run.ts:72`); `project.target_repo` available at `park.ts:184`.
- **Gate to modify:** `assertInPlaceSafe` (`in-place.ts:24-35`) — detached-OR-marker(at repo root `:26`) + tracked-dirty. v2: marker-presence(at repo root) + tracked-dirty, drop detached.
- **No `--show-toplevel` helper exists** — new `discoverRepoRoot()`; existing `worktree.ts` `git()` is private + throws.

## 11. Changelog
- *v1 → v2 (2026-07-06, post 3-lens review):* **reverted the marker to the repo root** (`<repoRoot>/.styre-disposable`) — v1's container-`/` marker can't vouch for a bind-mounted/volume/committed repo (review F1/F2/F3: "container disposable ≠ repo disposable"). **Dropped the marker-carried-path fallback** (F2/F3 — presence-gate-vs-contents-path disagreement, cross-repo trap); discovery is now **cwd-only, fail-closed**. **`setup` no-arg now requires the same repo-scoped marker** before running its write-capable enrichment agent (F5). **Kept the identity assertion load-bearing** and corrected §7's false "impossible by construction" (F4 — symlinked WORKDIR). **Re-apply the discovered override on resume** (feasibility — the forge runs on the PR-ready path and reads the un-overridden profile). Discovery (cwd/WORKDIR) retained — it, not the marker location, is what makes the CLI path-free.
- *v2 → v3 (2026-07-06, post v2 re-review — confirmed v2 closes v1's central hole):* **resume now re-checks marker presence** (adversarial F1 — a non-python in-place repo previously resumed with *zero* disposability check; the python-only identity assertion is not a general backstop). **Honest framing** (F2): the marker is **defense-in-depth against misuse, not proof** — forgeable by any repo-dir writer (committed file / devcontainer hook / CI step / **named-volume population**); "fail-closed everywhere" / "by construction" over-claims corrected to match #52 §7's "caller's container contract" stance. **Named-volume caveat** added (F3 — an empty named volume copies image contents, marker included). **Override-or-throw + setup-gate-before-enrichment** promoted to plan ordering invariants with error-path tests (F4). **Nit** (F5): `lstat` the marker as a regular file; log discovered-vs-profile mismatch. **Deferred:** the non-forgeable overlay-vs-mount check (operator: keep the simple marker for now).
