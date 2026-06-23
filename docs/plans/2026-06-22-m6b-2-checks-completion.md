# M6b-2 — Checks-System Poll + `merge → released` Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the `merge` stage that M6b-1 left parked-awaiting-checks: deliver the `external_pr_result` and `external_checks` signals so a ticket flows `merge → released` end-to-end.

**Architecture:** The durable-signal engine (`signal` table, `awaitSignal`/`deliverSignal`) already exists and is the park/un-park mechanism — a *pending* signal drops a ticket from `v_ready_tickets`; a *delivered* one lets it back in. M6b-2 builds the first real signal *deliverers*: (1) the outbox drainer delivers `external_pr_result` (the PR ref) when it sends a `pr_create` row; (2) a new in-`tick` checks poll delivers `external_checks` — auto-pass when `profile.checksSystem === "none"` (human merge stays the gate), or by polling a vendor-neutral `ChecksPort` when `"github"`. The resolver is unchanged (it already gates on `hasDelivered(external_checks)` then `hasDelivered(human_merge_approval)`).

**Tech Stack:** TypeScript + Bun (`bun:sqlite`), zod, `@octokit/rest` (confined to one adapter file). Commands: `bun test`, `bun run lint`, `bun run typecheck`, `bun run build`.

## Global Constraints

These are load-bearing invariants. Code that violates them is wrong even if tests pass. Copy verbatim into every task's attention.

- **Vendor-SDK firewall (operator headline, zero lock-in):** `@octokit/*` is imported in **exactly one file** — `src/integrations/adapters/github.ts`. The new GitHub checks adapter (`github-checks.ts`) gets its Octokit client by importing the `githubClient()` helper *from* `github.ts` — it must **never** `import ... from "@octokit/..."`. Grep `@octokit` across `src/` must return exactly one file.
- **Vendor-neutral port:** the core depends only on `ChecksPort` (the `ForgePort` / `IssueTrackerPort` precedent). GitLab tomorrow = one new adapter file + registering it in the adapter map; zero core change, zero schema change.
- **Checks selection comes from the Profile, NOT RuntimeConfig.** `profile.checksSystem ∈ {"github","external","none"}` is a *probed fact about the repo* (product shape). It is NOT an operator runtime policy, so it stays in `ProfileSchema` and `selectChecks` is keyed on it. Do not add a checks field to `RuntimeConfig`. (config-layering: probed shape ≠ operator policy.)
- **The projector/poll is the sole outward path; signals are the sole inbound path.** Control flow never reads Linear/GitHub directly. The poll *reaches out* (control-loop §7.3) and turns the result into a delivered signal; the resolver only ever reads signal state.
- **Idempotency, two layers.** The `signal.idempotency_key` column has a UNIQUE index — use `INSERT OR IGNORE` for any keyed delivery. Escalations raised inside the per-tick poll must be guarded against duplicate insertion (a poll runs every tick).
- **A poll/projection failure NEVER blocks the loop.** `pollChecks` wraps each signal in its own try/catch and never throws out of `tick`; an errored poll leaves the ticket parked for the next tick.
- **Keep the lightweight `{kind:"wait"}` park.** Do NOT build await-step machinery, do NOT wire `consumeSignal`, do NOT set `await_signal_id`. The resolver stays as-is (`hasDelivered`-gated); delivery un-parks by flipping the signal + `ticket.status='active'`.
- **`checksSystem` behavior:** `"none"` → auto-deliver `external_checks` (skip; human merge stays the gate, control-loop S8). `"github"` → poll the `ChecksPort`. `"external"` → unsupported in M6b-2: leave parked, no delivery (carry — the wait-budget milestone escalates perpetual parks).
- **No schema change.** The `signal` table already has every column and status (`pending`/`delivered`/`consumed`, `payload_json`, `idempotency_key` UNIQUE) needed. Verify `git diff main -- src/db/schema.sql docs/architecture/schema.sql` is empty at the end.
- **Timestamps are UTC** via `nowUtc()` (`src/util/time.ts`).

---

## File Structure

**New files:**
- `src/integrations/checks.ts` — the vendor-neutral `ChecksPort` interface + `CheckVerdict` type + `selectChecks` factory (mirrors `src/integrations/forge.ts`).
- `src/integrations/adapters/fake-checks.ts` — in-memory recording `ChecksPort` for tests (mirrors `fake-forge.ts`).
- `src/integrations/adapters/github-checks.ts` — the GitHub checks adapter; imports `githubClient` from `github.ts` (NOT `@octokit`). The SDK-aggregation path is a documented, smoke-tested edge (the `githubForge` precedent).
- `src/daemon/poll-checks.ts` — `pollChecks`, the in-`tick` delivery of `external_checks`.
- `test/integrations/checks.test.ts`, `test/integrations/github-checks.test.ts`, `test/integrations/lockin.test.ts` (firewall grep), `test/daemon/projector-pr-result.test.ts`, `test/daemon/poll-checks.test.ts`, `test/dispatch/merge-complete-e2e.test.ts`.

**Modified files:**
- `src/integrations/adapters/github.ts` — extract & export `githubClient()`; refactor `githubForge` to use it; (Task 6) paginate the two probe reads + surface git-push stderr.
- `src/db/repos/signal.ts` — add `recordDelivered()` (idempotent, keyed) + `listPendingByType()`.
- `src/daemon/projector.ts` — the `pr_create` arm delivers `external_pr_result`; (Task 6) zod-validate forge payloads.
- `src/daemon/loop.ts` — `tick` gains `opts.profile`; calls `pollChecks` after the drain.

**Untouched (confirm at review):** `src/daemon/resolver.ts` (already correct), `src/config/runtime-config.ts` (no checks field), `src/db/schema.sql` (no change), `src/dispatch/profile.ts` (`checksSystem` enum already present).

---

### Task 1: `ChecksPort` + `selectChecks` + `fakeChecks`

**Files:**
- Create: `src/integrations/checks.ts`
- Create: `src/integrations/adapters/fake-checks.ts`
- Test: `test/integrations/checks.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `type CheckVerdict = "passing" | "failing" | "pending"`
  - `interface ChecksPort { status(opts: { ref: string }): Promise<CheckVerdict> }` — `ref` is a commit SHA.
  - `type ChecksFactory = () => ChecksPort`
  - `function selectChecks(checksSystem: string, adapters: Record<string, ChecksFactory>): ChecksPort | null` — returns the adapter for a registered key, or `null` for an unregistered key (incl. `"none"`/`"external"`).
  - `function fakeChecks(verdict?: CheckVerdict): ChecksPort & { calls: Array<{ method: string; args: unknown[] }> }` — records calls; returns `verdict` (default `"passing"`).

- [ ] **Step 1: Write the failing test**

`test/integrations/checks.test.ts`:
```ts
import { expect, test } from "bun:test";
import { selectChecks } from "../../src/integrations/checks.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";

test("selectChecks returns the registered adapter", () => {
  const port = selectChecks("github", { github: () => fakeChecks("passing") });
  expect(port).not.toBeNull();
});

test("selectChecks returns null for an unregistered key (none/external/unknown)", () => {
  const adapters = { github: () => fakeChecks() };
  expect(selectChecks("none", adapters)).toBeNull();
  expect(selectChecks("external", adapters)).toBeNull();
  expect(selectChecks("gitlab", adapters)).toBeNull();
});

test("fakeChecks records calls and returns the configured verdict", async () => {
  const c = fakeChecks("failing");
  const v = await c.status({ ref: "abc123" });
  expect(v).toBe("failing");
  expect(c.calls).toEqual([{ method: "status", args: [{ ref: "abc123" }] }]);
});

test("fakeChecks defaults to passing", async () => {
  expect(await fakeChecks().status({ ref: "x" })).toBe("passing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integrations/checks.test.ts`
Expected: FAIL — `Cannot find module '../../src/integrations/checks.ts'`.

- [ ] **Step 3: Write `src/integrations/checks.ts`**

```ts
/** Vendor-neutral checks-system port (zero lock-in). The core depends only on this interface;
 *  GitHub checks / GitLab pipelines / etc. are config-selected adapters behind it. Mirrors
 *  src/integrations/forge.ts. Selection is keyed on the PROBED profile.checksSystem (product
 *  shape), not RuntimeConfig — see docs/architecture (config layering). */
export type CheckVerdict = "passing" | "failing" | "pending";

export interface ChecksPort {
  /** Aggregate the checks state for a commit `ref` (sha): all green → "passing"; any
   *  terminal failure → "failing"; still running / not yet reported → "pending". */
  status(opts: { ref: string }): Promise<CheckVerdict>;
}

export type ChecksFactory = () => ChecksPort;

/** Build the checks port for a project's probed checks system, or null when there is no
 *  pollable system (e.g. "none" → human merge is the gate; "external" → no adapter yet). */
export function selectChecks(
  checksSystem: string,
  adapters: Record<string, ChecksFactory>,
): ChecksPort | null {
  const factory = adapters[checksSystem];
  return factory ? factory() : null;
}
```

- [ ] **Step 4: Write `src/integrations/adapters/fake-checks.ts`**

```ts
import type { CheckVerdict, ChecksPort } from "../checks.ts";

/** In-memory recording ChecksPort for tests (the fakeForge analogue). Returns a fixed verdict. */
export function fakeChecks(
  verdict: CheckVerdict = "passing",
): ChecksPort & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async status(opts: { ref: string }): Promise<CheckVerdict> {
      calls.push({ method: "status", args: [opts] });
      return verdict;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/integrations/checks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/integrations/checks.ts src/integrations/adapters/fake-checks.ts test/integrations/checks.test.ts
git commit -m "feat(m6b-2): ChecksPort + selectChecks + fakeChecks (vendor-neutral checks port)"
```

---

### Task 2: GitHub checks adapter via a shared `githubClient` (firewall preserved)

**Files:**
- Modify: `src/integrations/adapters/github.ts` (extract & export `githubClient`; refactor `githubForge` to use it)
- Create: `src/integrations/adapters/github-checks.ts`
- Create: `test/integrations/github-checks.test.ts`
- Create: `test/integrations/lockin.test.ts`

**Interfaces:**
- Consumes: `ChecksPort`, `CheckVerdict` (Task 1).
- Produces:
  - `function githubClient(opts: { repoPath: string; token?: string }): { octokit: Octokit; owner: string; repo: string }` (exported from `github.ts`) — builds `new Octokit({ auth })` (token from `opts.token ?? GITHUB_TOKEN`, throws if absent) and resolves `{owner,repo}` from the `origin` remote.
  - `function githubChecks(opts: { repoPath: string; token?: string }): ChecksPort` (in `github-checks.ts`).

**Context:** `github.ts` currently builds Octokit + resolves owner/repo *inside* `githubForge` (lines 88–97). Extract that into `githubClient` so both the forge and checks adapters share it and `@octokit` stays in this one file. `github-checks.ts` imports `githubClient` (the returned `octokit` carries its type by inference — do **not** add an `@octokit` import to `github-checks.ts`).

- [ ] **Step 1: Write the failing tests**

`test/integrations/github-checks.test.ts` (only the token-guard wiring is unit-testable; the SDK-aggregation path is a smoke-tested edge like `githubForge`):
```ts
import { expect, test } from "bun:test";
import { githubChecks } from "../../src/integrations/adapters/github-checks.ts";

test("githubChecks throws a clear setup error when no token is available", () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "";
  try {
    expect(() => githubChecks({ repoPath: "/tmp/does-not-matter" })).toThrow(/token/i);
  } finally {
    if (prev === undefined) process.env.GITHUB_TOKEN = undefined as unknown as string;
    else process.env.GITHUB_TOKEN = prev;
  }
});
```

`test/integrations/lockin.test.ts` (the firewall — `@octokit` lives in exactly one file):
```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("@octokit is imported in exactly one adapter file (github.ts)", () => {
  const dir = join(import.meta.dir, "../../src/integrations/adapters");
  const importers = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /from\s+["']@octokit\//.test(readFileSync(join(dir, f), "utf8")));
  expect(importers).toEqual(["github.ts"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/integrations/github-checks.test.ts test/integrations/lockin.test.ts`
Expected: FAIL — `github-checks.ts` does not exist yet.

- [ ] **Step 3: Extract `githubClient` in `src/integrations/adapters/github.ts`**

Add this exported function (place it just above `githubForge`, after `resolveOwnerRepo`):
```ts
/** Build an authenticated Octokit client + resolve {owner,repo} from the repo's origin remote.
 *  Shared by every GitHub adapter (forge, checks) so all `@octokit/*` imports stay in this one
 *  file. Token from opts or GITHUB_TOKEN; a missing token is a setup/GOAL-INSTALL failure. */
export function githubClient(opts: { repoPath: string; token?: string }): {
  octokit: Octokit;
  owner: string;
  repo: string;
} {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "githubClient: no GitHub token. Set GITHUB_TOKEN (or pass opts.token) — this is a setup/GOAL-INSTALL touchpoint.",
    );
  }
  const { owner, repo } = resolveOwnerRepo(opts.repoPath);
  return { octokit: new Octokit({ auth: token }), owner, repo };
}
```

Then refactor `githubForge` to use it — replace lines 89–97 (the token check + `resolveOwnerRepo` + `new Octokit`) with:
```ts
export function githubForge(opts: { repoPath: string; token?: string }): ForgePort {
  const { repoPath } = opts;
  const { octokit, owner, repo } = githubClient(opts);
  // ... rest of githubForge unchanged ...
```
(Keep everything from `return { async push... }` onward exactly as-is.)

- [ ] **Step 4: Write `src/integrations/adapters/github-checks.ts`**

```ts
/**
 * The official-SDK GitHub *checks* adapter — the thin vendor edge implementing the neutral
 * `ChecksPort`. It imports the shared `githubClient` from `./github.ts` (which owns the single
 * `@octokit/*` import) — this file MUST NOT import `@octokit` directly (zero-lock-in firewall).
 *
 * The aggregation (check-runs + legacy commit statuses → passing/failing/pending) is a documented,
 * NOT-unit-tested SDK edge — it needs a live token + repo; the `githubForge` precedent. It is
 * verified by typecheck + build + the operator smoke test below. The core poll logic
 * (`pollChecks`) is exercised with `fakeChecks`.
 *
 * SMOKE TEST (operator-run): point at a real clone with a pushed branch + a commit that has CI:
 *   GITHUB_TOKEN=ghp_xxx bun run -e '
 *     import { githubChecks } from "./src/integrations/adapters/github-checks.ts";
 *     const c = githubChecks({ repoPath: "/abs/path/to/clone" });
 *     console.log(await c.status({ ref: "<commit sha with checks>" }));
 *   '
 * Expect: "passing" when all checks are green, "failing" on a red check, "pending" while running.
 */
import { githubClient } from "./github.ts";
import type { CheckVerdict, ChecksPort } from "../checks.ts";

/** GitHub checks adapter. Aggregates the modern Checks API (check-runs) and the legacy
 *  commit-status API for a commit `ref`. Register as
 *  `{ github: () => githubChecks({ repoPath: profile.targetRepo }) }`. */
export function githubChecks(opts: { repoPath: string; token?: string }): ChecksPort {
  const { octokit, owner, repo } = githubClient(opts);

  return {
    async status({ ref }: { ref: string }): Promise<CheckVerdict> {
      // Modern Checks API (paginated — a commit can have many check-runs).
      const runs = await octokit.paginate(octokit.checks.listForRef, { owner, repo, ref });
      // Legacy commit-status API (some CIs still post statuses, not check-runs).
      const statuses = await octokit.paginate(octokit.repos.listCommitStatusesForRef, {
        owner,
        repo,
        ref,
      });

      const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
      let anyFailing = false;
      let anyPending = false;
      let anyReported = false;

      for (const run of runs) {
        anyReported = true;
        if (run.status !== "completed") anyPending = true;
        else if (run.conclusion && FAIL_CONCLUSIONS.has(run.conclusion)) anyFailing = true;
      }
      // Collapse legacy statuses to the latest state per context (the API returns newest first).
      const seen = new Set<string>();
      for (const s of statuses) {
        if (seen.has(s.context)) continue;
        seen.add(s.context);
        anyReported = true;
        if (s.state === "failure" || s.state === "error") anyFailing = true;
        else if (s.state === "pending") anyPending = true;
      }

      if (anyFailing) return "failing";
      if (anyPending) return "pending";
      if (anyReported) return "passing";
      // No checks reported yet for this commit — treat as still pending (re-poll). A repo with
      // genuinely no checks should be configured checksSystem="none", not "github".
      return "pending";
    },
  };
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `bun test test/integrations/github-checks.test.ts test/integrations/lockin.test.ts && bun run typecheck`
Expected: PASS (2 tests) and typecheck clean. If typecheck flags the `octokit.paginate` argument shapes, adjust to the route-string form `octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref })` and the equivalent status route — keep the same aggregation. Do not add an `@octokit` import to satisfy types (use inference from `githubClient`).

- [ ] **Step 6: Run the existing forge tests to confirm the refactor didn't break `githubForge`**

Run: `bun test test/integrations/github-adapter.test.ts test/integrations/forge.test.ts`
Expected: PASS (the `githubClient` extraction is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add src/integrations/adapters/github.ts src/integrations/adapters/github-checks.ts test/integrations/github-checks.test.ts test/integrations/lockin.test.ts
git commit -m "feat(m6b-2): GitHub checks adapter via shared githubClient (@octokit firewall preserved)"
```

---

### Task 3: `external_pr_result` delivery from the drainer (+ signal repo helpers)

**Files:**
- Modify: `src/db/repos/signal.ts` (add `recordDelivered`, `listPendingByType`)
- Modify: `src/daemon/projector.ts` (the `pr_create` arm delivers `external_pr_result`)
- Test: `test/daemon/projector-pr-result.test.ts`

**Interfaces:**
- Consumes: existing `enqueue`/`drainOutbox` (projector), `fakeForge` (Task 1 precedent).
- Produces:
  - `function recordDelivered(db, p: { ticketId: number; signalType: string; payload?: unknown; idempotencyKey: string }): void` — inserts a signal already in `status='delivered'` (a data-carrier, never pending), `INSERT OR IGNORE` on the unique key. Idempotent.
  - `function listPendingByType(db, signalType: string): SignalRow[]` — all pending signals of a type, across tickets (used by Task 4's poll).
  - Behavior: after the drainer successfully sends a `pr_create` row, an `external_pr_result` signal exists with `status='delivered'` and `payload_json` `{ ref, url }`.

**Context:** `src/daemon/projector.ts:101-106` — the `pr_create` arm calls `f.ensurePr(...)` and returns `pr.ref` (→ `response_ref` via `markSent`). The comment there already says *"M6b-2 delivers it as external_pr_result."* The resolver does NOT await `external_pr_result` (it is a durable data-carrier for the deferred human-merge poll, control-loop §7), so it is recorded directly as `delivered`, never `pending`.

- [ ] **Step 1: Write the failing test**

`test/daemon/projector-pr-result.test.ts`:
```ts
import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue } from "../../src/db/repos/projection-outbox.ts";
import { hasDelivered, listPendingByType, recordDelivered } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

test("recordDelivered inserts a delivered signal idempotently (OR IGNORE on key)", () => {
  const { db, ticketId } = makeTestDb();
  recordDelivered(db, { ticketId, signalType: "external_pr_result", payload: { ref: "7" }, idempotencyKey: "K1" });
  recordDelivered(db, { ticketId, signalType: "external_pr_result", payload: { ref: "7" }, idempotencyKey: "K1" });
  const row = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM signal WHERE ticket_id = ?")
    .get(ticketId);
  expect(row?.n).toBe(1);
  expect(hasDelivered(db, ticketId, "external_pr_result")).toBe(true);
  db.close();
});

test("listPendingByType returns pending signals of a type across tickets", () => {
  const { db, ticketId } = makeTestDb();
  db.query(
    "INSERT INTO signal (ticket_id, signal_type, status, requested_at) VALUES (?, 'external_checks', 'pending', '2026-01-01T00:00:00Z')",
  ).run(ticketId);
  const pending = listPendingByType(db, "external_checks");
  expect(pending.length).toBe(1);
  expect(pending[0].ticket_id).toBe(ticketId);
  db.close();
});

test("draining a pr_create row delivers external_pr_result carrying the PR ref", async () => {
  const { db, ticketId } = makeTestDb();
  const ticket = getTicket(db, ticketId);
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "pr_create",
    payload: { branch: "b", base: "main", title: "t", body: "x" },
    idempotencyKey: `${ticket?.ident}:pr_create:b`,
  });

  await drainOutbox(db, { issueTracker: fakeIssueTracker(), forge: fakeForge() });

  expect(hasDelivered(db, ticketId, "external_pr_result")).toBe(true);
  const sig = db
    .query<{ payload_json: string | null }, [number]>(
      "SELECT payload_json FROM signal WHERE ticket_id = ? AND signal_type = 'external_pr_result'",
    )
    .get(ticketId);
  const payload = JSON.parse(sig?.payload_json ?? "{}");
  expect(typeof payload.ref).toBe("string"); // fakeForge.ensurePr → "fake-pr-1"
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/projector-pr-result.test.ts`
Expected: FAIL — `recordDelivered`/`listPendingByType` are not exported.

- [ ] **Step 3: Add the signal repo helpers in `src/db/repos/signal.ts`**

Append after `hasDelivered`:
```ts
/** Insert a signal already in 'delivered' (a data-carrier the resolver never awaits, e.g.
 *  external_pr_result). Idempotent: INSERT OR IGNORE on the unique idempotency_key. */
export function recordDelivered(
  db: Database,
  p: { ticketId: number; signalType: string; payload?: unknown; idempotencyKey: string },
): void {
  const now = nowUtc();
  db.query(
    `INSERT OR IGNORE INTO signal
       (ticket_id, signal_type, status, payload_json, idempotency_key, requested_at, delivered_at)
     VALUES ($t, $ty, 'delivered', $p, $key, $now, $now)`,
  ).run({
    $t: p.ticketId,
    $ty: p.signalType,
    $p: p.payload === undefined ? null : JSON.stringify(p.payload),
    $key: p.idempotencyKey,
    $now: now,
  });
}

/** All pending signals of a given type, across tickets (the checks poll's work-list). */
export function listPendingByType(db: Database, signalType: string): SignalRow[] {
  return db
    .query<SignalRow, [string]>(
      `SELECT ${COLS} FROM signal WHERE signal_type = ? AND status = 'pending' ORDER BY id`,
    )
    .all(signalType);
}
```

- [ ] **Step 4: Deliver `external_pr_result` in the drainer's `pr_create` arm**

In `src/daemon/projector.ts`, add the import (merge into the existing signal import on line 11):
```ts
import { insertPending as insertSignal, recordDelivered } from "../db/repos/signal.ts";
```
Then change the `pr_create` case (lines 101-106) to deliver the result before returning:
```ts
      case "pr_create": {
        const pr = await f.ensurePr(
          payload as { branch: string; base: string; title: string; body: string },
        );
        // The drainer delivers external_pr_result (control-loop §7): the durable PR-ref record the
        // deferred human-merge poll consumes. A data-carrier — recorded delivered, never pending.
        recordDelivered(db, {
          ticketId: row.ticket_id,
          signalType: "external_pr_result",
          payload: { ref: pr.ref, url: pr.url },
          idempotencyKey: `${ticket.ident}:pr_result`,
        });
        return pr.ref; // → response_ref (the PR#)
      }
```
(`ticket` is already in scope from the top of `applyRow`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/daemon/projector-pr-result.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the existing projector + merge tests (no regression)**

Run: `bun test test/daemon/projector-forge.test.ts test/dispatch/merge-e2e.test.ts`
Expected: PASS — the existing merge-e2e "parks awaiting external_checks" tests still pass (delivering `external_pr_result` does not un-park; the ticket parks on `external_checks`).

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/signal.ts src/daemon/projector.ts test/daemon/projector-pr-result.test.ts
git commit -m "feat(m6b-2): drainer delivers external_pr_result + recordDelivered/listPendingByType helpers"
```

---

### Task 4: `pollChecks` (deliver `external_checks`) + `tick` wiring

**Files:**
- Create: `src/daemon/poll-checks.ts`
- Modify: `src/daemon/loop.ts` (`tick` gains `opts.profile`; calls `pollChecks` after the drain)
- Test: `test/daemon/poll-checks.test.ts`

**Interfaces:**
- Consumes: `ChecksPort` (Task 1), `listPendingByType` (Task 3), `deliverSignal` (`src/engine/signals.ts`), `getTicket`/`setTicketStatus` (ticket repo), `getLatestForTicket` (`src/db/repos/dispatch.ts` — `.branch_head_sha`), `listPending` (`src/db/repos/signal.ts`), `appendEvent` (`src/db/repos/event-log.ts`), `insertPending` (signal repo).
- Produces:
  - `function pollChecks(db, profile: { checksSystem: string }, checks?: ChecksPort | null): Promise<void>` — for each pending `external_checks` signal: `"none"` → deliver; `"github"` → poll `checks` for the dispatch head sha and deliver on `"passing"`, escalate (guarded) on `"failing"`, leave parked on `"pending"`; anything else → leave parked. Never throws.
  - `tick` accepts `opts.profile?: { checksSystem: string }` and, when present, calls `pollChecks` after `drainOutbox`.

- [ ] **Step 1: Write the failing test**

`test/daemon/poll-checks.test.ts`:
```ts
import { expect, test } from "bun:test";
import { pollChecks } from "../../src/daemon/poll-checks.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { hasDelivered, listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { awaitSignal } from "../../src/engine/signals.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Park a ticket on external_checks and give it a completed dispatch with a head sha. */
function parkOnChecks(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const d = insertDispatch(db, { ticketId, dispatchId: "D1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "sha-1" });
  awaitSignal(db, { ticketId, signalType: "external_checks" });
}

test("checksSystem none → external_checks auto-delivered (human merge stays the gate)", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  await pollChecks(db, { checksSystem: "none" });
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);
  expect(getTicket(db, ticketId)?.status).toBe("active"); // un-parked
  db.close();
});

test("github + passing → delivered; polls the head sha", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  const checks = fakeChecks("passing");
  await pollChecks(db, { checksSystem: "github" }, checks);
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);
  expect((checks.calls[0].args[0] as { ref: string }).ref).toBe("sha-1");
  db.close();
});

test("github + failing → NOT delivered, escalates once (guarded against spam)", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  const checks = fakeChecks("failing");
  await pollChecks(db, { checksSystem: "github" }, checks);
  await pollChecks(db, { checksSystem: "github" }, checks); // second tick must not add a 2nd escalation
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false);
  const pending = listPending(db, ticketId);
  expect(pending.filter((s) => s.signal_type === "human_resume").length).toBe(1);
  db.close();
});

test("github + pending → left parked, no escalation", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  await pollChecks(db, { checksSystem: "github" }, fakeChecks("pending"));
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false);
  expect(listPending(db, ticketId).some((s) => s.signal_type === "human_resume")).toBe(false);
  db.close();
});

test("checksSystem external → unsupported: left parked, no delivery, no escalation", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  await pollChecks(db, { checksSystem: "external" }, fakeChecks("passing"));
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false);
  expect(listPending(db, ticketId).some((s) => s.signal_type === "human_resume")).toBe(false);
  db.close();
});

test("a throwing checks port does not throw out of pollChecks (loop never blocks)", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  const throwingChecks = {
    async status(): Promise<never> {
      throw new Error("network down");
    },
  };
  await pollChecks(db, { checksSystem: "github" }, throwingChecks);
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false); // left parked, no crash
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/poll-checks.test.ts`
Expected: FAIL — `Cannot find module '../../src/daemon/poll-checks.ts'`.

- [ ] **Step 3: Write `src/daemon/poll-checks.ts`**

```ts
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import { insertPending as insertSignal, listPending, listPendingByType } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { deliverSignal } from "../engine/signals.ts";
import type { ChecksPort } from "../integrations/checks.ts";

/** Raise a one-shot escalation for a ticket: a pending human_resume + an event. Guarded — if the
 *  ticket already has a pending human_resume, do nothing (the poll runs every tick → no spam). The
 *  ticket stays parked (its external_checks signal stays pending). */
function escalateOnce(db: Database, ticketId: number, reason: string): void {
  if (listPending(db, ticketId).some((s) => s.signal_type === "human_resume")) return;
  db.transaction(() => {
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason });
  })();
}

/** Deliver the external_checks signal for every parked ticket by reaching out to the project's
 *  checks system (control-loop §7.3 — polling, not webhooks). Called once per tick. NEVER throws:
 *  a per-ticket failure leaves that ticket parked for the next tick. checksSystem:
 *    "none"   → auto-deliver (skip; the human merge approval stays the gate, S8)
 *    "github" → poll the ChecksPort for the dispatch head sha: passing→deliver, failing→escalate,
 *               pending→leave parked
 *    other    → unsupported (e.g. "external"): leave parked (carry: wait-budget escalation). */
export async function pollChecks(
  db: Database,
  profile: { checksSystem: string },
  checks?: ChecksPort | null,
): Promise<void> {
  for (const sig of listPendingByType(db, "external_checks")) {
    try {
      const ticket = getTicket(db, sig.ticket_id);
      if (!ticket) continue;

      if (profile.checksSystem === "none") {
        deliverSignal(db, sig.id, { result: "skipped" });
        continue;
      }
      if (profile.checksSystem === "github") {
        if (!checks) continue; // not wired this run — leave parked
        const sha = getLatestForTicket(db, ticket.id)?.branch_head_sha;
        if (!sha) continue; // nothing to poll against yet
        const verdict = await checks.status({ ref: sha });
        if (verdict === "passing") deliverSignal(db, sig.id, { result: "passing", sha });
        else if (verdict === "failing")
          escalateOnce(db, ticket.id, `checks failing for ${sha}`);
        // "pending" → leave parked, re-poll next tick
        continue;
      }
      // Unsupported checks system ("external"): leave parked (carry).
    } catch {
      // A transient poll failure must never block the loop — leave parked, retry next tick.
    }
  }
}
```

- [ ] **Step 4: Wire `pollChecks` into `tick` (`src/daemon/loop.ts`)**

Add the import and extend `tick`:
```ts
import { pollChecks } from "./poll-checks.ts";
```
Change the `tick` signature + body:
```ts
export async function tick(
  db: Database,
  registry: StepRegistry,
  opts?: {
    maxConcurrent?: number;
    config?: RuntimeConfig;
    ports?: ProjectorPorts;
    profile?: { checksSystem: string };
  },
): Promise<{ advanced: number }> {
  const max = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const ids = readyTicketIds(db).slice(0, max);
  let advanced = 0;
  for (const id of ids) {
    await advanceOneStep(db, id, registry, { config: opts?.config });
    advanced++;
  }
  if (opts?.ports) {
    await drainOutbox(db, opts.ports);
  }
  if (opts?.profile) {
    await pollChecks(db, opts.profile, opts.ports?.checks);
  }
  return { advanced };
}
```

- [ ] **Step 5: Add `checks?` to `ProjectorPorts` (`src/daemon/projector.ts`)**

So `opts.ports?.checks` typechecks. Add the import + field:
```ts
import type { ChecksPort } from "../integrations/checks.ts";
// ...
export interface ProjectorPorts {
  issueTracker: IssueTrackerPort;
  forge?: ForgePort;
  checks?: ChecksPort;
}
```
(The drainer ignores `checks` — it is consumed only by the poll. Optional, so existing `{ issueTracker, forge }` call sites still compile.)

- [ ] **Step 6: Run tests + typecheck to verify they pass**

Run: `bun test test/daemon/poll-checks.test.ts && bun run typecheck`
Expected: PASS (6 tests) + typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/poll-checks.ts src/daemon/loop.ts src/daemon/projector.ts test/daemon/poll-checks.test.ts
git commit -m "feat(m6b-2): pollChecks delivers external_checks (none auto-pass / github poll) + tick wiring"
```

---

### Task 5: `merge → released` completion end-to-end

**Files:**
- Test: `test/dispatch/merge-complete-e2e.test.ts` (new — leave the existing `merge-e2e.test.ts` parking tests intact)

**Interfaces:**
- Consumes: everything above, end-to-end via `tick`. `deliverSignal` to simulate the operator's `human_merge_approval` (the one human gate at cutover — control-loop S9; delivered by the operator inbox, modeled here by a direct deliver).

**Context:** This proves the whole loop M6b-1 left parked now completes. The existing `merge-e2e.test.ts` parks (it passes `{ ports }` but no `profile`, so the poll never runs). This new test passes `{ ports, profile }` so the poll delivers `external_checks`, then the test delivers `human_merge_approval`, and the ticket reaches `released`/`done`. Test both `checksSystem: "none"` (auto-pass) and `"github"` (fake passing) to cover both delivery arms. The `released → done` transition's `enqueueStageProjection` projects the tracker `setState('done')` (projector.ts STAGE_STATE), so assert the fake issue-tracker saw it.

- [ ] **Step 1: Write the e2e test**

`test/dispatch/merge-complete-e2e.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { tick } from "../../src/daemon/loop.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { hasDelivered, listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { deliverSignal } from "../../src/engine/signals.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { type Profile, parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

function registryFor(profile: Profile) {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("merge steps dispatch no agent");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-mc-")),
  });
}

function seedMergeTicket(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'merge' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
  const d = insertDispatch(db, { ticketId, dispatchId: "T-d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "headsha123" });
}

/** Drive ticks until predicate or MAX. */
async function driveUntil(
  db: ReturnType<typeof makeTestDb>["db"],
  reg: ReturnType<typeof registryFor>,
  opts: Parameters<typeof tick>[2],
  pred: () => boolean,
) {
  for (let i = 0; i < 20 && !pred(); i++) await tick(db, reg, opts);
}

test("merge → released completes: checksSystem none auto-passes, operator approves merge", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId);
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", commands: {}, checksSystem: "none" });
  const reg = registryFor(profile);
  const ports = { issueTracker: fakeIssueTracker(), forge: fakeForge() };

  // Poll auto-delivers external_checks; ticket then parks on human_merge_approval.
  await driveUntil(db, reg, { ports, profile }, () =>
    listPending(db, ticketId).some((s) => s.signal_type === "human_merge_approval"),
  );
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);

  // Operator approves the merge (the one human gate, delivered via the inbox in production).
  const approval = listPending(db, ticketId).find((s) => s.signal_type === "human_merge_approval");
  deliverSignal(db, approval?.id ?? 0, { merged: true });

  await driveUntil(db, reg, { ports, profile }, () => getTicket(db, ticketId)?.status === "done");

  const t = getTicket(db, ticketId);
  expect(t?.stage).toBe("released");
  expect(t?.status).toBe("done");
  // The released→done transition projected the tracker to 'done'.
  expect(ports.issueTracker.calls.some((c) => c.method === "setState" && c.args[1] === "done")).toBe(true);
  db.close();
});

test("merge → released completes: checksSystem github with passing checks", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId);
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", commands: {}, checksSystem: "github" });
  const reg = registryFor(profile);
  const ports = { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: fakeChecks("passing") };

  await driveUntil(db, reg, { ports, profile }, () =>
    listPending(db, ticketId).some((s) => s.signal_type === "human_merge_approval"),
  );
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);

  const approval = listPending(db, ticketId).find((s) => s.signal_type === "human_merge_approval");
  deliverSignal(db, approval?.id ?? 0, { merged: true });
  await driveUntil(db, reg, { ports, profile }, () => getTicket(db, ticketId)?.status === "done");

  const t = getTicket(db, ticketId);
  expect(t?.stage).toBe("released");
  expect(t?.status).toBe("done");
  db.close();
});
```

- [ ] **Step 2: Run the e2e to verify it passes**

Run: `bun test test/dispatch/merge-complete-e2e.test.ts`
Expected: PASS (2 tests). If a ticket fails to reach `done`, check the resolver order (merge: `external_checks` then `human_merge_approval` then advance) and that the poll ran (profile passed to `tick`).

- [ ] **Step 3: Run the full merge suite (no regression)**

Run: `bun test test/dispatch/merge-e2e.test.ts test/dispatch/merge-handlers.test.ts test/dispatch/merge-complete-e2e.test.ts`
Expected: PASS — the original parking tests still park; the new ones complete.

- [ ] **Step 4: Commit**

```bash
git add test/dispatch/merge-complete-e2e.test.ts
git commit -m "test(m6b-2): merge→released completion e2e (none auto-pass + github passing)"
```

---

### Task 6: Carry-closing hardening (probe pagination · git-push stderr · zod payloads)

**Files:**
- Modify: `src/integrations/adapters/github.ts` (paginate `pulls.list` + `issues.listComments`; surface git-push stderr)
- Modify: `src/daemon/projector.ts` (zod-validate forge outbox payloads in `applyRow`)
- Test: `test/daemon/projector-payload-validation.test.ts`

**Interfaces:**
- Consumes: existing `applyRow`/`drainOutbox`, zod.
- Produces: a malformed forge outbox payload is rejected as a transient error (drainer bumps/escalates) instead of an unchecked cast; the two GitHub probe reads are paginated; a failed git push surfaces the captured stderr in the thrown error.

**Context:** These three are the M6b-1 review carries, all in files M6b-2 already touches. The `issues.listComments` single-page probe is a real B3/CL-3 idempotency bug (a PR with many comments could miss the dedup tag → duplicate comment). The pagination + stderr changes are in `githubForge`'s not-unit-tested SDK paths (the documented edge) — verified by typecheck + build + reading; only the zod-payload change is unit-tested here.

- [ ] **Step 1: Write the failing test (zod payload validation)**

`test/daemon/projector-payload-validation.test.ts`:
```ts
import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a malformed forge push payload is a transient error (bumped, not crashing the drain)", async () => {
  const { db, ticketId } = makeTestDb();
  const ticket = getTicket(db, ticketId);
  // push payload missing required `sha` — must be rejected, not blindly cast.
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "push",
    payload: { branch: "b" },
    idempotencyKey: `${ticket?.ident}:push:bad`,
  });

  // drainOutbox never throws out; the bad row is retried (attempts bumped), loop continues.
  const res = await drainOutbox(db, { issueTracker: fakeIssueTracker(), forge: fakeForge() });
  expect(res.sent).toBe(0);
  const pending = listPending(db).find((r) => r.op === "push");
  expect(pending?.attempts).toBeGreaterThan(0); // bumped, still pending (under budget)
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/projector-payload-validation.test.ts`
Expected: FAIL — the current `payload as {...}` cast does not reject the missing `sha` (push silently called with `sha: undefined`, `markSent` runs, `sent === 1`).

- [ ] **Step 3: Zod-validate forge payloads in `src/daemon/projector.ts`**

Add `import { z } from "zod";` and zod schemas near the top:
```ts
const PushPayload = z.object({ branch: z.string(), sha: z.string() });
const PrCreatePayload = z.object({
  branch: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
});
const PrCommentPayload = z.object({ prRef: z.string(), body: z.string() });
```
Replace the forge arm's raw casts:
```ts
    switch (row.op) {
      case "push":
        await f.push(PushPayload.parse(payload));
        return null;
      case "pr_create": {
        const pr = await f.ensurePr(PrCreatePayload.parse(payload));
        recordDelivered(db, {
          ticketId: row.ticket_id,
          signalType: "external_pr_result",
          payload: { ref: pr.ref, url: pr.url },
          idempotencyKey: `${ticket.ident}:pr_result`,
        });
        return pr.ref;
      }
      case "pr_comment": {
        const c = PrCommentPayload.parse(payload);
        return await f.addPrComment(c.prRef, c.body, row.idempotency_key);
      }
      default:
        throw new Error(`projector: unknown forge op '${row.op}'`);
    }
```
(A `ZodError` thrown by `.parse` is caught by `drainOutbox`'s per-row try/catch → bumped/escalated like any transient failure, so the loop never blocks.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/daemon/projector-payload-validation.test.ts test/daemon/projector-pr-result.test.ts test/daemon/projector-forge.test.ts`
Expected: PASS — the bad payload is bumped; valid payloads still send.

- [ ] **Step 5: Paginate the two GitHub probes + surface git-push stderr (`src/integrations/adapters/github.ts`)**

Paginate `ensurePr`'s open-PR probe — replace `octokit.pulls.list({...})` + `existing.data[0]`:
```ts
      const open = await octokit.paginate(octokit.pulls.list, {
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: "open",
      });
      const found = open[0];
      if (found) return { ref: String(found.number), url: found.html_url };
```
Paginate `addPrComment`'s comment probe — replace `octokit.issues.listComments({...})` + `existing.data.some(...)`:
```ts
      const comments = await octokit.paginate(octokit.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
      });
      if (comments.some((c) => (c.body ?? "").includes(tag))) return null;
```
Surface git-push stderr — replace the `execFileSync("git", [...,"push",...], { stdio: "pipe" })` call:
```ts
      try {
        execFileSync("git", ["-C", repoPath, "push", "origin", branch], { stdio: "pipe" });
      } catch (cause) {
        const stderr = (cause as { stderr?: Buffer }).stderr?.toString() ?? "";
        throw new Error(`githubForge.push: git push failed for ${branch}: ${stderr}`.trim(), { cause });
      }
```

- [ ] **Step 6: Typecheck, build, and run the adapter + firewall tests**

Run: `bun run typecheck && bun test test/integrations/github-adapter.test.ts test/integrations/lockin.test.ts`
Expected: typecheck clean; PASS. (If `octokit.paginate(octokit.pulls.list, ...)` trips types, use the route-string form, e.g. `octokit.paginate("GET /repos/{owner}/{repo}/pulls", {...})` — keep the same logic and add no `@octokit` import.)

- [ ] **Step 7: Commit**

```bash
git add src/integrations/adapters/github.ts src/daemon/projector.ts test/daemon/projector-payload-validation.test.ts
git commit -m "fix(m6b-2): paginate GitHub probes, surface git-push stderr, zod-validate forge payloads"
```

---

## Final Verification (run after all tasks)

```bash
bun test          # all green (existing 289 + the new M6b-2 tests)
bun run lint      # clean
bun run typecheck # clean
bun run build     # single binary builds (bundles @octokit/rest)
git diff main -- src/db/schema.sql docs/architecture/schema.sql   # EMPTY (no schema change)
grep -rl '@octokit/' src/   # exactly one file: src/integrations/adapters/github.ts
```

## Out of Scope (carries → later)

- **Daemon-entrypoint adapter wiring** (`makeProjectorPorts` factory calling `selectForge`/`selectIssueTracker`/`selectChecks` from env creds → `ProjectorPorts` into `tick`): deferred to the daemon-entrypoint milestone, where its caller will exist (the "don't build ahead of the caller" rule that deferred the config loader). M6b-2 ends with the loop fully working under injected ports.
- **`pr_comment` enqueuer** (escalation / review-finding comments on the PR): not on the `merge → released` path. Belongs with the comment-projections carry (the drainer arm + `addPrComment` already exist).
- **Wait-budget enforcement** (`signal.attempts`/`max_attempts`/`first_attempt_at`; control-loop §7.3): a perpetually-`pending` checks poll (or a parked `"external"` ticket) currently re-polls forever. Budget-driven escalation is a separate milestone.
- **`checksSystem: "external"` translator** (a non-GitHub CI poller).
- **Red-checks → re-code loopback (P1)** and **flaky re-run (P2)**: M6b-2 escalates a failing check to the operator (`human_resume`); the automatic loop-back-to-implement is post-cutover routing.
- **Live human-merge polling (S9, `[CL-STALE]`)**: M6b-2 models `human_merge_approval` as operator-delivered (the inbox); polling GitHub for the actual merge + stale-branch handling is deferred (it will consume the `external_pr_result` PR ref this milestone now records).
