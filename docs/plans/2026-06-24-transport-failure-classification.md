# Transport-Failure Cause Classification (ENG-164) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify a dispatch death into a provider-neutral cause (session-limit / out-of-credits / transient) and route each correctly — resumable park for quota/billing pauses (no attempt burned), bounded retry for transient — with a `styre run --resume` that rehydrates from a durable dump and carries the interrupted agent's context forward.

**Architecture:** The Claude adapter (the only code that knows provider marker strings) sets a neutral `cause` on `AgentRunResult`. `runAgentDispatch` routes park-causes by throwing a typed `ParkSignal` that propagates *past* the journal's `markFailed` (so the step stays `running` and no attempt is consumed) and is caught in `advanceOneStep`, which records the park in the SoT and returns a `parked` outcome. The CLI dumps the SoT + transcript to an XDG state dir and exits `75`; `--resume` reopens it, lets the existing `recover()` reset the interrupted step, and re-dispatches it with an advisory transcript-carryover block. A HEAD guard protects against branch drift, with `--accept-head` / `--inspect` escape hatches.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, `citty` (CLI), `zod` (telemetry schema), `bun test`.

## Global Constraints

- **Provider-agnostic core.** Marker strings live ONLY in `src/agent/providers/claude.ts`. The core routes on the neutral `FailureCause` enum. A provider that never sets `cause` defaults to `transient`.
- **Dual schema files.** Any `schema.sql` change edits BOTH copies: `src/db/schema.sql` (authoritative, loaded) AND `docs/architecture/schema.sql` (doc). See `[[styre-dual-schema-files]]`.
- **Single transactional SoT; only the daemon writes it.** Park state changes go through the existing repos in a transaction.
- **Durable journal = exactly-once + crash-resume.** Park reuses the `running` + `recover()` shape; succeeded steps never re-run.
- **Ground truth over self-report.** Transcript carryover is an advisory prompt hint only — never a verdict or score.
- **Dev workflow.** Never commit to `main`. Work on branch `feat/eng-164-transport-failure-classification` (already created). PR-only; operator merges. Run `bun test` before each commit; the repo uses biome for format/lint.
- **Timestamps:** store UTC via `nowUtc()`; the `resetAt` value carried for session-limit is the provider's raw human reset text (display-only — see Task 1 note), not a normalized ISO instant.

---

## File Structure

**New files**
- `src/engine/park-signal.ts` — `ParkSignal` class + `ParkInfo` type (leaf module; no deps beyond the `FailureCause` type).
- `src/cli/park.ts` — CLI-side park dump + resume orchestration helpers (keeps `run.ts` thin).
- `test/agent/providers/classify-failure.test.ts`
- `test/dispatch/park-routing.test.ts`
- `test/daemon/park-propagation.test.ts`
- `test/cli/park-resume-e2e.test.ts`
- `test/cli/head-guard-e2e.test.ts`

**Modified files**
- `src/agent/runner.ts` — `FailureCause`, `cause`/`resetAt` on `AgentRunResult`.
- `src/agent/providers/claude.ts` — `classifyFailure()`; set `cause`/`resetAt`.
- `src/db/schema.sql` + `docs/architecture/schema.sql` — `event_log.kind` += `parked`.
- `src/db/repos/event-log.ts` — `payload_json` column support on `appendEvent` + `EventLogRow`.
- `src/telemetry/events.ts` + `src/telemetry/emitter.ts` — surface `payload_json` on the `event` telemetry record.
- `src/dispatch/run-dispatch.ts` — route `cause`; throw `ParkSignal`; transcript-carryover prepend; `resumeContext` on `DispatchDeps`.
- `src/dispatch/handlers.ts` — thread `resumeContext` from `RegistryDeps` through `depsFor`.
- `src/engine/step-journal.ts` — let `ParkSignal` bypass `markFailed`.
- `src/daemon/advance.ts` — catch `ParkSignal`; record park; `parked` `AdvanceOutcome`.
- `src/daemon/loop.ts` — surface `parked` from `tick`.
- `src/daemon/run-ticket.ts` — `parked` `RunOutcome`; `park` on `RunResult`; catch in `driveToTerminal`.
- `src/dispatch/worktree.ts` — export `branchHeadSha()`.
- `src/cli/run.ts` — `--resume` / `--accept-head` / `--inspect`; park-dump on parked outcome; exit codes.

---

## Task 1: Provider-neutral `FailureCause` + Claude classifier

**Files:**
- Modify: `src/agent/runner.ts`
- Modify: `src/agent/providers/claude.ts`
- Test: `test/agent/providers/classify-failure.test.ts`

**Interfaces:**
- Produces: `type FailureCause = "session-limit" | "out-of-credits" | "transient"`; `AgentRunResult.cause?: FailureCause`; `AgentRunResult.resetAt?: string | null`; `classifyFailure(stderr: string, stdout: string): { cause: FailureCause; resetAt: string | null }`.

**Note on `resetAt`:** the provider emits a human string like `resets 11:10pm (Asia/Calcutta)`. Reliable conversion to a UTC ISO instant is not feasible from that text, so `resetAt` carries the **raw reset substring for display only**. (This is a deliberate, surfaced narrowing of the spec's "UTC ISO" wording; structured normalization is a future enhancement, not silently dropped.)

- [ ] **Step 1: Write the failing test**

Create `test/agent/providers/classify-failure.test.ts`:

```ts
import { expect, test } from "bun:test";
import { classifyFailure } from "../../../src/agent/providers/claude.ts";

test("session-limit marker is classified with the reset text", () => {
  const r = classifyFailure("You've hit your session limit · resets 11:10pm (Asia/Calcutta)", "");
  expect(r.cause).toBe("session-limit");
  expect(r.resetAt).toContain("11:10pm");
});

test("out-of-credits / billing marker is classified", () => {
  expect(classifyFailure("Error: insufficient credit balance", "").cause).toBe("out-of-credits");
  expect(classifyFailure("your credit balance is too low", "").cause).toBe("out-of-credits");
});

test("unknown stderr falls back to transient with no resetAt", () => {
  const r = classifyFailure("segfault: core dumped", "");
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
});

test("a marker appearing on stdout (not stderr) is still classified", () => {
  expect(classifyFailure("", "…You've hit your session limit, resets soon").cause).toBe(
    "session-limit",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/agent/providers/classify-failure.test.ts`
Expected: FAIL — `classifyFailure` is not exported.

- [ ] **Step 3: Add the neutral type to the agent boundary**

In `src/agent/runner.ts`, above `AgentRunResult`:

```ts
/** Provider-neutral classification of a non-completing dispatch (control-loop §3a / ENG-164).
 *  Only a provider adapter sets this; the core routes on it and never matches provider strings. */
export type FailureCause = "session-limit" | "out-of-credits" | "transient";
```

Inside `AgentRunResult`, add after `timedOut`:

```ts
  /** Set by the adapter when `completed` is false: why the dispatch did not complete.
   *  Absent → treated as "transient" (today's retry behavior). */
  cause?: FailureCause;
  /** For session-limit only: the provider's raw human reset text (display-only). */
  resetAt?: string | null;
```

- [ ] **Step 4: Implement `classifyFailure` and wire it into the adapter**

In `src/agent/providers/claude.ts`, add the import to the existing runner import line:

```ts
import type { AgentRunInput, AgentRunResult, AgentRunner, FailureCause } from "../runner.ts";
```

Add the exported classifier (near `parseClaudeJson`):

```ts
/** Map a Claude `claude -p` death to a provider-neutral cause (ENG-164). The ONLY place that
 *  knows Claude's marker strings. A session-limit death is a clean non-zero exit carrying the
 *  marker on stderr/stdout, so both streams are searched. */
export function classifyFailure(
  stderr: string,
  stdout: string,
): { cause: FailureCause; resetAt: string | null } {
  const text = `${stderr}\n${stdout}`;
  if (/hit your session limit|session limit|usage limit reached/i.test(text)) {
    const m = text.match(/resets?\s+([^\n]+)/i);
    return { cause: "session-limit", resetAt: m ? m[1].trim() : null };
  }
  if (/out of credit|insufficient credit|credit balance is too low|billing/i.test(text)) {
    return { cause: "out-of-credits", resetAt: null };
  }
  return { cause: "transient", resetAt: null };
}
```

Update the `transportFailure` helper inside `claudeAgentRunner` to carry a cause (default transient):

```ts
      const transportFailure = (stderr: string, timedOut: boolean): AgentRunResult => ({
        completed: false,
        exitCode: null,
        stdout: "",
        stderr,
        timedOut,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        cacheRead: null,
        cacheCreate: null,
        cause: "transient",
        resetAt: null,
      });
```

Replace the success-return block (the `const usage = parseClaudeJson(stdout); return {...}` lines) with:

```ts
        const usage = parseClaudeJson(stdout);
        if (exitCode === 0) {
          return { completed: true, exitCode, stdout, stderr, timedOut: false, ...usage };
        }
        const { cause, resetAt } = classifyFailure(stderr, stdout);
        return { completed: false, exitCode, stdout, stderr, timedOut: false, ...usage, cause, resetAt };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/agent/providers/classify-failure.test.ts test/agent/providers/claude.test.ts`
Expected: PASS (new classifier tests + existing adapter tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/agent/runner.ts src/agent/providers/claude.ts test/agent/providers/classify-failure.test.ts
git commit -m "feat(agent): provider-neutral FailureCause + Claude marker classifier (ENG-164)"
```

---

## Task 2: `event_log` `parked` kind + `payload_json` plumbing

**Files:**
- Modify: `src/db/schema.sql` and `docs/architecture/schema.sql`
- Modify: `src/db/repos/event-log.ts`
- Modify: `src/telemetry/events.ts`, `src/telemetry/emitter.ts`
- Test: `test/db/repos/event-log-payload.test.ts`

**Interfaces:**
- Produces: `appendEvent(db, { …, payload?: Record<string, unknown> })` writes `event_log.payload_json`; `EventLogRow.payload_json: string | null`; `event_log.kind` accepts `'parked'`; telemetry `event` record carries `payload_json`.

- [ ] **Step 1: Write the failing test**

Create `test/db/repos/event-log-payload.test.ts`:

```ts
import { expect, test } from "bun:test";
import { appendEvent, listByTicket } from "../../../src/db/repos/event-log.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("a 'parked' event persists with a JSON payload", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "parked",
    reason: "session-limit; resets 11:10pm",
    payload: { cause: "session-limit", resetAt: "11:10pm", dispatchId: "ENG-1-d0001" },
  });
  const row = listByTicket(db, ticketId).at(-1);
  expect(row?.kind).toBe("parked");
  expect(JSON.parse(row?.payload_json ?? "{}").cause).toBe("session-limit");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/repos/event-log-payload.test.ts`
Expected: FAIL — `kind = 'parked'` violates the CHECK and/or `payload` is ignored / `payload_json` missing from the row.

- [ ] **Step 3: Extend the `event_log.kind` CHECK in BOTH schema files**

In `src/db/schema.sql` AND `docs/architecture/schema.sql`, change the `event_log` kind CHECK:

```sql
    kind         TEXT NOT NULL CHECK (kind IN (
                     'transition','loopback','escalated','resumed','note','parked')),
```

- [ ] **Step 4: Add `payload_json` to the event-log repo**

In `src/db/repos/event-log.ts`: add `payload_json: string | null;` to `EventLogRow` (after `reason`); append `, payload_json` to the `COLS` string; add a `payload?: Record<string, unknown>;` field to the `appendEvent` parameter object; add the column + binding to the INSERT:

```ts
      `INSERT INTO event_log
         (ticket_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, payload_json, created_at)
       VALUES ($t, $seq, $kind, $actor, $from, $to, $loop, $route, $sig, $reason, $payload, $now)`,
```

and in the `.run({...})` object add:

```ts
      $payload: e.payload ? JSON.stringify(e.payload) : null,
```

- [ ] **Step 5: Surface `payload_json` in telemetry**

In `src/telemetry/events.ts`, add to the `EventEvent` zod object (after `reason`):

```ts
  payload_json: z.string().nullable(),
```

In `src/telemetry/emitter.ts`, in the `event`-record mapping (the object with `type: "event"`), add after `reason: r.reason,`:

```ts
    payload_json: r.payload_json,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/db/repos/event-log-payload.test.ts test/db/repos/ test/telemetry/`
Expected: PASS (new test + existing event-log/telemetry tests green).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql docs/architecture/schema.sql src/db/repos/event-log.ts src/telemetry/events.ts src/telemetry/emitter.ts test/db/repos/event-log-payload.test.ts
git commit -m "feat(db): event_log 'parked' kind + payload_json plumbing (ENG-164)"
```

---

## Task 3: `ParkSignal` + route the cause in `runAgentDispatch`

**Files:**
- Create: `src/engine/park-signal.ts`
- Modify: `src/dispatch/run-dispatch.ts`
- Test: `test/dispatch/park-routing.test.ts`

**Interfaces:**
- Consumes: `FailureCause` (Task 1); `completeDispatch` (existing).
- Produces: `ParkInfo` (`{ cause: "session-limit" | "out-of-credits"; resetAt: string | null; dispatchId: string; transcript: string }`); `class ParkSignal extends Error { readonly info: ParkInfo }`; `runAgentDispatch` throws `ParkSignal` for park-causes and records dispatch `outcome: "parked"`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/park-routing.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import { ParkSignal } from "../../src/engine/park-signal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-park-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function ctxFor(db: ReturnType<typeof makeTestDb>["db"], ticketId: number): HandlerContext {
  const step = insertPending(db, { ticketId, stepKey: "implement:wu1:dispatch", stepType: "dispatch" });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG };
}

function deps(runner: FakeAgentRunner, repo: string, wt: string) {
  return {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    repoPath: repo,
    worktreePath: wt,
    branch: "feat/ENG-1",
    timeoutMs: 1000,
  };
}

test("a session-limit cause throws ParkSignal and records dispatch outcome 'parked'", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "partial work so far",
    stderr: "You've hit your session limit · resets 11:10pm",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "session-limit" as const,
    resetAt: "11:10pm",
  }));
  let signal: unknown;
  try {
    await runAgentDispatch(ctxFor(db, ticketId), deps(runner, repo, wt), {
      handlerKey: "implement:dispatch",
      template: "do {{ticket}}",
      vars: { ticket: "ENG-1" },
      postcondition: () => {},
    });
  } catch (e) {
    signal = e;
  }
  expect(signal).toBeInstanceOf(ParkSignal);
  expect((signal as ParkSignal).info.cause).toBe("session-limit");
  expect((signal as ParkSignal).info.transcript).toBe("partial work so far");
  expect(listByTicket(db, ticketId).at(-1)?.outcome).toBe("parked");
  db.close();
});

test("a transient cause still throws a plain Error and records 'dispatch-failed'", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt2-${Date.now()}`);
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "",
    stderr: "segfault",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "transient" as const,
    resetAt: null,
  }));
  let err: unknown;
  try {
    await runAgentDispatch(ctxFor(db, ticketId), deps(runner, repo, wt), {
      handlerKey: "implement:dispatch",
      template: "do {{ticket}}",
      vars: { ticket: "ENG-1" },
      postcondition: () => {},
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ParkSignal);
  expect(listByTicket(db, ticketId).at(-1)?.outcome).toBe("dispatch-failed");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/park-routing.test.ts`
Expected: FAIL — `src/engine/park-signal.ts` does not exist; `runAgentDispatch` does not yet route on cause.

- [ ] **Step 3: Create `ParkSignal`**

Create `src/engine/park-signal.ts`:

```ts
import type { FailureCause } from "../agent/runner.ts";

/** A resumable-park request (ENG-164). Carries everything needed to record the park and to
 *  resume the interrupted step later. Distinct from a normal Error so the journal can leave the
 *  step 'running' (recover() owns it) instead of marking it failed and burning a retry attempt. */
export interface ParkInfo {
  cause: Exclude<FailureCause, "transient">; // "session-limit" | "out-of-credits"
  resetAt: string | null;
  dispatchId: string;
  transcript: string;
}

export class ParkSignal extends Error {
  constructor(readonly info: ParkInfo) {
    super(`dispatch ${info.dispatchId} parked: ${info.cause}`);
    this.name = "ParkSignal";
  }
}
```

- [ ] **Step 4: Route the cause in `runAgentDispatch`**

In `src/dispatch/run-dispatch.ts`, add the import:

```ts
import { ParkSignal } from "../engine/park-signal.ts";
```

Replace the existing transport-failure block:

```ts
  if (!result.completed || result.timedOut) {
    completeDispatch(ctx.db, inserted.id, { outcome: "dispatch-failed", endedAt: nowUtc() });
    throw new Error(
      `dispatch ${did} transport failure (exit ${result.exitCode}, timedOut=${result.timedOut})`,
    );
  }
```

with:

```ts
  if (!result.completed || result.timedOut) {
    // A timeout never carries a marker (no drained output) → always transient.
    const cause = result.timedOut ? "transient" : (result.cause ?? "transient");
    if (cause === "session-limit" || cause === "out-of-credits") {
      completeDispatch(ctx.db, inserted.id, { outcome: "parked", endedAt: nowUtc() });
      throw new ParkSignal({
        cause,
        resetAt: result.resetAt ?? null,
        dispatchId: did,
        transcript: result.stdout ?? "",
      });
    }
    completeDispatch(ctx.db, inserted.id, { outcome: "dispatch-failed", endedAt: nowUtc() });
    throw new Error(
      `dispatch ${did} transport failure (exit ${result.exitCode}, timedOut=${result.timedOut})`,
    );
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/dispatch/park-routing.test.ts test/dispatch/run-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/park-signal.ts src/dispatch/run-dispatch.ts test/dispatch/park-routing.test.ts
git commit -m "feat(dispatch): ParkSignal + route park-causes in runAgentDispatch (ENG-164)"
```

---

## Task 4: Propagate the park through the journal, advance, loop, and run-ticket

**Files:**
- Modify: `src/engine/step-journal.ts`
- Modify: `src/daemon/advance.ts`
- Modify: `src/daemon/loop.ts`
- Modify: `src/daemon/run-ticket.ts`
- Test: `test/daemon/park-propagation.test.ts`

**Interfaces:**
- Consumes: `ParkSignal`, `ParkInfo` (Task 3); `appendEvent` with `payload` (Task 2); `setTicketStatus` (existing).
- Produces: `AdvanceOutcome` += `{ kind: "parked"; stepKey: string; park: ParkInfo }`; `tick(...)` returns `{ advanced, blocked, parked?: ParkInfo }`; `RunOutcome` += `"parked"`; `RunResult` += `park?: ParkInfo`.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/park-propagation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByStatus } from "../../src/db/repos/workflow-step.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";
import { gitRepoWithProject } from "../helpers/git-project.ts";

test("a session-limit park sets status=waiting, leaves the step running, appends a 'parked' event, and burns no attempt", async () => {
  const { db, ticketId } = gitRepoWithProject(); // seeds project.target_repo to a real git repo + ticket ENG-1 in 'implement'
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "partial",
    stderr: "You've hit your session limit · resets 11:10pm",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "session-limit" as const,
    resetAt: "11:10pm",
  }));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: getTicket(db, ticketId) ? "/unused" : "/unused" }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
    timeoutMs: 1000,
  });
  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: undefined as never, // no projector needed for this path
    profile: { checksSystem: "none" },
  });
  expect(result.outcome).toBe("parked");
  expect(result.park?.cause).toBe("session-limit");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  expect(listByStatus(db, "running").length).toBe(1); // interrupted step left running
  expect(listEvents(db, ticketId).some((e) => e.kind === "parked")).toBe(true);
  db.close();
});
```

> **Test helper note:** create `test/helpers/git-project.ts` exporting `gitRepoWithProject()` — it builds a real temp git repo (init + initial commit, as in `gitRepo()` from `run-dispatch.test.ts`), runs `makeTestDb()`, updates the seeded project's `target_repo` to that repo path, and advances ticket `ENG-1` to `stage='implement'` with one `work_unit` so the resolver dispatches `implement:dispatch`. Reuse the git scaffold already duplicated in `run-dispatch.test.ts`/`park-routing.test.ts`. (Fold this helper creation into Step 3 of this task.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/park-propagation.test.ts`
Expected: FAIL — `driveToTerminal` does not yet return a `parked` outcome; `RunResult.park` does not exist.

- [ ] **Step 3: Let `ParkSignal` bypass `markFailed` in the journal, and add the test helper**

In `src/engine/step-journal.ts`, add the import:

```ts
import { ParkSignal } from "./park-signal.ts";
```

Change the `catch` at the bottom of `runStep`:

```ts
  } catch (err) {
    if (err instanceof ParkSignal) {
      // Leave the step 'running': advance() records the park and resume()/recover() re-dispatch it.
      // Crucially, NOT markFailed → no attempt consumed (ENG-164: a quota pause is not a failure).
      throw err;
    }
    steps.markFailed(db, step.id, err);
    throw err;
  }
```

Create `test/helpers/git-project.ts` as described in the Step-1 helper note (real git repo + seeded project/ticket/work-unit in `implement`).

- [ ] **Step 4: Catch the park in `advanceOneStep`**

In `src/daemon/advance.ts`, add imports:

```ts
import { ParkSignal } from "../engine/park-signal.ts";
import type { ParkInfo } from "../engine/park-signal.ts";
import { appendEvent } from "../db/repos/event-log.ts"; // already imported — keep single import
```

Add to the `AdvanceOutcome` union:

```ts
  | { kind: "parked"; stepKey: string; park: ParkInfo };
```

In the `catch (err)` block of the `d.kind === "step"` path, BEFORE the existing `getByKey` lookup:

```ts
    } catch (err) {
      if (err instanceof ParkSignal) {
        db.transaction(() => {
          setTicketStatus(db, ticketId, "waiting");
          appendEvent(db, {
            ticketId,
            kind: "parked",
            reason:
              err.info.cause === "session-limit"
                ? `session-limit${err.info.resetAt ? `; resets ${err.info.resetAt}` : ""}`
                : "out-of-credits; top up to resume",
            payload: { cause: err.info.cause, resetAt: err.info.resetAt, dispatchId: err.info.dispatchId },
          });
        })();
        return { kind: "parked", stepKey: d.stepKey, park: err.info };
      }
      const failed = getByKey(db, ticketId, d.stepKey);
      // …existing failure-policy handling unchanged…
```

(`setTicketStatus` is already imported in `advance.ts`.)

- [ ] **Step 5: Surface the park from `tick`**

In `src/daemon/loop.ts`, add the import:

```ts
import type { ParkInfo } from "../engine/park-signal.ts";
```

Change the `tick` return type to `Promise<{ advanced: number; blocked: boolean; parked?: ParkInfo }>`, add a `let parked: ParkInfo | undefined;`, handle the outcome in the loop, and include it in the return:

```ts
  for (const id of ids) {
    const outcome = await advanceOneStep(db, id, registry, { config: opts?.config });
    if (outcome.kind === "blocked") blocked = true;
    else if (outcome.kind === "parked") parked = outcome.park;
    else advanced++;
  }
  // …existing drain/poll…
  return { advanced, blocked, parked };
```

- [ ] **Step 6: Return the park from `driveToTerminal`**

In `src/daemon/run-ticket.ts`:

```ts
import type { ParkInfo } from "../engine/park-signal.ts";
```

Change `RunOutcome`:

```ts
export type RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress" | "parked";
```

Add to `RunResult`:

```ts
  park?: ParkInfo;
```

In `driveToTerminal`, immediately after `const r = await tick(...)` and `emitter.flushNew(...)` and the `getTicket` re-read (where `last` is set), add the park check as the first terminal condition:

```ts
    if (r.parked) return finish({ outcome: "parked", iterations: i, ...last, park: r.parked });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/daemon/park-propagation.test.ts test/daemon/run-ticket.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/step-journal.ts src/daemon/advance.ts src/daemon/loop.ts src/daemon/run-ticket.ts test/daemon/park-propagation.test.ts test/helpers/git-project.ts
git commit -m "feat(daemon): propagate ParkSignal to a 'parked' run outcome, burning no attempt (ENG-164)"
```

---

## Task 5: CLI park-dump + `branchHeadSha` helper

**Files:**
- Modify: `src/dispatch/worktree.ts`
- Create: `src/cli/park.ts`
- Modify: `src/cli/run.ts`
- Test: `test/cli/park-resume-e2e.test.ts` (park half)

**Interfaces:**
- Produces: `branchHeadSha(repoPath: string, branch: string): string | null`; `parkDir(slug: string, ident: string): string`; `dumpPark(db, dbPath, slug, ticketId, park): string` (returns the dump dir); `run` exits `75` on a parked outcome after writing the dump.

- [ ] **Step 1: Write the failing test**

Create `test/cli/park-resume-e2e.test.ts` with the park-half test (resume half added in Task 6):

```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parkDir } from "../../src/cli/park.ts";
import { runParkedTicket } from "../helpers/run-harness.ts";

test("a parked run writes run.db + transcript.json under the state dir and reports cause", async () => {
  // runParkedTicket: sets XDG_STATE_HOME to a temp dir, drives ENG-1 with a session-limit FakeRunner
  // via the same wiring as src/cli/run.ts, and returns { slug, ident, park, exitCode }.
  const { slug, ident, exitCode } = await runParkedTicket();
  const dir = parkDir(slug, ident);
  expect(existsSync(join(dir, "run.db"))).toBe(true);
  expect(existsSync(join(dir, "transcript.json"))).toBe(true);
  expect(exitCode).toBe(75);
});
```

> **Test helper note:** create `test/helpers/run-harness.ts` exporting `runParkedTicket()` and (for Task 6) `resumeTicket()`. It points `process.env.XDG_STATE_HOME` at a temp dir, builds the same deps as `src/cli/run.ts` (profile via `parseProfile`, a `FakeAgentRunner`, `makeProjectorPorts`), and calls the extracted `park.ts` helpers directly rather than shelling out — so the test drives the real code paths in-process. Fold its creation into Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/park-resume-e2e.test.ts`
Expected: FAIL — `src/cli/park.ts` does not exist.

- [ ] **Step 3: Export `branchHeadSha` from `worktree.ts`**

In `src/dispatch/worktree.ts`, add:

```ts
/** The current commit sha of `branch` in `repoPath`, or null if the branch/ref is absent. */
export function branchHeadSha(repoPath: string, branch: string): string | null {
  try {
    return git(["rev-parse", branch], repoPath);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Create `src/cli/park.ts` (dump half)**

```ts
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config/paths.ts";
import type { Database } from "bun:sqlite";
import type { ParkInfo } from "../engine/park-signal.ts";

/** The durable dump dir for a parked run: ~/.local/state/styre/<project-stub>/<ticket-ident>/ */
export function parkDir(slug: string, ident: string): string {
  return join(stateDir(), slug, ident);
}

/** Persist the parked run so `styre run --resume` can rehydrate it exactly:
 *   - run.db: the SoT (checkpointed so the single file is self-contained), with the interrupted
 *     step left 'running' (recover() resets it on resume)
 *   - transcript.json: the dying dispatch's partial stdout, for advisory carryover
 *  The branch commits are already durable in the target repo's git. Returns the dump dir.
 *  NOTE: the caller must NOT have closed `db` yet — this checkpoints then the caller closes. */
export function dumpPark(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  park: ParkInfo,
): string {
  const dir = parkDir(slug, ident);
  mkdirSync(dir, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // fold WAL into the main file before copy
  db.close();
  copyFileSync(dbPath, join(dir, "run.db"));
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({ dispatchId: park.dispatchId, cause: park.cause, resetAt: park.resetAt, transcript: park.transcript }),
  );
  return dir;
}
```

Create `test/helpers/run-harness.ts` per the Step-1 note (drives the real `run.ts`/`park.ts` wiring in-process with a session-limit `FakeAgentRunner`, returns `{ slug, ident, park, exitCode }`).

- [ ] **Step 5: Wire the parked outcome into `run.ts`**

In `src/cli/run.ts`, add imports:

```ts
import { getTicket } from "../db/repos/ticket.ts";
import { dumpPark } from "./park.ts";
```

After `const out = await runTicket({ … });` and the `console.error(out.summary);` line, replace the `db.close();` + throw tail with:

```ts
    console.error(out.summary);
    if (out.outcome === "parked" && out.park) {
      const ident = getTicket(db, out.ticketId)?.ident ?? args.ticket;
      const dir = dumpPark(db, dbPath, profile.slug, ident, out.park); // dumpPark closes db
      console.error(
        `Parked: ${out.park.cause}${out.park.resetAt ? ` (resets ${out.park.resetAt})` : ""}.\n` +
          `Resume with: styre run --resume ${ident} --profile ${args.profile}\n` +
          `Dump: ${dir}`,
      );
      process.exitCode = 75;
      return;
    }
    db.close();
    if (out.outcome === "blocked" || out.outcome === "no-progress") {
      throw new Error(`run: ticket ${args.ticket} ended ${out.outcome}`);
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/cli/park-resume-e2e.test.ts test/cli.test.ts`
Expected: PASS (park-half) — resume-half is added in Task 6.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/worktree.ts src/cli/park.ts src/cli/run.ts test/cli/park-resume-e2e.test.ts test/helpers/run-harness.ts
git commit -m "feat(cli): dump a parked run to the XDG state dir and exit 75 (ENG-164)"
```

---

## Task 6: `styre run --resume` (rehydrate + recover + transcript carryover)

**Files:**
- Modify: `src/dispatch/run-dispatch.ts` (carryover prepend + `resumeContext` on `DispatchDeps`)
- Modify: `src/dispatch/handlers.ts` (`resumeContext` on `RegistryDeps`, threaded via `depsFor`)
- Modify: `src/cli/park.ts` (resume orchestration)
- Modify: `src/cli/run.ts` (`--resume` arg)
- Test: `test/cli/park-resume-e2e.test.ts` (resume half)

**Interfaces:**
- Consumes: `dumpPark`/`parkDir` (Task 5); `recover` (existing); `driveToTerminal`, `formatRunSummary` (existing exports).
- Produces: `DispatchDeps.resumeContext?: { stepKey: string; transcript: string }`; `RegistryDeps.resumeContext?: { stepKey: string; transcript: string }`; `resumeRun(args, profile, runtimeConfig): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `test/cli/park-resume-e2e.test.ts`:

```ts
import { resumeParkedTicket } from "../helpers/run-harness.ts";

test("resume re-runs only the interrupted step, injects the carryover block, and completes", async () => {
  // runParkedTicket parks ENG-1 mid-implement; resumeParkedTicket re-opens the same dump with a
  // FakeAgentRunner that SUCCEEDS, and records every prompt it receives.
  const parked = await runParkedTicket();
  const { prompts, result } = await resumeParkedTicket(parked); // no --accept-head, head unchanged
  // The interrupted implement step is re-dispatched exactly once, with the advisory block:
  const implementPrompt = prompts.find((p) => p.includes("previous attempt was interrupted"));
  expect(implementPrompt).toBeDefined();
  expect(implementPrompt).toContain("partial"); // the carried transcript text
  // Completed steps were NOT re-dispatched (exactly-once); the run advanced past the park:
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/park-resume-e2e.test.ts`
Expected: FAIL — `resumeParkedTicket` / `resumeRun` not implemented; no carryover block in prompts.

- [ ] **Step 3: Add transcript carryover to `runAgentDispatch`**

In `src/dispatch/run-dispatch.ts`, add to the `DispatchDeps` interface:

```ts
  /** Set only when resuming a parked run: the interrupted step's prior partial output, injected
   *  as an advisory (non-authoritative) continuity hint into THAT step's re-dispatch prompt. */
  resumeContext?: { stepKey: string; transcript: string };
```

Add the fence constants near the top of the file:

```ts
const CARRYOVER_PREFIX =
  "A previous attempt was interrupted (quota/billing pause). Below is its partial output, for " +
  "context only — it may be incomplete or stale. The repository and journal are the source of " +
  "truth; verify the current state before redoing or relying on anything it claims to have done.";
const CARRYOVER_SUFFIX = "--- end of interrupted attempt's partial output ---";
```

After the existing `const rendered = renderPrompt(...)` + the `if (!rendered.ok)` guard, compute the effective prompt:

```ts
  let prompt = rendered.prompt;
  if (deps.resumeContext && deps.resumeContext.stepKey === ctx.step.step_key) {
    prompt = `${CARRYOVER_PREFIX}\n\n${deps.resumeContext.transcript}\n\n${CARRYOVER_SUFFIX}\n\n${rendered.prompt}`;
  }
```

Change the runner call to use `prompt` instead of `rendered.prompt`:

```ts
  const result = await deps.runner.run({
    prompt,
    model,
    // …unchanged…
```

- [ ] **Step 4: Thread `resumeContext` through `handlers.ts`**

In `src/dispatch/handlers.ts`, add to `RegistryDeps`:

```ts
  resumeContext?: { stepKey: string; transcript: string };
```

In `depsFor`, add to the returned object:

```ts
    resumeContext: deps.resumeContext,
```

- [ ] **Step 5: Implement `resumeRun` in `park.ts`**

Add to `src/cli/park.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { realRecoverDeps, recover } from "../daemon/recover.ts";
import { getProject } from "../db/repos/project.ts";
import { getTicket, setTicketStatus } from "../db/repos/ticket.ts";
import { listByStatus } from "../db/repos/workflow-step.ts";
import { appendEvent } from "../db/repos/event-log.ts";
import { branchNameFor } from "../agent/branch.ts";
import { driveToTerminal, formatRunSummary } from "../daemon/run-ticket.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import { selectAgentRunner } from "../agent/registry.ts";
import { claudeAgentRunner } from "../agent/providers/claude.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { stdoutSink } from "../telemetry/emit.ts";
import { branchHeadSha } from "../dispatch/worktree.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Profile } from "../dispatch/profile.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";

/** The single ticket id in a per-run SoT. */
function onlyTicketId(db: Database): number {
  const row = db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get();
  if (!row) throw new Error("resume: the dump DB has no ticket");
  return row.id;
}

export interface ResumeArgs {
  resume: string; // ticket ident
  acceptHead?: boolean;
  inspect?: boolean;
}

export async function resumeRun(
  args: ResumeArgs,
  profile: Profile,
  runtimeConfig: RuntimeConfig,
): Promise<void> {
  const dir = parkDir(profile.slug, args.resume);
  const dbPath = join(dir, "run.db");
  if (!existsSync(dbPath)) {
    throw new Error(`resume: no parked run at ${dbPath}`);
  }
  migrate(dbPath);
  const db = openDb(dbPath);
  const ticketId = onlyTicketId(db);
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("resume: ticket vanished");
  const project = getProject(db, ticket.project_id);
  if (!project) throw new Error("resume: project missing");
  const branch = branchNameFor(ticket);
  const parkedStep = listByStatus(db, "running").find((s) => s.ticket_id === ticketId) ?? null;

  const recorded = headBaseline(db, ticketId);
  const current = branchHeadSha(project.target_repo, branch);
  const moved = recorded !== null && current !== null && recorded !== current;

  if (args.inspect) {
    process.stderr.write(
      `resume --inspect ${ticket.ident}\n` +
        `  recorded base: ${recorded ?? "(none)"}\n` +
        `  current head:  ${current ?? "(none)"}${moved ? "  [MOVED]" : ""}\n` +
        `  would re-dispatch step: ${parkedStep?.step_key ?? "(none)"}\n` +
        `  (no changes made)\n`,
    );
    db.close();
    return;
  }

  if (moved && !args.acceptHead) {
    process.stderr.write(
      `resume refused: branch HEAD moved since the parked attempt.\n` +
        `  recorded base: ${recorded}\n  current head:  ${current}\n` +
        `  would re-dispatch: ${parkedStep?.step_key ?? "(none)"}\n` +
        `  Re-run with --accept-head to resume against the new HEAD (drops stale transcript),\n` +
        `  or --inspect to review, or 'styre run ${ticket.ident}' to start fresh.\n`,
    );
    db.close();
    process.exitCode = 65;
    return;
  }

  setTicketStatus(db, ticketId, "active");
  let resumeContext: { stepKey: string; transcript: string } | undefined;
  if (moved && args.acceptHead) {
    appendEvent(db, { ticketId, kind: "resumed", reason: `accept-head:${current}` });
    // carryover dropped: the operator changed the base, so the transcript is untrustworthy
  } else {
    if (parkedStep && existsSync(join(dir, "transcript.json"))) {
      const tj = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as { transcript: string };
      resumeContext = { stepKey: parkedStep.step_key, transcript: tj.transcript };
    }
    appendEvent(db, { ticketId, kind: "resumed", reason: "resume" });
  }

  recover(db, realRecoverDeps()); // resets the interrupted 'running' step → pending

  const ports = makeProjectorPorts(runtimeConfig, profile);
  const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
    resumeContext,
  });

  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: runtimeConfig,
    ports,
    profile,
    emit: stdoutSink,
  });
  process.stderr.write(`${formatRunSummary(db, ticketId, result)}\n`);

  if (result.outcome === "parked" && result.park) {
    const d = dumpPark(db, dbPath, profile.slug, ticket.ident, result.park); // re-dump (closes db)
    process.stderr.write(`Parked again: ${result.park.cause}. Dump: ${d}\n`);
    process.exitCode = 75;
    return;
  }
  db.close();
  if (result.outcome === "blocked" || result.outcome === "no-progress") {
    throw new Error(`resume: ticket ${ticket.ident} ended ${result.outcome}`);
  }
}

/** The HEAD-guard baseline: the most recent operator-accepted head if any, else the last
 *  successful dispatch's branch head (the base the interrupted step started from). */
function headBaseline(db: Database, ticketId: number): string | null {
  const accepted = listEvents(db, ticketId)
    .filter((e) => e.kind === "resumed" && (e.reason?.startsWith("accept-head:") ?? false))
    .at(-1);
  if (accepted?.reason) return accepted.reason.slice("accept-head:".length);
  return getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
}
```

Add the remaining imports used above to `park.ts`:

```ts
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
```

- [ ] **Step 6: Add the `--resume` arg to `run.ts`**

In `src/cli/run.ts`, add to `args`:

```ts
    resume: { type: "string", description: "Resume a parked run by ticket ident" },
    "accept-head": { type: "boolean", description: "Resume even though the branch HEAD moved (drops carryover)" },
    inspect: { type: "boolean", description: "Print resume diagnostics and exit without running" },
```

At the very top of `run({ args })`, before the fresh-run setup, branch to resume:

```ts
    const profile = loadProfile(args.profile);
    const runtimeConfig =
      args.config && args.config.length > 0
        ? RuntimeConfigSchema.parse(JSON.parse(readFileSync(args.config, "utf8")))
        : DEFAULT_RUNTIME_CONFIG;

    if (args.resume && args.resume.length > 0) {
      const { resumeRun } = await import("./park.ts");
      await resumeRun(
        { resume: args.resume, acceptHead: args["accept-head"], inspect: args.inspect },
        profile,
        runtimeConfig,
      );
      return;
    }
```

(Then the existing fresh-run body follows, reusing the already-loaded `profile`/`runtimeConfig` — remove their duplicate declarations below.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/cli/park-resume-e2e.test.ts`
Expected: PASS (park + resume halves).

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/run-dispatch.ts src/dispatch/handlers.ts src/cli/park.ts src/cli/run.ts test/cli/park-resume-e2e.test.ts test/helpers/run-harness.ts
git commit -m "feat(cli): styre run --resume with step-granularity rehydrate + transcript carryover (ENG-164)"
```

---

## Task 7: HEAD guard escape hatches + park-loop regression

**Files:**
- Test: `test/cli/head-guard-e2e.test.ts`
- (No new source — exercises `--accept-head` / `--inspect` and the no-attempt-burn loop built in Tasks 4/6.)

**Interfaces:**
- Consumes: `resumeRun` + harness from Task 6.

- [ ] **Step 1: Write the failing/▶ regression test**

Create `test/cli/head-guard-e2e.test.ts`:

```ts
import { expect, test } from "bun:test";
import { advanceBranchHead, resumeParkedTicket, runParkedTicket } from "../helpers/run-harness.ts";

test("a moved HEAD refuses plain --resume with exit 65 and changes nothing", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked); // operator commits on the branch
  const { exitCode, ran } = await resumeParkedTicket(parked, {}); // no flags
  expect(exitCode).toBe(65);
  expect(ran).toBe(false); // no dispatch happened
});

test("--inspect on a moved HEAD prints diagnostics, exits 0, changes nothing", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked);
  const { exitCode, ran } = await resumeParkedTicket(parked, { inspect: true });
  expect(exitCode).toBe(0);
  expect(ran).toBe(false);
});

test("--accept-head resumes against the new HEAD WITHOUT carryover", async () => {
  const parked = await runParkedTicket();
  advanceBranchHead(parked);
  const { prompts, result } = await resumeParkedTicket(parked, { acceptHead: true });
  expect(prompts.some((p) => p.includes("previous attempt was interrupted"))).toBe(false); // dropped
  expect(result.outcome === "pr-ready" || result.outcome === "done").toBe(true);
});

test("park → resume → park → resume never exhausts maxAttempts (no attempt burned by a park)", async () => {
  const parked = await runParkedTicket();
  // resume into a runner that parks AGAIN, then resume into a success:
  const second = await resumeParkedTicket(parked, { parkAgain: true });
  expect(second.result.outcome).toBe("parked");
  const third = await resumeParkedTicket(parked, {});
  expect(third.result.outcome === "pr-ready" || third.result.outcome === "done").toBe(true);
});
```

> **Harness additions (fold into Step 2):** extend `test/helpers/run-harness.ts` with `advanceBranchHead(parked)` (commits an empty change on the ticket branch in the dump's target repo) and `resumeParkedTicket(parked, opts)` returning `{ exitCode, ran, prompts, result }`, where `opts` supports `{ inspect, acceptHead, parkAgain }`. `ran` is derived from whether the `FakeAgentRunner` recorded any input.

- [ ] **Step 2: Run the tests; implement harness additions until green**

Run: `bun test test/cli/head-guard-e2e.test.ts`
Expected: initially FAIL (harness helpers missing) → add `advanceBranchHead`/`resumeParkedTicket` options → PASS. No `src/` changes should be needed; if a test reveals a real gap (e.g. attempt was burned), fix the corresponding Task 4/6 source and note it.

- [ ] **Step 3: Commit**

```bash
git add test/cli/head-guard-e2e.test.ts test/helpers/run-harness.ts
git commit -m "test(cli): HEAD-guard escape hatches + park-loop never burns an attempt (ENG-164)"
```

---

## Task 8: Document the CLI seam (exit codes + resume) and full-suite gate

**Files:**
- Modify: `CLAUDE.md` (Intended commands — exit codes + resume flag) OR the README CLI section, whichever documents `styre run`.
- Modify: `docs/architecture/control-loop.md` (note the `parked` outcome token in the dispatch/loopback atlas, near the V4 transport-failure rows).

- [ ] **Step 1: Document the resume contract**

In the `styre run` description (CLAUDE.md "Intended commands" §), append:

```markdown
  - On a session-limit / out-of-credits dispatch death, `run` parks: it dumps the SoT + transcript
    to `~/.local/state/styre/<project-stub>/<ticket-ident>/` and exits `75` (EX_TEMPFAIL) without
    burning a retry attempt. Resume with `styre run --resume <ticket> --profile <p>` (re-runs only
    the interrupted step, carrying its partial context forward). If the branch HEAD moved since the
    park, resume refuses (exit `65`); use `--accept-head` (resume against new HEAD, drops carryover)
    or `--inspect` (diagnostics only, exit `0`).
```

- [ ] **Step 2: Note the `parked` token in the control-loop atlas**

In `docs/architecture/control-loop.md`, near the V4 "reviewer death / transport (dispatch didn't complete)" rows, add a one-line note:

```markdown
> ENG-164: a transport death is now classified by cause. session-limit / out-of-credits →
> `parked` (resumable, attempt NOT consumed); crash / timeout / unknown → `transient` retry as
> before. The `parked` dispatch outcome + `event_log.kind='parked'` make a quota pause countable
> separately from a real failure.
```

- [ ] **Step 3: Run the full suite + lint**

Run: `bun test`
Expected: PASS (entire suite).

Run: `bunx biome check src test` (or the repo's configured lint command)
Expected: clean (fix any format/lint findings).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture/control-loop.md
git commit -m "docs: document the parked/resume CLI seam + control-loop atlas note (ENG-164)"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §5.1 classification boundary → Task 1.
- §5.2 park-and-dump (ParkSignal, dispatch outcome, state dir) → Tasks 3 (signal/outcome) + 5 (dump/state dir) + 4 (status/event).
- §5.3 resume (rehydrate, recover, carryover, ground-truth guard) → Task 6.
- §5.4 HEAD guard + `--accept-head` + `--inspect` → Tasks 6 (logic) + 7 (tests).
- §5.5 telemetry/event-log/exit codes → Tasks 2 (event/payload), 3 (`outcome=parked`), 5 (`75`), 6 (`65`/`0`), 8 (docs).
- §5.6 testing (4 groups: classification, routing, round-trip, HEAD guard) → Tasks 1, 3/4, 5/6, 7.
- §6 invariants → enforced structurally (Task 4 no-attempt-burn test; Task 6 carryover-as-advisory).
- §7 OSS/plane boundary → core only dumps + `--resume`; no scheduling. Held.

**Surfaced deviations from the approved spec (not silent — see `[[styre-no-silent-scope-deferral]]`):**
1. `resetAt` carries the provider's **raw reset text (display-only)**, not a normalized UTC ISO instant — reliable parsing from `"11:10pm (Asia/Calcutta)"` isn't feasible; structured normalization is a future enhancement. (Task 1 note.)
2. `dispatch.outcome` uses the single token `"parked"` (cause distinction lives in the `event_log` `parked` payload), since `dispatch.outcome` is free-text and ENG-164's "count separately" need is met by the event payload + `dispatch_outcomes` summary.

**Placeholder scan:** no TBD/TODO; every code step shows real code; test helper modules (`git-project.ts`, `run-harness.ts`) are specified with their responsibilities and creation is folded into the task that first needs them.

**Type consistency:** `FailureCause` (Task 1) ← `ParkInfo.cause` excludes `"transient"` (Task 3) ← `event_log` payload `cause` (Task 4). `resumeContext: { stepKey; transcript }` identical in `DispatchDeps`/`RegistryDeps` (Task 6). `RunResult.park?: ParkInfo` (Task 4) consumed by `run.ts`/`park.ts` (Tasks 5/6). `parkDir`/`dumpPark`/`resumeRun` signatures consistent across Tasks 5–7.
