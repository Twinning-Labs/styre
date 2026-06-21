# M4a — Ground-Truth Verify Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `verify` stage real — the daemon runs the project profile's ground-truth commands (build/test/lint) per work-unit (S3) and at integration (S4), records the result as a `ground_truth_signal`, and **gates the step on that result** (a non-pass fails the step).

**Architecture:** Verify steps are **daemon-run, not agent dispatches** — they do NOT go through `runAgentDispatch`, get no agent capability, and never commit (verification is read-only against the worktree the implement dispatch already committed). A new `runCommand` utility spawns the profile command under a timeout; the `verify:check` (S3) and `verify:integration` (S4) handlers run it, write a `ground_truth_signal` row, and **throw on a non-pass result** so `advanceOneStep`'s failure path routes it through the existing failure-policy. Both handlers register in `buildDispatchRegistry` (the resolver already routes to handler keys `verify:check` and `verify:integration`).

**Tech Stack:** Bun (1.3.5), `bun:sqlite`, `bun test`, Biome, `Bun.spawn`.

## Global Constraints

- **Ground truth gates the step** (move 5): the step's success must reflect the real build/test exit code — `verify:check`/`verify:integration` throw when the result is not `pass`. No self-report.
- **Verify is daemon-run, read-only, no agent** (move 4 / B2): no `runAgentDispatch`, no `AgentRunner`, no allowlist, no commit. The daemon runs the command and writes the DB; nothing else writes the DB.
- **Ground-truth results go in `ground_truth_signal`, NOT the `signal` table.** The `signal` table is for durable waits (human gates + external polling); `ground_truth_signal.signal_type` carries the check-type run.
- **Provider-agnostic stays intact:** verify touches none of `src/agent/*` — no Claude/model reference anywhere in this milestone.
- **Timestamps stored UTC** via `nowUtc()` (already used by every repo).
- **Bun conventions:** `.ts` import extensions; `import type` for type-only imports; double quotes; semicolons; 2-space indent / 100-col; no non-null assertions; `noUnusedLocals`/`noUnusedParameters`; Biome `organizeImports` (run `bun run lint`; apply `./node_modules/.bin/biome check --write .` if flagged).
- **Full gate before every commit:** `bun test && bun run lint && bun run typecheck` all clean (the M0–M3b suite — 129 tests — stays green).
- **Conventional Commits.** Branch `feat/m4-verify-real` only — never `main`, no push, no PR (the operator opens/merges).

## Explicitly DEFERRED to M4b (do NOT build these here)

- Behavioral A1 gate (behavioral unit's test check requires a test file in the implement diff).
- `scope_diff` advisory signal.
- Failure-policy **route discrimination** (I3 build-red / I4 tests-red / I5 no-test / I6 infra-retry) — M4a relies on the **existing generic** verify loopback in `failure-policy.ts` (verify step with a `work_unit_id` → loop the unit back to `pending`).
- N1 (integration failure → ticket-scoped `reconcile` work-unit) — in M4a a failing `verify:integration` falls through to the existing generic retry; that is acceptable for M4a.
- **Pass-aware re-verify / stale-signal clearing on loopback** — `nextUnrunCheck` treats any signal row (pass *or* fail) as "run", so the *full* fail→fix→re-verify cycle is not yet correct. M4a covers the happy path end-to-end and asserts a failing check fails the step; the re-verify-after-fix cycle (clearing the unit's stale `ground_truth_signal` rows on loopback) is **M4b**.
- Loopback `standard→deep` wiring — M4b.
- The `is_authoritative` / `dispatch_id` columns on `ground_truth_signal` (CI arbiter / agent-verify) — not needed until M6/M5; leave NULL/default.

## File Structure

- **Create `src/util/run-command.ts`** — `runCommand(command, {cwd, timeoutMs})`: async profile-command runner (`Bun.spawn ["sh","-c",command]`, kill-on-timeout with a `didTimeout` flag, captured stdout/stderr/exitCode). One responsibility: run one shell command and report ground-truth exit state.
- **Modify `src/db/repos/ground-truth-signal.ts`** — add the `command` column to `GroundTruthSignalRow`, `COLS`, and `insertSignal` (records which profile command produced the signal — load-bearing for verify auditability).
- **Modify `src/dispatch/handlers.ts`** — register `verify:check` (S3) and `verify:integration` (S4) in `buildDispatchRegistry`; add a small `worktreeFor(ctx, deps)` helper (resolves repo path + worktree path + branch for a daemon-run step) and a `VERIFY_TIMEOUT_MS` constant.
- **Create `test/util/run-command.test.ts`**, **`test/dispatch/verify-handlers.test.ts`**, **`test/dispatch/verify-e2e.test.ts`** — unit + handler + cross-stage e2e coverage.
- **Untouched:** `src/daemon/resolver.ts` (already routes verify correctly), `src/daemon/failure-policy.ts` (generic verify loopback suffices for M4a), `test/daemon/walking-skeleton.test.ts` (uses its own mock registry to test routing — intentionally left mocked).

---

### Task 1: `runCommand` profile-command runner

**Files:**
- Create: `src/util/run-command.ts`
- Test: `test/util/run-command.test.ts`

**Interfaces:**
- Consumes: nothing (leaf utility).
- Produces:
  - `interface CommandResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }`
  - `runCommand(command: string, opts: { cwd: string; timeoutMs: number }): Promise<CommandResult>` — runs `sh -c <command>` in `cwd`; on timeout sets `timedOut: true`, kills the process, and returns `exitCode: null`.

- [ ] **Step 1: Write the failing test** — `test/util/run-command.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/util/run-command.ts";

const cwd = mkdtempSync(join(tmpdir(), "styre-cmd-"));

test("captures stdout and a zero exit on success", async () => {
  const r = await runCommand("echo hello", { cwd, timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.stdout.trim()).toBe("hello");
});

test("reports a non-zero exit on failure", async () => {
  const r = await runCommand("exit 3", { cwd, timeoutMs: 5000 });
  expect(r.exitCode).toBe(3);
  expect(r.timedOut).toBe(false);
});

test("kills and flags a command that exceeds the timeout", async () => {
  const r = await runCommand("sleep 5", { cwd, timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).not.toBe(0);
});

test("runs the command in the given cwd", async () => {
  const r = await runCommand("pwd", { cwd, timeoutMs: 5000 });
  expect(r.stdout.trim()).toBe(cwd);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/util/run-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/util/run-command.ts'`.

- [ ] **Step 3: Create `src/util/run-command.ts`**

```ts
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one shell command in `cwd` under a timeout, capturing ground-truth exit state.
 *  Daemon-only: used by the verify steps to run the project-profile commands (B2). The
 *  `didTimeout` flag is set in the kill callback so a true timeout is never confused with
 *  a command that merely exited non-zero. */
export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stdout, stderr, timedOut };
  } catch (err) {
    clearTimeout(timer);
    return { exitCode: null, stdout: "", stderr: String(err), timedOut };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/util/run-command.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/util/run-command.ts test/util/run-command.test.ts
git commit -m "feat(m4a): runCommand profile-command runner (timeout + capture)"
```

---

### Task 2: record the profile `command` on `ground_truth_signal`

**Files:**
- Modify: `src/db/repos/ground-truth-signal.ts`
- Test: `test/db/repos/ground-truth-signal.test.ts`

**Interfaces:**
- Consumes: the existing `ground_truth_signal` table (`command TEXT` column already exists in `schema.sql` — this only wires it through the repo).
- Produces:
  - `GroundTruthSignalRow` gains `command: string | null`.
  - `insertSignal(db, p)` gains optional `p.command?: string` (stored; defaults to NULL).
  - `listByUnit` unchanged in signature (now returns the `command` field too).

- [ ] **Step 1: Write the failing test** — `test/db/repos/ground-truth-signal.test.ts`

```ts
import { expect, test } from "bun:test";
import { insertSignal, listByUnit } from "../../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertSignal persists and reads back the profile command", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const row = insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    command: "bun test",
  });
  const back = listByUnit(db, unit.id);
  db.close();
  expect(row.command).toBe("bun test");
  expect(back[0]?.command).toBe("bun test");
});

test("command defaults to null when omitted", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const row = insertSignal(db, { ticketId, workUnitId: unit.id, signalType: "test", result: "pass" });
  db.close();
  expect(row.command).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/db/repos/ground-truth-signal.test.ts`
Expected: FAIL — `row.command` is `undefined` (not in `GroundTruthSignalRow`/`COLS`/insert).

- [ ] **Step 3: Edit `src/db/repos/ground-truth-signal.ts`**

Add `command` to the interface (after `result`):

```ts
export interface GroundTruthSignalRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  signal_type: string;
  result: string;
  command: string | null;
  detail_json: string | null;
  measured_at: string;
}
```

Update `COLS` to include `command`:

```ts
const COLS =
  "id, ticket_id, work_unit_id, signal_type, result, command, detail_json, measured_at";
```

Add `command` to the `insertSignal` param type and the INSERT (insert the column + bind it):

```ts
export function insertSignal(
  db: Database,
  p: {
    ticketId: number;
    workUnitId?: number | null;
    signalType: string;
    result: string;
    command?: string;
    detail?: unknown;
  },
): GroundTruthSignalRow {
  const res = db
    .query(
      `INSERT INTO ground_truth_signal (ticket_id, work_unit_id, signal_type, result, command, detail_json, measured_at)
       VALUES ($t, $wu, $type, $result, $command, $detail, $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $type: p.signalType,
      $result: p.result,
      $command: p.command ?? null,
      $detail: p.detail === undefined ? null : JSON.stringify(p.detail),
      $now: nowUtc(),
    });
  const created = db
    .query<GroundTruthSignalRow, [number]>(`SELECT ${COLS} FROM ground_truth_signal WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertSignal: row missing after insert");
  }
  return created;
}
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/db/repos/ground-truth-signal.test.ts && bun test`
Expected: PASS (2 new tests); full suite green (the added column is additive — existing `insertSignal` callers omit `command`, which defaults to NULL).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/ground-truth-signal.ts test/db/repos/ground-truth-signal.test.ts
git commit -m "feat(m4a): record profile command on ground_truth_signal"
```

---

### Task 3: `verify:check` handler (S3) — per-work-unit ground truth

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/verify-handlers.test.ts`

**Interfaces:**
- Consumes: `runCommand` (Task 1); `insertSignal` (Task 2); `ensureWorktree` (`worktree.ts`); `getProject` (`project.ts`); `branchNameFor` (`branch.ts`); `Profile.commands` (`profile.ts`); `HandlerContext` (`step-registry.ts`); `advanceOneStep` (`advance.ts`) for the test.
- Produces (in `handlers.ts`): a registered `verify:check` handler; a `worktreeFor(ctx, deps)` helper returning `{ repoPath: string; worktreePath: string; branch: string }`; a `VERIFY_TIMEOUT_MS` constant.

**Behavior:** the step key is `verify:wu{seq}:{checkType}` — the check-type is the last `:`-segment. The handler ensures the ticket worktree exists (the implement dispatch already created + committed it), resolves `profile.commands[checkType]`, runs it via `runCommand`, writes a `ground_truth_signal` (with `command`), and **throws if the result is not `pass`** (so the step fails → failure-policy). A missing command for the check-type → an `error` signal + throw.

- [ ] **Step 1: Write the failing test** — `test/dispatch/verify-handlers.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { getById as getUnit, insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-vfy-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

/** Build a registry whose profile maps the given check-type commands; FakeAgentRunner is unused
 *  by verify steps but RegistryDeps requires it. */
function registryFor(repo: string, commands: Record<string, string>) {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vfywt-")),
  });
}

/** Put the ticket in implement with one unit already 'verifying' and a worktree present
 *  (verify reads the committed worktree the implement dispatch would have made). */
function seedVerifying(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, projectId: number, repo: string, registry: ReturnType<typeof registryFor>) {
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  setUnitStatus(db, unit.id, "verifying");
  return unit;
}

test("a passing check records a pass signal (with command) and the step succeeds", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { test: "true" });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  const step = getByKey(db, ticketId, "verify:wu1:test");
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(sigs[0]?.signal_type).toBe("test");
  expect(sigs[0]?.result).toBe("pass");
  expect(sigs[0]?.command).toBe("true");
  expect(step?.status).toBe("succeeded");
});

test("a failing check records a fail signal and fails the step (→ failure-policy loops the unit back)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { test: "false" });
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  const step = getByKey(db, ticketId, "verify:wu1:test");
  const after = getUnit(db, unit.id);
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(sigs[0]?.result).toBe("fail");
  expect(step?.status).toBe("pending"); // failure-policy reset
  expect(after?.status).toBe("pending"); // generic verify loopback reset the unit
});

test("a missing profile command records an error signal and fails the step", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, {}); // no 'test' command
  const unit = seedVerifying(db, ticketId, projectId, repo, registry);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = listByUnit(db, unit.id);
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(sigs[0]?.result).toBe("error");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/verify-handlers.test.ts`
Expected: FAIL — `advanceOneStep` throws / returns unexpectedly because no `verify:check` handler is registered (`StepRegistry.resolve` returns undefined → advance throws "no handler").

- [ ] **Step 3: Edit `src/dispatch/handlers.ts`** — add imports, the helper, the constant, and the handler

Add these imports (Biome will order them; keep value vs `import type` correct):

```ts
import { ensureWorktree } from "./worktree.ts";
import { insertSignal } from "../db/repos/ground-truth-signal.ts";
import { runCommand } from "../util/run-command.ts";
```

Add the constant near `DESIGN_TIMEOUT_MS`/`DEFAULT_TIMEOUT_MS`:

```ts
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
```

Add a daemon-step worktree helper (next to `depsFor`):

```ts
/** Resolve the repo + ticket worktree + branch for a DAEMON-run step (verify). Unlike
 *  `depsFor` this carries no agent capability — verify only reads the committed worktree. */
function worktreeFor(
  ctx: HandlerContext,
  deps: RegistryDeps,
): { repoPath: string; worktreePath: string; branch: string } {
  const project = getProject(ctx.db, ctx.ticket.project_id);
  if (!project) {
    throw new Error(`handler: project ${ctx.ticket.project_id} not found`);
  }
  return {
    repoPath: project.target_repo,
    worktreePath: join(deps.worktreeRoot, ctx.ticket.ident),
    branch: branchNameFor(ctx.ticket),
  };
}
```

Register `verify:check` inside `buildDispatchRegistry` (after the `implement:dispatch` registration, before `return registry;`):

```ts
registry.register("verify:check", async (ctx: HandlerContext) => {
  if (ctx.workUnitId === null) {
    throw new Error("verify:check: missing workUnitId");
  }
  const checkType = ctx.step.step_key.split(":").pop() ?? "";
  if (checkType === "") {
    throw new Error(`verify:check: cannot parse check-type from '${ctx.step.step_key}'`);
  }
  const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
  ensureWorktree(repoPath, branch, worktreePath);

  const command = deps.profile.commands[checkType];
  if (command === undefined) {
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: checkType,
      result: "error",
      detail: { reason: `no profile command for check-type '${checkType}'` },
    });
    throw new Error(`verify:check: no profile command for '${checkType}'`);
  }

  const run = await runCommand(command, { cwd: worktreePath, timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS });
  const result = run.exitCode === 0 ? "pass" : run.timedOut ? "error" : "fail";
  insertSignal(ctx.db, {
    ticketId: ctx.ticket.id,
    workUnitId: ctx.workUnitId,
    signalType: checkType,
    result,
    command,
    detail: { exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr.slice(0, 2000) },
  });
  if (result !== "pass") {
    throw new Error(`verify:check ${checkType}: ${result} (exit ${run.exitCode})`);
  }
  return { check: checkType, result };
});
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/verify-handlers.test.ts && bun test`
Expected: PASS (3 tests); full suite green.

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/verify-handlers.test.ts
git commit -m "feat(m4a): real verify:check handler (S3) — daemon-run ground truth"
```

---

### Task 4: `verify:integration` handler (S4) — ticket-level ground truth

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/verify-handlers.test.ts` (append to the Task 3 file)

**Interfaces:**
- Consumes: same as Task 3 (`runCommand`, `insertSignal`, `worktreeFor`, `ensureWorktree`).
- Produces (in `handlers.ts`): a registered `verify:integration` handler that runs the profile's `build` then `test` commands (those that are declared) at the branch worktree, writes ONE `ground_truth_signal` with `signal_type = "integration"`, and throws if any ran command did not pass.

**Behavior:** run the declared `build` and `test` profile commands in order; the integration result is `pass` only if every command that ran exited 0; the first non-pass short-circuits to a fail/error integration signal + throw. The signal's `work_unit_id` is NULL (ticket-level). If neither `build` nor `test` is declared, record an `error` integration signal + throw (nothing to verify).

- [ ] **Step 1: Write the failing tests** — append to `test/dispatch/verify-handlers.test.ts`

```ts
/** Drive a ticket whose units are all verified to the verify:integration step. */
function seedAllVerified(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, projectId: number, repo: string) {
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  setUnitStatus(db, unit.id, "verified");
}

test("verify:integration passes when build and test pass, recording an integration signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { build: "true", test: "true" });
  seedAllVerified(db, ticketId, projectId, repo);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const step = getByKey(db, ticketId, "verify:integration");
  const sigs = db
    .query("SELECT signal_type, result FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'")
    .all(ticketId) as Array<{ signal_type: string; result: string }>;
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(sigs[0]?.result).toBe("pass");
});

test("verify:integration fails the step when a command fails", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  const registry = registryFor(repo, { build: "true", test: "false" });
  seedAllVerified(db, ticketId, projectId, repo);

  const outcome = await advanceOneStep(db, ticketId, registry);
  const sigs = db
    .query("SELECT result FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration'")
    .all(ticketId) as Array<{ result: string }>;
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(sigs[0]?.result).toBe("fail");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/verify-handlers.test.ts`
Expected: FAIL — no `verify:integration` handler registered (advance throws "no handler").

- [ ] **Step 3: Edit `src/dispatch/handlers.ts`** — register `verify:integration`

Add after the `verify:check` registration, before `return registry;`:

```ts
registry.register("verify:integration", async (ctx: HandlerContext) => {
  const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
  ensureWorktree(repoPath, branch, worktreePath);

  const commands = (["build", "test"] as const)
    .map((key) => ({ key, command: deps.profile.commands[key] }))
    .filter((c): c is { key: string; command: string } => c.command !== undefined);

  if (commands.length === 0) {
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "integration",
      result: "error",
      detail: { reason: "no build/test profile command declared" },
    });
    throw new Error("verify:integration: no build/test profile command declared");
  }

  const ran: Array<{ key: string; exitCode: number | null; timedOut: boolean }> = [];
  let result: "pass" | "fail" | "error" = "pass";
  let lastCommand = "";
  for (const { key, command } of commands) {
    lastCommand = command;
    const run = await runCommand(command, { cwd: worktreePath, timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS });
    ran.push({ key, exitCode: run.exitCode, timedOut: run.timedOut });
    if (run.exitCode !== 0) {
      result = run.timedOut ? "error" : "fail";
      break;
    }
  }

  insertSignal(ctx.db, {
    ticketId: ctx.ticket.id,
    signalType: "integration",
    result,
    command: lastCommand,
    detail: { ran },
  });
  if (result !== "pass") {
    throw new Error(`verify:integration: ${result}`);
  }
  return { integration: result };
});
```

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/verify-handlers.test.ts && bun test`
Expected: PASS (5 tests in the file now); full suite green.

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/verify-handlers.test.ts
git commit -m "feat(m4a): real verify:integration handler (S4)"
```

---

### Task 5: cross-stage e2e (implement → verify → verified) + full gate

**Files:**
- Create: `test/dispatch/verify-e2e.test.ts`

**Interfaces:**
- Consumes: `buildDispatchRegistry`; `advanceOneStep`; `FakeAgentRunner`; `getById as getUnit` (`work-unit.ts`); `parseProfile`; repos. No new production code — if a bug surfaces in an owning module, STOP and report it (don't patch the test around it).

**Behavior:** prove the real handlers chain through the resolver: a `FakeAgentRunner` implements one unit (writes a file so the implement diff is non-empty, daemon commits), then the real `verify:check` runs a passing profile command, and the resolver marks the unit `verified`. Drive multiple `advanceOneStep` calls until the unit reaches `verified`.

- [ ] **Step 1: Write the e2e test** — `test/dispatch/verify-e2e.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ve2e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

test("implement then real verify:check drives a work-unit to verified", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });

  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-ve2ewt-")),
  });

  // Tick the resolver until the unit is verified (implement:dispatch → verify:wu1:test → mark-verified).
  for (let i = 0; i < 6; i++) {
    if (getUnit(db, unit.id)?.status === "verified") break;
    await advanceOneStep(db, ticketId, registry);
  }
  const finalUnit = getUnit(db, unit.id);
  db.close();
  expect(finalUnit?.status).toBe("verified");
});
```

- [ ] **Step 2: Run the e2e**

Run: `bun test test/dispatch/verify-e2e.test.ts`
Expected: PASS. If it stalls or a handler throws unexpectedly, STOP and report which module is at fault — do NOT loosen the assertion or patch around a real bug.

- [ ] **Step 3: Run the FULL gate**

Run: `bun test && bun run lint && bun run typecheck && bun run build && ./dist/styre --version`
Expected: full suite green (M0–M3b + all M4a tests), Biome clean, `tsc --noEmit` exit 0, binary builds and prints its version.

- [ ] **Step 4: Commit**

```bash
git add test/dispatch/verify-e2e.test.ts
git commit -m "test(m4a): implement→verify e2e drives a work-unit to verified"
```

---

## M4a acceptance criteria

- [ ] A daemon `runCommand` runs a profile command in the worktree under a timeout, capturing exit code + stdout/stderr (timeout flagged distinctly from a non-zero exit).
- [ ] `ground_truth_signal` records the profile `command` that produced each signal.
- [ ] `verify:check` (S3) runs `profile.commands[checkType]` per check-type, writes a `ground_truth_signal`, and **throws on a non-pass result** (ground truth gates the step); a missing command → `error` signal + throw.
- [ ] `verify:integration` (S4) runs the declared `build`+`test` commands at the branch worktree, writes one `integration` signal, throws on non-pass.
- [ ] Both handlers registered in `buildDispatchRegistry`; a failing verify routes through the existing generic failure-policy (verify-with-unit → loop the unit back to `pending`).
- [ ] e2e: `implement:dispatch` (fake agent) → real `verify:check` → resolver marks the unit `verified`.
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean; binary builds.
- [ ] No change to `src/agent/*` (provider-agnostic intact); verify performs no commit and uses no agent capability.

## Out of scope (M4b and later)

- Behavioral A1 gate · `scope_diff` advisory · failure-policy route discrimination (I3/I4/I5/I6) · N1 integration→reconcile-unit · pass-aware re-verify + stale-signal clearing on loopback · loopback `standard→deep` wiring → **M4b**.
- CI checks-system / `external_checks` polling (`merge:await-checks`) → **M6** (merge).
- `is_authoritative` / `dispatch_id` columns wired through the repo → when CI (M6) / agent-verify needs them.
