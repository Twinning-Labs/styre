# ENG-386 Housekeeping — `styre ls` + `styre clean` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two operator-facing housekeeping commands that complete the ENG-380 pause/resume epic: `styre ls` (list paused checkpoints) and `styre clean <ident> | --all` (reap a checkpoint + its worktree — the explicit, and only, producer of ticket status `abandoned` — and sweep stale `pr-ready` worktree leaks).

**Architecture:** A shared read-only enumeration substrate (`listCheckpoints`) walks the state dir (`~/.local/state/styre/<slug>/<ident>/run.db`) and classifies each checkpoint by inspecting its `run.db` (single-ticket SoT) plus its sidecar files and run-lock. `ls` renders the paused subset; `clean` reaps via the existing liveness-gated `reconcileWorktree` primitive, then deletes the checkpoint dir. Stale-`pr-ready` detection uses git ancestry (`git merge-base --is-ancestor <branch> <defaultBranch>`) — a precise "the PR merged" signal — because no forge merged-state API exists.

**Tech Stack:** Bun + TypeScript, `citty` subcommands, `bun:sqlite`, existing `src/dispatch/worktree.ts` / `src/cli/run-lock.ts` / `src/db/repos/*` helpers. No new runtime dependencies.

## Global Constraints

- **No schema change.** `abandoned` is already a valid `ticket.status` (`schema.sql:104-105` CHECK `('active','waiting','abandoned','done')`); `setTicketStatus` writes it with no new validation. Reuse existing repos.
- **Gates:** every task ends with `bun test`, `bun run lint` (biome), AND `bun run typecheck` (`tsc --noEmit`) all green. Typecheck is a real CI gate.
- **No new runtime dependencies.** Use `node:fs`, `bun:sqlite`, and existing helpers only.
- **Never blind-force-remove a worktree.** All worktree freeing goes through `reconcileWorktree` (liveness-gated). `clean` must refuse to touch a checkpoint whose `run.lock` is held by a *live, non-self* process (`runLockStatus`), mirroring the resume refuse.
- **Read-only enumeration must never throw on a bad checkpoint.** A malformed / half-written / schema-drifted `run.db` is skipped (best-effort), matching `priorRunIdAt`'s idiom (`park.ts:85-100`).
- **Output style:** human-readable text via the `src/cli/output.ts` `formatMessage(cmd, headline, detail?, recovery?)` house style. `ls`/`clean` are NOT telemetry-emitting runs, so their human output goes to **stdout** (unlike `run`, whose stdout is reserved for NDJSON). Errors/refusals go through `guard()` to stderr as today.
- **Command wiring:** each command is a `citty` `defineCommand` in its own file under `src/cli/`, body wrapped in `guard("<cmd>", ...)`, registered in `src/index.ts`'s `subCommands`. Args are a hand-typed interface cast from `ctx.args` (the `migrate.ts` pattern).

---

## Decisions folded into this plan (flagged for review)

These are design judgments the plan commits to; the design doc §12 left the first open. Each is called out so the plan review and the human can veto before Task 4.

1. **Stale-`pr-ready` criterion = merged-into-default (git ancestry), not age.** `git merge-base --is-ancestor <branch> <defaultBranch>` is exact: if the branch is an ancestor of the default branch the PR *did* merge, so its retained worktree is provably safe to reap. Age alone (dir mtime) would risk reaping a still-open PR that is slow in review. No forge merged-state API exists (`ForgePort` has only `push`/`ensurePr`/`addPrComment`), so ancestry is the best available signal and needs only one new local git call. **Alternative:** age-based sweep. **Recommendation: ancestry.**
2. **`styre clean --all` sweeps stale `pr-ready` leaks ONLY — it never mass-abandons paused work.** Design §3.5.1 makes abandonment a per-pause human judgment ("a pause they judge hopeless"). A single flag that abandons every paused ticket contradicts that. So `--all` reaps only merged `pr-ready` worktrees; paused checkpoints are abandoned one at a time via `clean <ident>`. **Alternative:** `--all` also abandons every paused checkpoint. **Recommendation: pr-ready-only.**
3. **`styre ls` also surfaces the stale-`pr-ready` leaks it would reap, in a second section.** So the operator previews `clean --all` before running it. The primary section is paused checkpoints (per the AC); the secondary "stale worktrees" section is advisory. **Alternative:** `ls` shows paused only. **Recommendation: include the preview section.**
4. **`clean <ident>` sets `abandoned` in the checkpoint SoT and then reaps the dir; it does NOT project `abandoned` to the issue tracker.** Tracker projection of the terminal is out of scope (design §10 doesn't call for it; it's a future seam). The local `abandoned` write satisfies "the one explicit producer of the status" and lets `clean` exit `1` (the abandoned exit code) for scripts. A checkpoint whose ticket is already `done` is reaped (worktree + dir) WITHOUT rewriting status to `abandoned` (that would be a lie). **Recommendation: as stated.**

---

## Ground truth the tasks rely on (verified against source)

- **Every run journals to `parkDir/run.db`** (live-location, ENG-382) and `finishRunResult` never deletes the dir — so the state dir accumulates `run.db` for paused, `pr-ready`, AND `done` runs. Enumeration must classify all of them.
- **Pause reason storage differs by kind:**
  - `needs_you` → `pauseTicket` sets ticket `waiting` + a pending `human_resume` signal whose `reason` is the honest-note (`pause-ticket.ts:13-19`; `run-ticket.ts:113-114,136-154`). Reason = that signal's `reason`.
  - `budget` → `dumpPark` writes `transcript.json` `{ dispatchId, cause, resetAt, ... }` (`park.ts:130-135`); ticket status is left as-is (NOT `waiting`), no signal. Reason ≈ `"out of budget"` + `resetAt`.
  - `pr-ready` (leak) → ticket `stage === "merge"` && `status !== "done"` && a pending `human_merge_approval` signal (`run-ticket.ts:115`). No `transcript.json`, no `human_resume`.
  - `done` → ticket `status === "done"`.
- **Signatures** (exact): `parkDir(slug, ident)` (`park.ts:79`), `stateDir()` (`config/paths.ts:5`), `runLockStatus(dir): {pid, self} | null` (`run-lock.ts:27`), `listPending(db, ticketId): SignalRow[]` and `SignalRow.{signal_type,reason,requested_at}` (`signal.ts:4-33`), `getTicket(db,id)` / `setTicketStatus(db,id,status)` / `TicketRow.{ident,stage,status,branch_name,branch_prefix,type_label}` (`ticket.ts`), `branchNameFor({ident,branch_name,branch_prefix})` (`branch.ts:3`), `reconcileWorktree(repoPath,branch,staleWorktreePath|undefined,newWorktreePath,checkpointDir?): {freed,skipped}` (`worktree.ts:181`), `getLatestWorktreePath(db,ticketId): string|null` (`dispatch.ts:190`), `listWorktrees(repoPath): WorktreeRecord[]` and `WorktreeRecord.{path,branch,prunable}` (`worktree.ts:112,137`), `branchHeadSha(repoPath,branch)` (`worktree.ts:247`), module-private `git(args,cwd)` (`worktree.ts:6`, throws on non-zero). Profile via `loadProfileByConvention(slug)` / `slugForCwd()` (`config/discover.ts:33,48`); `Profile.{slug,targetRepo,defaultBranch}` (`profile.ts:116`).

---

## File Structure

- **Create `src/cli/checkpoints.ts`** — the read-only enumeration substrate. `Checkpoint` type + `classifyCheckpointDb(db)` (pure-ish, testable) + `listCheckpoints(root?)` (the walk). One responsibility: turn the state dir into a typed list. Consumed by both `ls` and `clean`.
- **Create `src/cli/ls.ts`** — `lsCommand` + `lsImpl`: render the paused subset (+ stale-worktree preview) to stdout.
- **Create `src/cli/clean.ts`** — `cleanCommand` + `cleanImpl`: single-ident reap (→ `abandoned`) and `--all` stale-`pr-ready` sweep. Owns the reap primitive `reapCheckpoint(...)`.
- **Modify `src/index.ts`** — register `ls` + `clean` in `subCommands`.
- **Modify `src/dispatch/worktree.ts`** — add `isBranchMergedInto(repoPath, branch, base): boolean` (git ancestry; a non-throwing exit-code git call).
- **Tests:** `test/cli/checkpoints.test.ts`, `test/cli/ls.test.ts`, `test/cli/clean.test.ts`.

---

### Task 1: Checkpoint enumeration substrate (`listCheckpoints`)

**Files:**
- Create: `src/cli/checkpoints.ts`
- Test: `test/cli/checkpoints.test.ts`

**Interfaces:**
- Consumes: `stateDir()` (`config/paths.ts`), `runLockStatus` (`run-lock.ts`), `listPending`/`SignalRow` (`signal.ts`), `getTicket`/`TicketRow` (`ticket.ts`), `branchNameFor` (`branch.ts`), `bun:sqlite` `Database`, `node:fs` (`readdirSync`, `statSync`, `existsSync`, `readFileSync`).
- Produces:
  ```ts
  export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "done" | "other";
  export interface Checkpoint {
    slug: string;
    ident: string;
    dir: string;            // parkDir(slug, ident)
    dbPath: string;         // join(dir, "run.db")
    ticketId: number;
    status: string;         // ticket.status
    stage: string;          // ticket.stage
    branch: string;         // branchNameFor(ticket)
    kind: CheckpointKind;
    reason: string | null;  // honest-note (needs_you) / "out of budget…" / "PR open, awaiting merge" / null
    ageMs: number;          // now - run.db mtime
    live: boolean;          // runLockStatus(dir) is a live, non-self process
  }
  export function classifyCheckpointDb(db: Database): { ticketId: number; status: string; stage: string; branch: string; kind: CheckpointKind; reason: string | null } | null;
  export function listCheckpoints(root?: string): Checkpoint[];
  ```
  `listCheckpoints` walks `root ?? stateDir()`: for each entry that is a directory (skip files such as the top-level `styre.db`), treat it as a `<slug>` dir; for each sub-entry that is a directory containing `run.db`, build one `Checkpoint`. Any unreadable / malformed `run.db` is skipped (never throws). Ordering: newest-first by `ageMs` ascending is applied by callers, not here (return in walk order).

- [ ] **Step 1: Write the failing test — classification of the three pause kinds + done**

Use the real harness to produce genuine checkpoints under a temp `XDG_STATE_HOME`, then enumerate. `test/helpers/run-harness.ts` provides `runNeedsYouTicket()` (pending `human_resume`), `runParkedTicket()` (budget park with `transcript.json`), and `runFreshTicket()` (a live-location checkpoint you can drive). In `test/cli/checkpoints.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.ts";
import { openDb } from "../../src/db/client.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket, setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { listCheckpoints } from "../../src/cli/checkpoints.ts";

// Build a checkpoint dir <root>/<slug>/<ident>/run.db with a single ticket in a chosen shape.
function seedCheckpoint(
  root: string,
  slug: string,
  ident: string,
  shape: (db: Database, ticketId: number) => void,
): void {
  const dir = join(root, slug, ident);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  const projectId = insertProject(db, { slug, targetRepo: "/tmp/x", defaultBranch: "main" });
  const ticketId = insertTicket(db, { projectId, ident, title: ident });
  shape(db, ticketId);
  db.close();
  return dir;
}
```
*(Confirm the exact `insertProject`/`insertTicket` signatures in `src/db/repos/project.ts` / `ticket.ts` when writing — mirror what `test/helpers/db.ts` / `git-project.ts` already pass. If they differ, use the harness's `runNeedsYouTicket`/`runParkedTicket` instead of hand-seeding.)*

```ts
describe("listCheckpoints", () => {
  test("classifies needs_you, budget, pr-ready, and done checkpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
    try {
      seedCheckpoint(root, "proj", "ENG-1", (db, id) => {
        setTicketStatus(db, id, "waiting");
        insertPending(db, { ticketId: id, signalType: "human_resume", reason: "needs you: composer not installed" });
      });
      seedCheckpoint(root, "proj", "ENG-2", (db, id) => {
        setTicketStage(db, id, "merge");
        insertPending(db, { ticketId: id, signalType: "human_merge_approval" });
      });
      seedCheckpoint(root, "proj", "ENG-3", (db, id) => setTicketStatus(db, id, "done"));

      const found = listCheckpoints(root);
      const by = (ident: string) => found.find((c) => c.ident === ident);

      expect(by("ENG-1")?.kind).toBe("needs_you");
      expect(by("ENG-1")?.reason).toBe("needs you: composer not installed");
      expect(by("ENG-2")?.kind).toBe("pr-ready");
      expect(by("ENG-3")?.kind).toBe("done");
      expect(found.every((c) => c.live === false)).toBe(true); // no live locks in the temp tree
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/cli/checkpoints.test.ts`
Expected: FAIL — `listCheckpoints` / `src/cli/checkpoints.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/checkpoints.ts`**

```ts
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import { stateDir } from "../config/paths.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { listPending } from "../db/repos/signal.ts";
import { runLockStatus } from "./run-lock.ts";

export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "done" | "other";
export interface Checkpoint { /* …as declared in Interfaces… */ }

function singleTicketId(db: Database): number | null {
  return db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get()?.id ?? null;
}

export function classifyCheckpointDb(db: Database, dir: string) {
  const ticketId = singleTicketId(db);
  if (ticketId === null) return null;
  const t = getTicket(db, ticketId);
  if (t === null) return null;
  const branch = branchNameFor(t);
  const pending = listPending(db, ticketId);
  const humanResume = pending.find((s) => s.signal_type === "human_resume");
  const prReady = t.stage === "merge" && t.status !== "done"
    && pending.some((s) => s.signal_type === "human_merge_approval");

  let kind: CheckpointKind;
  let reason: string | null;
  if (t.status === "done") { kind = "done"; reason = null; }
  else if (humanResume) { kind = "needs_you"; reason = humanResume.reason; }
  else if (prReady) { kind = "pr-ready"; reason = "PR open, awaiting merge"; }
  else if (existsSync(join(dir, "transcript.json"))) {
    kind = "budget";
    reason = budgetReasonFrom(join(dir, "transcript.json"));
  } else { kind = "other"; reason = null; }

  return { ticketId, status: t.status, stage: t.stage, branch, kind, reason };
}

function budgetReasonFrom(transcriptPath: string): string {
  try {
    const j = JSON.parse(readFileSync(transcriptPath, "utf8")) as { resetAt?: string | null };
    return j.resetAt ? `out of budget (resets ${j.resetAt})` : "out of budget";
  } catch {
    return "out of budget";
  }
}

export function listCheckpoints(root: string = stateDir()): Checkpoint[] {
  const out: Checkpoint[] = [];
  let slugs: string[];
  try { slugs = readdirSync(root); } catch { return out; } // no state dir yet
  const now = Date.now();
  for (const slug of slugs) {
    const slugDir = join(root, slug);
    let idents: string[];
    try {
      if (!statSync(slugDir).isDirectory()) continue;
      idents = readdirSync(slugDir);
    } catch { continue; }
    for (const ident of idents) {
      const dir = join(slugDir, ident);
      const dbPath = join(dir, "run.db");
      if (!existsSync(dbPath)) continue;
      let cls: ReturnType<typeof classifyCheckpointDb> = null;
      try {
        const db = new Database(dbPath, { readonly: true });
        try { cls = classifyCheckpointDb(db, dir); } finally { db.close(); }
      } catch { continue; } // unreadable / malformed → skip
      if (cls === null) continue;
      let ageMs = 0;
      try { ageMs = now - statSync(dbPath).mtimeMs; } catch { ageMs = 0; }
      const lock = runLockStatus(dir);
      out.push({ slug, ident, dir, dbPath, ...cls, ageMs, live: lock !== null && !lock.self });
    }
  }
  return out;
}
```
*(Finalize the `Checkpoint` interface body to match. `classifyCheckpointDb` takes `dir` for the `transcript.json` probe — adjust the exported signature in Interfaces accordingly, or split the fs-probe out if the reviewer prefers a pure DB classifier; keep the DB reads pure and the fs read thin.)*

- [ ] **Step 4: Run GREEN + full gates**

Run: `bun test test/cli/checkpoints.test.ts` → PASS. Then `bun test`, `bun run lint`, `bun run typecheck` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/checkpoints.ts test/cli/checkpoints.test.ts
git commit -m "feat(housekeeping): listCheckpoints enumeration substrate (ENG-386)"
```

---

### Task 2: `styre ls`

**Files:**
- Create: `src/cli/ls.ts`
- Modify: `src/index.ts` (register `ls`)
- Test: `test/cli/ls.test.ts`

**Interfaces:**
- Consumes: `listCheckpoints`/`Checkpoint` (Task 1), `guard` (`output.ts`).
- Produces: `lsCommand` (citty) + `export async function lsImpl(opts?: { root?: string }): Promise<void>` writing a human table to **stdout**. Paused section = checkpoints with `kind` in `{needs_you, budget}`, newest-first (`ageMs` ascending); stale section = `kind === "pr-ready"`. Empty state prints a friendly line. Each paused row: `<ident>  <reason>  <age>` and a `resume: styre run --resume <ident> --slug <slug>` hint. `age` rendered via a small `humanAge(ms)` helper (e.g. `3h`, `2d`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
// …seedCheckpoint helper as in Task 1 (extract to test/helpers if duplicated)…
import { lsImpl } from "../../src/cli/ls.ts";

test("ls lists paused checkpoints with reason and resume hint", async () => {
  const root = mkdtempSync(join(tmpdir(), "styre-ls-"));
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (s: string) => { out.push(String(s)); return true; };
  try {
    seedCheckpoint(root, "proj", "ENG-1", (db, id) => {
      setTicketStatus(db, id, "waiting");
      insertPending(db, { ticketId: id, signalType: "human_resume", reason: "needs you: composer not installed" });
    });
    await lsImpl({ root });
    const text = out.join("");
    expect(text).toContain("ENG-1");
    expect(text).toContain("needs you: composer not installed");
    expect(text).toContain("styre run --resume ENG-1");
  } finally {
    (process.stdout.write as unknown) = orig;
    rmSync(root, { recursive: true, force: true });
  }
});
```
*(Mirror the stdout-capture idiom used by existing CLI tests, e.g. `test/cli/setup.test.ts`; restore in `finally`.)*

- [ ] **Step 2: Run to verify FAIL** — `src/cli/ls.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/ls.ts` + register in `src/index.ts`**

```ts
import { defineCommand } from "citty";
import { listCheckpoints } from "./checkpoints.ts";
import { guard } from "./output.ts";

function humanAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export async function lsImpl(opts: { root?: string } = {}): Promise<void> {
  const all = listCheckpoints(opts.root);
  const paused = all
    .filter((c) => c.kind === "needs_you" || c.kind === "budget")
    .sort((a, b) => a.ageMs - b.ageMs);
  const stale = all.filter((c) => c.kind === "pr-ready");

  const lines: string[] = [];
  if (paused.length === 0) lines.push("No paused checkpoints.");
  else {
    lines.push("Paused checkpoints:");
    for (const c of paused) {
      lines.push(`  ${c.ident}  [${c.kind}, ${humanAge(c.ageMs)}]  ${c.reason ?? ""}`.trimEnd());
      lines.push(`    resume: styre run --resume ${c.ident} --slug ${c.slug}`);
    }
  }
  if (stale.length > 0) {
    lines.push("");
    lines.push("Stale pr-ready worktrees (reap with `styre clean --all`):");
    for (const c of stale) lines.push(`  ${c.ident}  [${humanAge(c.ageMs)}]  ${c.reason ?? ""}`.trimEnd());
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export const lsCommand = defineCommand({
  meta: { name: "ls", description: "List paused checkpoints (ticket, reason, age, resume hint)." },
  run: () => guard("ls", () => lsImpl()),
});
```
Register in `src/index.ts`: `import { lsCommand } from "./cli/ls.ts";` and add `ls: lsCommand,` to `subCommands`.

- [ ] **Step 4: Run GREEN + full gates** (`bun test test/cli/ls.test.ts`, then `bun test`, `bun run lint`, `bun run typecheck`).

- [ ] **Step 5: Commit**

```bash
git add src/cli/ls.ts src/index.ts test/cli/ls.test.ts
git commit -m "feat(housekeeping): styre ls lists paused checkpoints (ENG-386)"
```

---

### Task 3: `styre clean <ident>` — targeted reap → `abandoned`

**Files:**
- Create: `src/cli/clean.ts`
- Modify: `src/index.ts` (register `clean`)
- Test: `test/cli/clean.test.ts`

**Interfaces:**
- Consumes: `parkDir` (`park.ts`), `runLockStatus` (`run-lock.ts`), `reconcileWorktree`/`getLatestWorktreePath`, `branchNameFor`, `getTicket`/`setTicketStatus`, profile loaders (`loadProfileByConvention`/`slugForCwd` from `config/discover.ts`), `StyreError`/`EXIT` (`errors.ts`), `guard`.
- Produces: `cleanCommand` (citty; positional `ident?`, boolean `--all`, optional `--slug`/`--profile`) + `cleanImpl(args)`. This task implements the **single-ident** path and the shared `reapCheckpoint(db|null, targetRepo, checkpoint)` helper (frees worktree + deletes dir). `--all` is Task 4.
- `reapCheckpoint(targetRepo, c)`: `reconcileWorktree(targetRepo, c.branch, getLatestWorktreePath(db, c.ticketId) ?? undefined, join(c.dir, "wt"), c.dir)` then `rmSync(c.dir, { recursive: true, force: true })`. (The `join(c.dir,"wt")` sentinel is a non-repo path used only for reconcile's in-place `=== repoPath` check — same idiom as ENG-385 Task 4.)

Single-ident `cleanImpl` flow:
1. Resolve `slug` (`args.slug ?? slugForCwd()`), `profile` (`loadProfileByConvention(slug)`), `targetRepo`.
2. `dir = parkDir(slug, ident)`; if `!existsSync(join(dir,"run.db"))` → `StyreError` "no checkpoint for `<ident>`" (exit `EXIT.USAGE` 64).
3. `const lock = runLockStatus(dir); if (lock && !lock.self)` → `StyreError` refuse "a run is in progress (pid …)" (exit 65, mirror the resume refuse code) — do NOT reap a live run.
4. Open the db read-write (`openDb(join(dir,"run.db"))`), `id = singleTicketId(db)`, `t = getTicket(db,id)`; if `t.status !== "done"` `setTicketStatus(db, id, "abandoned")`; read `getLatestWorktreePath(db,id)` (for reconcile) BEFORE closing; `db.close()`.
5. `reapCheckpoint(targetRepo, {…branch, dir, ticketId})` (reconcile + rmSync).
6. Print confirmation to stdout; set `process.exitCode = 1` (abandoned) only when a non-done ticket was abandoned — otherwise 0 (a done-checkpoint gc). *(Flag in review: is exit 1 desired for a manual clean, or always 0? Recommend exit 1 to match `abandoned`'s terminal code, but this is worth confirming.)*

- [ ] **Step 1: Write the failing test — clean abandons + frees worktree + deletes dir**

Build a checkpoint whose ticket is `waiting` and a real styre-owned worktree holding its branch (mirror `test/cli/run-live-location.test.ts`'s non-prunable-leftover construction: a temp git repo as `targetRepo`, `git worktree add -B <branch>` into a `mkdtempSync(…, "styre-wt-")` path). Assert after `cleanImpl({ ident, slug, root })`: the worktree is gone from `listWorktrees(targetRepo)`, the checkpoint dir no longer exists, and (re-reading before deletion via a spy, or asserting exit code) the ticket was set `abandoned`. Also a **refuse** test: seed a live `run.lock` (`writeFileSync(join(dir,"run.lock"), String(process.ppid))`) → `cleanImpl` refuses (exit 65), worktree + dir untouched.

*(The test must inject the state root + targetRepo. Add optional `root?`/`targetRepo?` seams to `cleanImpl` args exactly as `runImpl` exposes test seams — see `run.ts` `runImpl` optional params — rather than mutating `process.env`. Confirm the cleanest seam when writing; prefer an explicit `root`/`profile` override param over env mutation.)*

- [ ] **Step 2: Run to verify FAIL** — `src/cli/clean.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/clean.ts` (single-ident path) + register.**

Follow the flow above. `cleanCommand` args: `ident: { type: "positional", required: false }`, `all: { type: "boolean" }`, `slug: { type: "string" }`, `profile: { type: "string" }`. `run: (ctx) => guard("clean", () => cleanImpl(ctx.args as unknown as CleanArgs))`. If neither `ident` nor `--all` → `StyreError` usage (exit 64). Register `clean: cleanCommand` in `src/index.ts`.

- [ ] **Step 4: Run GREEN + full gates.**

- [ ] **Step 5: Commit**

```bash
git add src/cli/clean.ts src/index.ts test/cli/clean.test.ts
git commit -m "feat(housekeeping): styre clean <ident> reaps a checkpoint to abandoned (ENG-386)"
```

---

### Task 4: Stale `pr-ready` reap + `styre clean --all`

**Files:**
- Modify: `src/dispatch/worktree.ts` (add `isBranchMergedInto`)
- Modify: `src/cli/clean.ts` (the `--all` branch)
- Test: `test/cli/clean.test.ts` (extend), `test/dispatch/worktree*.test.ts` (extend, for `isBranchMergedInto`)

**Interfaces:**
- Produces: `export function isBranchMergedInto(repoPath: string, branch: string, base: string): boolean` — true iff `branch` is an ancestor of `base` (the PR merged). Implemented with a non-throwing exit-code git call (`git merge-base --is-ancestor <branch> <base>`; exit 0 → true, 1 → false, other → false). The existing `git()` throws on non-zero, so add a small local `gitExitCode(args, cwd): number` (via `Bun.spawnSync(...).exitCode`) or inline it — do NOT reuse `git()` here.
- `cleanImpl` `--all` branch: `listCheckpoints(root)`, filter `kind === "pr-ready"`, keep those where `isBranchMergedInto(targetRepo, c.branch, profile.defaultBranch)`, and `reapCheckpoint(targetRepo, c)` each. Report `reaped N stale pr-ready worktree(s)` (and how many merged-checks were skipped as still-open). `--all` never abandons and never touches paused checkpoints (Decision 2). Exit 0.

- [ ] **Step 1: Write the failing test — `isBranchMergedInto`**

In a temp git repo: create `main`, branch `feat/x`, commit on it, `git checkout main && git merge --no-ff feat/x` → `isBranchMergedInto(repo, "feat/x", "main")` is `true`. A second branch `feat/y` with an unmerged commit → `false`. A non-existent branch → `false`.

- [ ] **Step 2: Run FAIL** — `isBranchMergedInto` undefined.

- [ ] **Step 3: Implement `isBranchMergedInto` in `worktree.ts`.**

```ts
/** True iff `branch` is an ancestor of `base` — i.e. the branch's work is already merged into
 *  `base`, so a worktree still holding it is safe to reap. Non-throwing: a missing branch or any
 *  git error is treated as "not merged" (false). */
export function isBranchMergedInto(repoPath: string, branch: string, base: string): boolean {
  const res = Bun.spawnSync(["git", "merge-base", "--is-ancestor", branch, base], { cwd: repoPath });
  return res.exitCode === 0;
}
```

- [ ] **Step 4: Write the failing test — `clean --all` reaps merged, skips unmerged**

Two `pr-ready` checkpoints (`stage="merge"`, pending `human_merge_approval`), each with a real styre-owned worktree in the same `targetRepo`; one branch merged into `main`, one not. `cleanImpl({ all: true, slug, root, targetRepo })` → the merged one's worktree + dir are gone; the unmerged one's worktree + dir remain; no paused checkpoint is touched (add a `needs_you` checkpoint and assert it survives).

- [ ] **Step 5: Run FAIL → Implement the `--all` branch in `cleanImpl` → GREEN.**

- [ ] **Step 6: Full gates + commit**

```bash
git add src/dispatch/worktree.ts src/cli/clean.ts test/cli/clean.test.ts test/dispatch/*worktree*.test.ts
git commit -m "feat(housekeeping): styre clean --all reaps stale (merged) pr-ready worktrees (ENG-386)"
```

---

## Self-Review

**Spec coverage (ENG-386 AC + design §5/§10/§11 ticket 6):**
- `styre ls` lists paused runs with reason + resume hint → Task 2. ✓ (+ stale preview, Decision 3)
- `styre clean <ident>` abandons the ticket + frees its worktree → Task 3. ✓
- `styre clean --all` sweeps → Task 4 (stale pr-ready, Decision 2). ✓
- Stale `pr-ready` worktrees reaped → Task 4 (merged-into-default, Decision 1). ✓
- `abandoned` gets its single explicit producer → Task 3 `setTicketStatus(…, "abandoned")`. ✓
- `bun run lint` + `bun test` (+ `typecheck`) green → every task's gate. ✓

**Placeholder scan:** the "confirm when writing" notes (exact `insertProject`/`insertTicket` seed signatures in Task 1; the `cleanImpl` test-seam shape in Task 3; the `Checkpoint` interface body) each cite their source file and a concrete fallback (use the harness; mirror `runImpl`'s optional params) — grounded, not TBDs. All code steps carry real code.

**Type consistency:** `Checkpoint`/`CheckpointKind` defined in Task 1 and consumed unchanged by Tasks 2–4; `reapCheckpoint`/`cleanImpl` introduced in Task 3 and extended in Task 4; `isBranchMergedInto` added in Task 4 with the signature Task 4's `--all` uses. `reconcileWorktree` 5-arg form and `branchNameFor({ident,branch_name,branch_prefix})` match their real signatures (verified).

## Residual open questions (for the human)

- **Decision 1–4 above** — the flagged choices (merged-vs-age staleness; `--all` scope; `ls` stale-preview section; `clean` exit code + not projecting `abandoned` to the tracker).
- **`done` checkpoint garbage** — every `done` run also leaves a `run.db` in the state dir forever (live-location never deletes on success). This plan does NOT gc them (out of the AC's "stale pr-ready" wording). Worth a follow-up: `clean --all` (or a `--done` sweep) could also reap merged/`done` checkpoint dirs. Flagged, not built.
- **`interrupted` pauses** — a crashed live-location run leaves `run.db` with no `human_resume`, no `transcript.json`, ticket not `done` → classified `"other"` by Task 1, so `ls` won't show it as paused. If interrupted checkpoints should appear in `ls`, Task 1 needs an explicit `interrupted` heuristic (e.g. a `running` step present). Noted; not built (matches the epic's "interrupted has no automated fixture" caveat).
