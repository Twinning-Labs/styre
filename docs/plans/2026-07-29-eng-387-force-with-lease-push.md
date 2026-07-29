# ENG-387: force-with-lease push so `--fresh` re-runs overwrite their own remote branch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the feature-branch push a `--force-with-lease` keyed to the sha styre just observed on the remote, so a `--fresh` (or any divergent) re-run cleanly overwrites `origin/<branch>` instead of failing as a non-fast-forward — while still guarding against a same-instant concurrent push (the probe→push race).

**Ownership premise (ratified — Option A):** a styre feature branch is styre-owned scratch. styre never reads the remote branch back (no `pull`/`fetch`/merge of it; every redo rebuilds off the base via `-B`), so whatever sits on the branch is discarded by the redo regardless. The lease is therefore sourced from the **live probe** of the current remote head, not from a persisted "last-pushed sha". Consequence, accepted deliberately: if something other than styre (e.g. a human pushing a fixup onto the PR branch) landed a commit while the run was idle, styre adopts that sha as the lease and overwrites it. The alternative (persist styre's own last-pushed sha and refuse when it doesn't match) would not preserve that commit into any outcome — the redo discards it anyway — it would only convert the overwrite into a hard push refusal, reintroducing exactly the re-run friction this ticket removes. So Option A is chosen with eyes open.

**Architecture:** Split the push into two seams that already exist as a pattern in this codebase. The git-CLI push (the risky, newly-conditional part) becomes an exported, unit-tested `pushBranch(repoPath, branch, expectedRemoteSha?)` in `src/dispatch/worktree.ts` — the exact sibling of the already-tested `deleteRemoteBranch` there. The GitHub adapter (`src/integrations/adapters/github.ts`) keeps its SDK-coupled probe (which already fetches the current remote head sha) and threads that sha into `pushBranch` as the lease. No core changes, no new state.

**Tech Stack:** TypeScript, Bun (`bun test`, `Bun.spawnSync`), the `git` CLI, `@octokit/rest` (adapter only), biome (lint), tsc (typecheck).

## Global Constraints

- **The lease value is the live-probed remote head, not recorded state.** `github.ts`'s push already probes `octokit.git.getRef(...)` and reads `ref.data.object.sha` — the current value of `origin/<branch>`. That sha is the lease. Do NOT introduce a persisted "last-pushed sha": it is already-fetched (no extra round-trip), and under the ratified ownership premise the branch is styre-owned scratch that the redo rebuilds regardless, so there is no non-styre commit worth persisting state to protect. The trade-off is explicit (see Ownership premise): this lease guards the same-instant probe→push race but NOT a foreign commit that predates the probe — that gets overwritten. This is a deliberate deviation from the ticket's "record the last-pushed sha" wording, ratified as Option A.
- **Force only when the remote branch exists AND diverges from the target.** First push (probe returns 404) → plain `git push` (no lease; a first-time race fails safely as non-fast-forward already). Remote already at the target sha → the existing idempotent skip (no push at all). The only path that forces is exactly the redo/divergence case — this is how the plan satisfies the ticket's "only force when it's a known redo" without any extra redo signal.
- **force-with-lease is strictly safer than plain push, never weaker.** It permits a normal fast-forward AND a divergent overwrite, but only while `origin/<branch>` still points at the leased sha; if origin advanced since the probe, the push is rejected and origin is left untouched. It is therefore correct to use it for every exists-and-differs case, not only the non-fast-forward one.
- **Locale-proof error wording — no stderr token parsing.** Whether a lease was in play is known from the arguments (`expectedRemoteSha` was defined), never by grepping git's stderr for "stale info". The lease-context error message branches on that argument, matching the locale-proof discipline established by `deleteRemoteBranch` (existence probed via exit code + empty-stdout, never stderr text).
- **The GitHub adapter's git-CLI + SDK paths stay unit-untested by convention** (the file header documents this: they need a live token + remote, covered only by the operator smoke test + typecheck + build). The new *testable* logic therefore lives in `worktree.ts`, exactly as `deleteRemoteBranch` does; `github.ts` only gains a call + a doc-comment update, verified by typecheck + build.
- Gates for every task: `bun test <file>` green, then `bun run lint` + `bun run typecheck` clean before commit.

---

## File Structure

- `src/dispatch/worktree.ts` — **add** `pushBranch(repoPath, branch, expectedRemoteSha?)`. Home of every git-CLI branch operation already (`ensureWorktree`, `commitWorktree`, `removeWorktree`, `deleteLocalBranch`, `deleteRemoteBranch`); `pushBranch` is the force-with-lease sibling of `deleteRemoteBranch`.
- `test/dispatch/worktree.test.ts` — **extend** with `pushBranch` tests, reusing the existing `makeRepoWithBareOrigin()` / `remoteHasBranch()` harness (worktree.test.ts:738-758).
- `src/integrations/adapters/github.ts` — **modify** the `push({branch, sha})` closure (lines 95-113) to thread the probed remote sha into `pushBranch`; **update** the module header prose (lines 8-10) to state the force-with-lease behavior.

**Layering note:** this adds the first `adapter → dispatch` import (`github.ts` → `dispatch/worktree.ts`). No existing adapter imports `src/dispatch/*`; today `worktree.ts`'s only importers are in `src/cli/`. It is functionally safe — no cycle (`worktree.ts` imports only `../cli/run-lock.ts`, which never reaches back to the adapter) and biome's recommended ruleset has no import-boundary rule — but it is a new edge, called out here deliberately. The "sibling of `deleteRemoteBranch`" framing is about where the *helper lives* (both are git-CLI branch ops in `worktree.ts`), not about the caller: `deleteRemoteBranch` is called from `cli/clean.ts`, whereas `pushBranch` is called from the adapter.

---

### Task 1: `pushBranch` — force-with-lease git push (unit-tested against a bare origin)

**Files:**
- Modify: `src/dispatch/worktree.ts` (add `pushBranch`, next to `deleteRemoteBranch` at ~line 459)
- Test: `test/dispatch/worktree.test.ts` (extend; reuse `makeRepoWithBareOrigin`)

**Interfaces:**
- Consumes: nothing new (uses the module's existing `Bun.spawnSync` idiom — same as `deleteLocalBranch`/`deleteRemoteBranch`).
- Produces (relied on by Task 2):
  ```ts
  /** Push `branch` to origin. When `expectedRemoteSha` is given, use --force-with-lease keyed to
   *  that sha: overwrite origin/<branch> ONLY if it still points there, so a --fresh/divergent redo
   *  cleanly replaces its own remote branch but a concurrent push by someone else is never clobbered
   *  (the push is rejected instead). When it is undefined (branch absent on the remote), a plain push.
   *  A push failure throws; the message states whether a lease was in play (locale-proof — branches on
   *  the argument, never on git's stderr text). */
  export function pushBranch(repoPath: string, branch: string, expectedRemoteSha?: string): void {
    const args =
      expectedRemoteSha === undefined
        ? ["-C", repoPath, "push", "origin", branch]
        : ["-C", repoPath, "push", `--force-with-lease=${branch}:${expectedRemoteSha}`, "origin", branch];
    const res = Bun.spawnSync(["git", ...args], { cwd: repoPath });
    if (!res.success) {
      const stderr = res.stderr.toString().trim();
      const ctx =
        expectedRemoteSha === undefined
          ? `git push failed for ${branch}`
          : `git push --force-with-lease failed for ${branch} (origin may have advanced past ${expectedRemoteSha} since styre last saw it; not overwritten)`;
      throw new Error(`pushBranch: ${ctx}: ${stderr}`.trim());
    }
  }
  ```
  Note the `--force-with-lease=<branch>:<sha>` form supplies the expected value explicitly, so it does NOT depend on a local remote-tracking ref existing (the daemon may never have fetched). The bare-origin tests below are the ground truth for this exact incantation; if the short branch name fails to match the destination ref in the test, use the fully-qualified `refs/heads/${branch}` on the left of the lease.

- [ ] **Step 1: Write the failing tests.** Append to `test/dispatch/worktree.test.ts` (after the `deleteRemoteBranch` block, ~line 800). Add `pushBranch` to the import from `../../src/dispatch/worktree.ts` (line 3-ish import block that already pulls `deleteRemoteBranch`). Reuse `makeRepoWithBareOrigin()`, `remoteHasBranch()`, and the module-level `roots` cleanup array. A small local helper reads the remote head sha:

  ```ts
  // --- ENG-387: pushBranch force-with-lease -----------------------------------------------------
  function remoteHead(repo: string, branch: string): string {
    const res = Bun.spawnSync(["git", "ls-remote", "--heads", "origin", branch], { cwd: repo });
    return res.stdout.toString().trim().split(/\s+/)[0] ?? "";
  }

  test("pushBranch: first push (no lease) creates the remote branch", () => {
    const { repo } = makeRepoWithBareOrigin();
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    run(["checkout", "-b", "feat/eng-387-a"]);
    writeFileSync(join(repo, "a.txt"), "1");
    run(["add", "-A"]);
    run(["commit", "-m", "a"]);

    expect(remoteHasBranch(repo, "feat/eng-387-a")).toBe(false);
    pushBranch(repo, "feat/eng-387-a"); // no expected sha
    expect(remoteHasBranch(repo, "feat/eng-387-a")).toBe(true);
  });

  test("pushBranch: fast-forward with a correct lease succeeds", () => {
    const { repo } = makeRepoWithBareOrigin();
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    run(["checkout", "-b", "feat/eng-387-ff"]);
    writeFileSync(join(repo, "f.txt"), "1");
    run(["add", "-A"]);
    run(["commit", "-m", "v1"]);
    pushBranch(repo, "feat/eng-387-ff");
    const v1 = remoteHead(repo, "feat/eng-387-ff");

    writeFileSync(join(repo, "f.txt"), "2"); // descends v1 → a fast-forward
    run(["add", "-A"]);
    run(["commit", "-m", "v2"]);
    pushBranch(repo, "feat/eng-387-ff", v1); // lease = the sha we last saw

    const v2 = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
    expect(remoteHead(repo, "feat/eng-387-ff")).toBe(v2);
    expect(v2).not.toBe(v1);
  });

  test("pushBranch: divergent redo with the leased sha overwrites the remote branch", () => {
    const { repo } = makeRepoWithBareOrigin();
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    // v1 pushed
    run(["checkout", "-b", "feat/eng-387-div"]);
    writeFileSync(join(repo, "d.txt"), "orig");
    run(["add", "-A"]);
    run(["commit", "-m", "v1"]);
    pushBranch(repo, "feat/eng-387-div");
    const v1 = remoteHead(repo, "feat/eng-387-div");

    // --fresh: reset the branch to base and build DIVERGENT work (does not descend v1)
    run(["reset", "--hard", "main"]);
    writeFileSync(join(repo, "d.txt"), "redone");
    run(["add", "-A"]);
    run(["commit", "-m", "v2-divergent"]);
    const v2 = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();

    pushBranch(repo, "feat/eng-387-div", v1); // lease still matches → force succeeds
    expect(remoteHead(repo, "feat/eng-387-div")).toBe(v2);
    // prove it was a real (non-fast-forward) overwrite: v2 is NOT a descendant of v1
    const isAncestor = Bun.spawnSync(["git", "merge-base", "--is-ancestor", v1, v2], { cwd: repo });
    expect(isAncestor.success).toBe(false);
  });

  test("pushBranch: a stale lease is rejected and the remote is left untouched", () => {
    const { repo, origin } = makeRepoWithBareOrigin();
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    run(["checkout", "-b", "feat/eng-387-stale"]);
    writeFileSync(join(repo, "s.txt"), "1");
    run(["add", "-A"]);
    run(["commit", "-m", "v1"]);
    pushBranch(repo, "feat/eng-387-stale");
    const v1 = remoteHead(repo, "feat/eng-387-stale");

    // A SECOND actor advances origin behind our back (clone the bare origin, push v1b).
    const other = mkdtempSync(join(tmpdir(), "styre-other-"));
    roots.push(other);
    const orun = (args: string[]) => {
      const res = Bun.spawnSync(["git", ...args], { cwd: other });
      if (!res.success) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    };
    orun(["clone", origin, "."]);
    orun(["config", "user.email", "other@styre.dev"]); // a fresh clone inherits no identity; CI has no global one
    orun(["config", "user.name", "Other"]);
    orun(["checkout", "feat/eng-387-stale"]);
    writeFileSync(join(other, "s.txt"), "other");
    orun(["add", "-A"]);
    orun(["commit", "-m", "v1b"]);
    orun(["push", "origin", "feat/eng-387-stale"]);
    const v1b = remoteHead(repo, "feat/eng-387-stale");
    expect(v1b).not.toBe(v1);

    // Our redo carries the STALE lease (v1). The lease must reject; origin stays at v1b.
    run(["reset", "--hard", "main"]);
    writeFileSync(join(repo, "s.txt"), "mine");
    run(["add", "-A"]);
    run(["commit", "-m", "v2-mine"]);
    expect(() => pushBranch(repo, "feat/eng-387-stale", v1)).toThrow(/force-with-lease/);
    expect(remoteHead(repo, "feat/eng-387-stale")).toBe(v1b); // NOT clobbered
  });
  ```
  (These tests assume `mkdtempSync`, `tmpdir`, `join`, `writeFileSync` are already imported at the top of `worktree.test.ts` — they are, from the `deleteRemoteBranch` block. Add only `pushBranch` to the worktree import.)

- [ ] **Step 2: Run the tests to verify they fail.**

  Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/eng-387 && bun test test/dispatch/worktree.test.ts`
  Expected: FAIL — `pushBranch is not exported` / `not a function` (import error) on the new cases.

- [ ] **Step 3: Implement `pushBranch`** in `src/dispatch/worktree.ts`, immediately after `deleteRemoteBranch` (~line 459), with the exact body shown in the Interfaces block above.

- [ ] **Step 4: Run the tests to verify they pass.**

  Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/eng-387 && bun test test/dispatch/worktree.test.ts`
  Expected: PASS — all four new cases green, existing cases still green. Output pristine (the stale-lease case must not leak git's rejection stderr to the test console — it is captured in the thrown Error, not written to stderr).

- [ ] **Step 5: Gates + commit.**

  ```bash
  cd /Users/rajatgoyal/code/styre/.claude/worktrees/eng-387
  bun run lint && bun run typecheck
  git add src/dispatch/worktree.ts test/dispatch/worktree.test.ts
  git commit -m "feat(push): pushBranch force-with-lease helper — divergent redo overwrites own remote branch, concurrent push protected (ENG-387)"
  ```

---

### Task 2: wire the GitHub adapter's push to the lease

**Files:**
- Modify: `src/integrations/adapters/github.ts` (the `push` closure, lines 95-113; the module header prose, lines 8-10)

**Interfaces:**
- Consumes: `pushBranch` from `../../dispatch/worktree.ts` (Task 1).
- Produces: no signature change — `ForgePort.push({branch, sha})` is unchanged; only its internals change.

This task has no unit test **by the file's own documented convention** (the git-CLI + SDK paths need a live token + remote; they are covered by the operator smoke test + typecheck + build, not `bun test`). Its deliverable is verified by `bun run typecheck` + `bun run build` and by review that the probed sha is threaded correctly. The real force-with-lease behavior is already proven by Task 1's bare-origin tests.

- [ ] **Step 1: Add the import.** At the top of `github.ts`, alongside the existing imports, add:
  ```ts
  import { pushBranch } from "../../dispatch/worktree.ts";
  ```

- [ ] **Step 2: Replace the `push` closure body** (current lines 95-113) with the lease-threading version:
  ```ts
  async push({ branch, sha }: { branch: string; sha: string }): Promise<void> {
    // Probe origin/<branch>. Three outcomes drive the push mode:
    //   • remote head === sha  → already there, nothing to do (idempotent skip).
    //   • remote head !== sha  → a divergent/ahead redo; force-with-lease keyed to THIS observed
    //                            sha so we overwrite our own branch but never a concurrent push.
    //   • 404 (no remote branch) → first push; plain, no lease.
    let expectedRemoteSha: string | undefined;
    try {
      const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      if (ref.data.object.sha === sha) return;
      expectedRemoteSha = ref.data.object.sha;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
      // 404 → expectedRemoteSha stays undefined → plain first push.
    }
    // Only the daemon's authenticated git can transfer the commit objects. Feature branch only.
    pushBranch(repoPath, branch, expectedRemoteSha);
  },
  ```

- [ ] **Step 3: Update the module header prose** (lines 8-10). Replace the sentence describing push as a plain `git push ... (probe-skipped if the remote ref is already at the target sha)` with one that also states the lease behavior, e.g.:
  > So push is a `git -C ${repoPath} push origin ${branch}` — skipped if the remote ref is already at the target sha, and a **`--force-with-lease`** keyed to the sha just probed when the remote branch exists but diverges (a `--fresh`/divergent redo cleanly overwrites its own branch; the lease still rejects a same-instant concurrent push that lands between probe and push); PRs/comments go through Octokit.

  Keep the wording faithful to the code; do not add claims the code does not make.

- [ ] **Step 4: Verify gates.**

  Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/eng-387 && bun run typecheck && bun run lint && bun run build`
  Expected: typecheck clean (the `pushBranch` import resolves, no unused `execFileSync` if it is now unreferenced — if `execFileSync` is no longer used anywhere in the file, remove its import to keep lint green; verify by searching the file for other `execFileSync` uses first — `resolveOwnerRepo` still uses it, so it stays). Lint clean. Build succeeds.

- [ ] **Step 5: Full suite + commit.**

  ```bash
  cd /Users/rajatgoyal/code/styre/.claude/worktrees/eng-387
  bun test
  git add src/integrations/adapters/github.ts
  git commit -m "feat(push): thread probed remote sha into force-with-lease push (ENG-387)"
  ```
  Expected: the full suite stays green (this task changes only the untested adapter internals; nothing else should move).

---

## Self-Review

**Spec coverage (ENG-387 description):**
- "Make the feature-branch push force-with-lease … overwrite `origin/<branch>` only if it still points at the sha styre last saw" → Task 1 `pushBranch` + Task 2 threading the probed sha. ✓
- "This lets a `--fresh` redo overwrite its own remote branch cleanly" → Task 1 divergent-redo test. ✓
- "never clobber a push from someone else" → honored for the probe→push race (Task 1 stale-lease test leaves origin at v1b); consciously NOT honored for a foreign push that predates the probe (Ownership premise, Option A). ✓ (scope narrowed and ratified)
- "`git push --force-with-lease=<branch>:<expected-remote-sha>`" → exact argv in `pushBranch`. ✓
- "fall back to `--force-with-lease` if unknown" → refined: the fallback for an unknown/absent remote is a **plain** push (404 path), because there is nothing to lease against; leasing without an expected value would consult a possibly-absent local tracking ref. Documented in Global Constraints for the reviewer. ✓
- "Consider: only force when the run is a known redo" → satisfied structurally: force happens only on exists-and-differs, which is the redo/divergence case; first-time and no-op never force. ✓
- Touchpoints `github.ts:95-113` and the `-B` worktree reset (`worktree.ts:40-60`) → the `-B` reset is the *cause* (already correct, unchanged); the fix is entirely on the push side. ✓

**Placeholder scan:** no TBDs. Every step shows real argv, real test bodies, exact commands, expected output. The one open contingency (short vs. fully-qualified refname in the lease) is decided — short name primary, FQ fallback named — with the bare-origin test as the arbiter.

**Type consistency:** `pushBranch(repoPath: string, branch: string, expectedRemoteSha?: string): void` is defined in Task 1 and called with exactly that shape in Task 2. `ForgePort.push({branch, sha})` is unchanged. The probe already yields `ref.data.object.sha: string`, matching the `expectedRemoteSha` parameter.

## Residual notes (for the human)

- **Why the lease sha comes from the live Octokit probe, not persisted state:** it is already fetched (zero extra round-trip), and it reflects the remote's *current* head, so a push that raced in during the probe→push window is caught by the lease. It does NOT protect a foreign commit that landed before the probe — styre adopts that sha and overwrites it. That is acceptable under the ratified ownership premise (styre-owned branch, rebuilt on every redo); a persisted last-pushed sha would only turn the overwrite into a hard refusal, not save the commit. This is the single intentional, ratified deviation from the ticket's "record the last-pushed sha" wording.
- **First-push races are left to plain-push semantics** (a non-fast-forward rejection), not an `expected=""` lease. A brand-new-branch collision is astronomically unlikely and already fails safely; adding an empty-lease guard would be complexity without a real scenario.
- **No core / fake-forge change:** the entire change is the real adapter's leaf push plus a `worktree.ts` helper. The fake forge used by core tests does no real git, so core behavior is unaffected; the full suite is a regression guard, not a new coverage surface.
