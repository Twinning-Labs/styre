# M6b-1 — Forge Port (GitHub) + Merge-Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the forge-write half of the merge stage — a vendor-neutral `ForgePort` with an official-Octokit GitHub adapter, the drainer's `forge` dispatch arm, and the `merge:push` / `merge:pr-ensure` / `released:project` handlers — so a reviewed ticket pushes its branch and opens a PR through the one-way projector, with zero vendor lock-in.

**Architecture:** Mirrors the M6a issue-tracker substrate exactly. The merge handlers ENQUEUE `forge` outbox rows (the projector stays the sole outward writer); the `drainOutbox` projector gains a `forge` arm that dispatches by op (`push`/`pr_create`/`pr_comment`) to the injected `ForgePort`; the GitHub adapter (the only Octokit-importing file) does the `git push` + Octokit PR/comment calls, probe-idempotently. Selection is `RuntimeConfig.forge` via a `selectForge` factory mirroring `selectAgentRunner`. The PR# is captured in the outbox row's `response_ref`. The checks-system + the live merge→released completion are M6b-2.

**Tech Stack:** TypeScript + Bun + `bun:sqlite`; zod; `@octokit/rest` (official, new dep) + `git` CLI for the push; the M6a projector/outbox/port substrate + `FakeAgentRunner`-style fake ports.

## Global Constraints

- **Never commit to `main`.** Work on branch `feat/m6b-1-forge-merge` (already created).
- **Zero vendor lock-in (operator directive).** The core imports only `ForgePort`; `@octokit/rest` is imported in EXACTLY ONE file (the GitHub adapter). The outbox `target` is the neutral role `forge` (already in the schema from M6a — NO schema change in M6b-1). A new forge (GitLab) = a new adapter + a config value; no core/schema change. Mirror M6a's `IssueTrackerPort`/`selectIssueTracker` pattern verbatim.
- **One config object.** `forge` is a new field on the EXISTING `RuntimeConfig`, not a new type. Credentials (`GITHUB_TOKEN`) come from env (the `ANTHROPIC_API_KEY`/`LINEAR_API_KEY` precedent), never config values. The constructed adapter instance is an injected dep.
- **Sole outward writer / same-transaction.** Merge handlers ENQUEUE outbox rows (a daemon write); the projector applies them. No handler calls the forge SDK directly.
- **Two-layer idempotency** (B3/CL-3): outbox `idempotency_key` UNIQUE + `INSERT OR IGNORE` (re-enqueue no-op) AND the adapter probes external state (push → skip if remote ref already at the SHA; pr_create → reuse an existing PR for the branch; pr_comment → dedup on a `proj-key` tag).
- **A projection failure never blocks the loop** (reuse the M6a drainer's per-row try/catch + retry/escalate).
- Run the full gate before claiming done: `bun test` · `bun run lint` · `bun run typecheck` · `bun run build`. Every task's gate includes `bun run lint`; the Octokit-adapter task additionally must `bun run build` clean (the new dep bundles into the binary).
- **No schema change** (the `forge` target role already exists). If one becomes necessary, edit BOTH `src/db/schema.sql` and `docs/architecture/schema.sql`.

## Scope boundaries (deferred to M6b-2 / later — note, don't build)
- **`external_pr_result` signal delivery** (drainer delivering the PR# to a parked signal) → M6b-2 (where the checks poll consumes the PR#). M6b-1 only captures the PR# in the outbox `response_ref`.
- **The checks-system** (`ChecksPort` + `pollChecks` + `external_checks` delivery + `checksSystem=none` skip) → M6b-2.
- **The live merge→released completion** (reaching `released` through the resolver) → M6b-2 (needs checks). M6b-1's merge e2e reaches the `external_checks` park; `released:project` is tested in isolation.
- **Daemon-entrypoint adapter wiring** (constructing `{ github: () => githubForge(...) }` + env creds → `tick`) → M6b-2. M6b-1 injects fake ports in tests.
- **Cheap-LLM PR description** → later; M6b-1 uses a deterministic templated description (operator-approved).
- **Stale-branch handling (CL-STALE), automated merge detection, `pr_merge`** → later.

---

## File Structure

- **Create** `src/integrations/forge.ts` — `ForgePort` interface + `selectForge` factory.
- **Create** `src/integrations/adapters/fake-forge.ts` — in-memory recording forge (test double).
- **Create** `src/integrations/adapters/github.ts` — the official-Octokit GitHub adapter (+ `git push`).
- **Modify** `src/config/runtime-config.ts` — add `forge` field.
- **Modify** `src/daemon/projector.ts` — add the `forge` dispatch arm to `applyRow`; extend `ProjectorPorts` with optional `forge`.
- **Modify** `src/dispatch/handlers.ts` — register `merge:push`, `merge:pr-ensure`, `released:project`; add `renderPrBody`.
- **Tests:** `test/integrations/forge.test.ts`, `test/daemon/projector-forge.test.ts`, `test/dispatch/merge-handlers.test.ts`, `test/dispatch/merge-e2e.test.ts`.

---

### Task 1: `ForgePort` + factory + fake + config field

**Files:**
- Create: `src/integrations/forge.ts`
- Create: `src/integrations/adapters/fake-forge.ts`
- Modify: `src/config/runtime-config.ts`
- Test: `test/integrations/forge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ForgePort`:
    - `push(opts: { branch: string; sha: string }): Promise<void>`
    - `ensurePr(opts: { branch: string; base: string; title: string; body: string }): Promise<{ ref: string; url: string }>`
    - `addPrComment(prRef: string, body: string, idempotencyKey: string): Promise<string | null>`
  - `ForgeFactory = () => ForgePort`; `selectForge(config: { forge: string }, adapters: Record<string, ForgeFactory>): ForgePort` (mirrors `selectIssueTracker`; throws on unknown).
  - `fakeForge(): ForgePort & { calls: Array<{ method: string; args: unknown[] }> }` — records calls; `ensurePr` returns `{ ref: "fake-pr-<n>", url: "https://fake/pr/<n>" }`; `addPrComment` returns `"fake-pr-comment-<n>"`.
  - `RuntimeConfig` gains `forge: string` (default `"github"`).

- [ ] **Step 1: Write the failing tests**

Create `test/integrations/forge.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { selectForge } from "../../src/integrations/forge.ts";

test("selectForge returns the configured adapter", () => {
  const fake = fakeForge();
  expect(selectForge({ forge: "github" }, { github: () => fake })).toBe(fake);
});

test("selectForge throws on an unregistered adapter", () => {
  expect(() => selectForge({ forge: "gitlab" }, { github: () => fakeForge() })).toThrow();
});

test("fakeForge records calls and returns refs", async () => {
  const fake = fakeForge();
  await fake.push({ branch: "feat/x", sha: "abc" });
  const pr = await fake.ensurePr({ branch: "feat/x", base: "main", title: "t", body: "b" });
  const c = await fake.addPrComment(pr.ref, "hi", "k1");
  expect(fake.calls.map((x) => x.method)).toEqual(["push", "ensurePr", "addPrComment"]);
  expect(pr.ref).toContain("fake-pr");
  expect(c).not.toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/integrations/forge.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the port + factory**

Create `src/integrations/forge.ts`:

```typescript
/** Vendor-neutral forge (code-host) port (zero lock-in). The core depends only on this interface;
 *  GitHub/GitLab/etc. are config-selected adapters behind it. Mirrors src/integrations/issue-tracker.ts. */
export interface ForgePort {
  /** Push the feature branch to the remote at `sha`. Probe-idempotent: skip if the remote ref is
   *  already at `sha`. Feature branch only; force is with-lease and never on a protected branch. */
  push(opts: { branch: string; sha: string }): Promise<void>;
  /** Ensure a PR exists for `branch` into `base`. Probe-idempotent: reuse an existing PR if present.
   *  Returns the PR ref (number) + url. */
  ensurePr(opts: { branch: string; base: string; title: string; body: string }): Promise<{ ref: string; url: string }>;
  /** Comment on a PR, deduped by idempotencyKey (adapter probes existing comments). Returns the
   *  created comment id/ref, or null if it already existed. */
  addPrComment(prRef: string, body: string, idempotencyKey: string): Promise<string | null>;
}

export type ForgeFactory = () => ForgePort;

export function selectForge(
  config: { forge: string },
  adapters: Record<string, ForgeFactory>,
): ForgePort {
  const factory = adapters[config.forge];
  if (!factory) {
    throw new Error(`selectForge: no adapter registered for '${config.forge}'`);
  }
  return factory();
}
```

Create `src/integrations/adapters/fake-forge.ts`:

```typescript
import type { ForgePort } from "../forge.ts";

/** In-memory recording ForgePort for tests (the fakeIssueTracker analogue). */
export function fakeForge(): ForgePort & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async push(opts: { branch: string; sha: string }) {
      calls.push({ method: "push", args: [opts] });
    },
    async ensurePr(opts: { branch: string; base: string; title: string; body: string }) {
      calls.push({ method: "ensurePr", args: [opts] });
      return { ref: `fake-pr-${calls.length}`, url: `https://fake/pr/${calls.length}` };
    },
    async addPrComment(prRef: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addPrComment", args: [prRef, body, idempotencyKey] });
      return `fake-pr-comment-${calls.length}`;
    },
  };
}
```

- [ ] **Step 4: Add the config field**

In `src/config/runtime-config.ts`, add to `RuntimeConfigSchema` (alongside `issueTracker`):

```typescript
  // M6b: which forge (code-host) adapter handles push/PR ops. Vendor-neutral; creds via env.
  forge: z.string().default("github"),
```

- [ ] **Step 5: Run tests + full suite**

Run: `bun test test/integrations/forge.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS. Adding a defaulted `RuntimeConfig` field shouldn't break existing parses, BUT any test constructing a raw `RuntimeConfig` literal (without `forge`) will fail typecheck — fix by spreading `DEFAULT_RUNTIME_CONFIG` (the established pattern from M5b-3/M6a). Run `bun run typecheck` to find them.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/forge.ts src/integrations/adapters/fake-forge.ts src/config/runtime-config.ts test/integrations/forge.test.ts
git commit -m "feat(m6b-1): ForgePort + selectForge factory + fake forge + config field"
```

---

### Task 2: The official-Octokit GitHub adapter

**Files:**
- Create: `src/integrations/adapters/github.ts`
- Modify: `package.json` (add `@octokit/rest`)
- Test: build + typecheck (the core uses the fake forge; the real adapter is build-verified + a smoke note, like the Linear adapter). Any pure helper (e.g. owner/repo parsing) gets a unit test.

**Interfaces:**
- Consumes: `ForgePort` (implements it).
- Produces: `githubForge(opts: { repoPath: string; token?: string }): ForgePort` — backed by `@octokit/rest` (PR + comments) and the `git` CLI (push). `token` from `opts.token ?? process.env.GITHUB_TOKEN` (throw clearly if absent). Owner/repo derived from the git remote of `repoPath`. Register later as `{ github: () => githubForge({ repoPath: profile.targetRepo }) }` (the daemon-entrypoint wiring is an M6b-2 carry).

- [ ] **Step 1: Add the dependency**

Run: `bun add @octokit/rest`
Confirm it lands in `package.json` `dependencies`.

- [ ] **Step 2: Implement the adapter**

Create `src/integrations/adapters/github.ts` implementing `ForgePort`. Consult the `@octokit/rest` docs (Context7 `resolve-library-id "@octokit/rest"` then docs, or read `node_modules/@octokit/rest` types) for exact method names. Implement this BEHAVIOR:

- Construct `new Octokit({ auth: token })` with `token = opts.token ?? process.env.GITHUB_TOKEN` (throw a clear error naming `GITHUB_TOKEN` if absent — a GOAL-INSTALL touchpoint).
- Derive `{ owner, repo }` from the git remote: run `git -C ${repoPath} config --get remote.origin.url`, parse `owner/repo` from both SSH (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo.git`) forms. Extract this parsing into a pure, exported `parseGitHubRemote(url): { owner: string; repo: string } | null` helper and UNIT-TEST it (SSH form, HTTPS form, with/without `.git`, a non-GitHub url → null).
- `push({ branch, sha })`: **probe** — query the remote ref for `branch` (Octokit `git.getRef` for `heads/${branch}`, or `git -C repoPath ls-remote`); if it's already at `sha`, return (skip). Else `git -C ${repoPath} push origin ${branch}` (the daemon's authenticated push transfers the commit objects — Octokit can't push commit contents). Feature branch only; never force on a protected branch.
- `ensurePr({ branch, base, title, body })`: **probe** — list PRs for `head: ${owner}:${branch}` (Octokit `pulls.list`); if one exists, return its `{ ref: String(number), url: html_url }`. Else `pulls.create({ owner, repo, head: branch, base, title, body })` and return the created `{ ref, url }`.
- `addPrComment(prRef, body, idempotencyKey)`: append `\n\n<!-- proj-key: ${idempotencyKey} -->`; **probe** the PR's issue comments (`issues.listComments({ issue_number: Number(prRef) })`) for that tag; if present return null; else `issues.createComment(...)` and return the comment id.

Keep ALL `@octokit/rest` imports in THIS file. The neutral `ForgePort` comes from `../forge.ts`. Add the smoke-test note to the top-of-file JSDoc (how to run it manually with `GITHUB_TOKEN` against a scratch repo/PR).

- [ ] **Step 3: Unit-test the pure helper + typecheck + build**

Add `test/integrations/github-adapter.test.ts` for `parseGitHubRemote` (SSH/HTTPS/.git/none cases). Then:

Run: `bun test test/integrations/github-adapter.test.ts && bun run typecheck && bun run build`
Expected: helper tests PASS; typecheck + build clean (the binary bundles `@octokit/rest`). If `bun run build` fails to bundle Octokit, report BLOCKED with the error (do not vendor/work around).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/integrations/adapters/github.ts test/integrations/github-adapter.test.ts
git commit -m "feat(m6b-1): official-Octokit GitHub forge adapter (+ git push)"
```

---

### Task 3: The drainer's `forge` dispatch arm

**Files:**
- Modify: `src/daemon/projector.ts`
- Test: `test/daemon/projector-forge.test.ts`

**Interfaces:**
- Consumes: `ForgePort`.
- Produces:
  - `ProjectorPorts` gains `forge?: ForgePort` (OPTIONAL — M6a tests construct `{ issueTracker }` without forge; only forge rows need it).
  - `applyRow`'s `forge` arm (replacing the M6a `throw "no adapter for forge (M6b)"`): dispatch by `row.op` — `push` → `forge.push(payload)`, returns null; `pr_create` → `forge.ensurePr(payload)`, returns `result.ref` (the PR# → stored in `response_ref` by `markSent`); `pr_comment` → `forge.addPrComment(payload.prRef, payload.body, row.idempotency_key)`. If `ports.forge` is undefined when a forge row appears → throw a clear error (drained as a transient failure, like any other).

- [ ] **Step 1: Write the failing tests**

Create `test/daemon/projector-forge.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { getByDispatchId } from "../../src/db/repos/dispatch.ts"; // not needed; remove if unused
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

function ports() {
  return { issueTracker: fakeIssueTracker(), forge: fakeForge() };
}

test("drainOutbox applies a forge push row via the forge port", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "forge", op: "push", payload: { branch: "feat/x", sha: "abc" }, idempotencyKey: "p1" });
  const p = ports();
  const out = await drainOutbox(db, p);
  db.close();
  expect(out.sent).toBe(1);
  expect((p.forge.calls[0]?.args[0] as { branch: string }).branch).toBe("feat/x");
});

test("a forge pr_create row stores the PR ref in response_ref", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "forge", op: "pr_create", payload: { branch: "feat/x", base: "main", title: "t", body: "b" }, idempotencyKey: "pr1" });
  const p = ports();
  await drainOutbox(db, p);
  // the row is now 'sent' (gone from pending); read it back to assert response_ref
  const row = db.query("SELECT response_ref, status FROM projection_outbox WHERE idempotency_key = 'pr1'").get() as { response_ref: string; status: string };
  db.close();
  expect(row.status).toBe("sent");
  expect(row.response_ref).toContain("fake-pr"); // the PR ref captured
  expect(p.forge.calls[0]?.method).toBe("ensurePr");
});

test("a forge row with no forge port fails (drained as a transient error)", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, { ticketId, target: "forge", op: "push", payload: { branch: "b", sha: "s" }, idempotencyKey: "p2" });
  await drainOutbox(db, { issueTracker: fakeIssueTracker() }); // no forge
  const pending = listPending(db);
  db.close();
  expect(pending.length).toBe(1); // stayed pending (bumped), not silently dropped
  expect(pending[0]?.attempts).toBe(1);
});
```

(Remove the unused `getByDispatchId` import — left as a note; only `enqueue`/`listPending`/the fakes/`makeTestDb` are needed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/daemon/projector-forge.test.ts`
Expected: FAIL — the forge arm throws "no adapter for forge (M6b)".

- [ ] **Step 3: Implement the forge arm**

In `src/daemon/projector.ts`:

(a) Extend `ProjectorPorts`:

```typescript
import type { ForgePort } from "../integrations/forge.ts";
// …
export interface ProjectorPorts {
  issueTracker: IssueTrackerPort;
  forge?: ForgePort;
}
```

(b) Replace the `forge` arm in `applyRow` (the `if (row.target === "forge") { throw ... }` block):

```typescript
  if (row.target === "forge") {
    if (!ports.forge) {
      throw new Error("projector: forge outbox row but no forge port configured");
    }
    const f = ports.forge;
    switch (row.op) {
      case "push":
        await f.push(payload as { branch: string; sha: string });
        return null;
      case "pr_create": {
        const pr = await f.ensurePr(payload as { branch: string; base: string; title: string; body: string });
        return pr.ref; // → response_ref (the PR#); M6b-2 delivers it as external_pr_result
      }
      case "pr_comment":
        return await f.addPrComment(payload.prRef as string, payload.body as string, row.idempotency_key);
      default:
        throw new Error(`projector: unknown forge op '${row.op}'`);
    }
  }
```

(Note: the `forge` arm reads `payload` fields, NOT the issue-tracker `ref = ticket.ident` — forge ops are keyed by branch/PR in the payload. Keep the existing `ref` computation for the `issue_tracker` arm only; it's fine that `ref` is computed before the branch since it's unused by the forge arm.)

- [ ] **Step 4: Run tests + full suite**

Run: `bun test test/daemon/projector-forge.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS. The M6a projector tests (which pass `{ issueTracker }` only) still compile — `forge` is optional.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/projector.ts test/daemon/projector-forge.test.ts
git commit -m "feat(m6b-1): drainer forge dispatch arm (push/pr_create/pr_comment)"
```

---

### Task 4: `merge:push` + `merge:pr-ensure` handlers

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/merge-handlers.test.ts`

**Interfaces:**
- Consumes: `enqueue` (outbox repo); `branchNameFor` (`src/agent/branch.ts`); `getLatestForTicket` (`src/db/repos/dispatch.ts`, for the branch head sha); `listByTicket as listUnits` (work-unit repo, for the PR body); `deps.profile.defaultBranch`.
- Produces:
  - `renderPrBody(db, ticket): string` — a deterministic templated PR description (ticket ident/title + the work-units list + a "passed review + verify" line). Exported (or module-local) + unit-testable.
  - Registered `"merge:push"` handler: enqueue a `forge`/`push` row `{ branch, sha }`, key `${ident}:push:${sha}`. Throws if no branch-head sha.
  - Registered `"merge:pr-ensure"` handler: enqueue a `forge`/`pr_create` row `{ branch, base, title, body }`, key `${ident}:pr_create:${branch}`.

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/merge-handlers.test.ts` (reuse the `gitRepo()`/`registryFor()` harness from `test/dispatch/handlers.test.ts`; these are daemon `project` steps — no agent dispatch, so the FakeAgentRunner can throw if called):

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listPending } from "../../src/db/repos/projection-outbox.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function registryFor() {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => { throw new Error("merge steps dispatch no agent"); }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", commands: {} }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-mh-")),
  });
}

// Record a ticket-level dispatch carrying a branch_head_sha so merge:push has a sha.
function seedReviewedBranch(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'merge' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
  const d = insertDispatch(db, { ticketId, dispatchId: `T-d1`, seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "headsha123" });
}

test("merge:push enqueues a forge push row at the branch head sha", async () => {
  const { db, ticketId } = makeTestDb();
  seedReviewedBranch(db, ticketId);
  await advanceOneStep(db, ticketId, registryFor()); // resolver → merge:push
  const rows = listPending(db).filter((r) => r.target === "forge" && r.op === "push");
  db.close();
  expect(rows.length).toBe(1);
  expect(JSON.parse(rows[0]!.payload_json!).sha).toBe("headsha123");
});

test("merge:pr-ensure enqueues a forge pr_create row with base + a non-empty body", async () => {
  const { db, ticketId } = makeTestDb();
  seedReviewedBranch(db, ticketId);
  // mark merge:push done so the resolver routes to merge:pr-ensure
  const s = insertPending(db, { ticketId, stepKey: "merge:push", stepType: "project" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  await advanceOneStep(db, ticketId, registryFor()); // resolver → merge:pr-ensure
  const rows = listPending(db).filter((r) => r.target === "forge" && r.op === "pr_create");
  db.close();
  expect(rows.length).toBe(1);
  const payload = JSON.parse(rows[0]!.payload_json!);
  expect(payload.base).toBe("main");
  expect(typeof payload.body).toBe("string");
  expect(payload.body.length).toBeGreaterThan(0);
});
```

> Implementer note: confirm `seedReviewedBranch` produces the resolver's `merge:push` next-step (read `resolver.ts` merge case — it needs `stage='merge'`; the branch-head sha comes from the latest ticket dispatch via `getLatestForTicket`). Match `insertDispatch`/`completeDispatch` param shapes in `src/db/repos/dispatch.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/dispatch/merge-handlers.test.ts`
Expected: FAIL — no `merge:push`/`merge:pr-ensure` handler registered.

- [ ] **Step 3: Implement the handlers**

In `src/dispatch/handlers.ts`, add imports (fold into existing lines): `enqueue` from `../db/repos/projection-outbox.ts`; `getLatestForTicket` is already imported; `branchNameFor` is already imported; `listByTicket as listUnits` already imported.

Add a `renderPrBody` helper near the top of the module:

```typescript
/** Deterministic templated PR description from facts the daemon already has (M6b-1; a cheap-LLM
 *  write-up is a later polish). */
function renderPrBody(db: Database, ticket: { ident: string; title: string | null }): string {
  const units = listUnits(db, ticket.id);
  const lines = units.map((u) => `- ${u.kind}${u.title ? `: ${u.title}` : ""}`);
  return [
    `Automated PR for ${ticket.ident}${ticket.title ? ` — ${ticket.title}` : ""}.`,
    "",
    "Work units:",
    ...(lines.length > 0 ? lines : ["- (none)"]),
    "",
    "Verified against the project's checks and passed independent review.",
  ].join("\n");
}
```

(`Database` is already imported in handlers.ts.) Register inside `buildDispatchRegistry`:

```typescript
  registry.register("merge:push", (ctx: HandlerContext) => {
    const branch = branchNameFor(ctx.ticket);
    const sha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha;
    if (!sha) {
      throw new Error("merge:push: no branch head sha (no completed dispatch)");
    }
    enqueue(ctx.db, {
      ticketId: ctx.ticket.id,
      target: "forge",
      op: "push",
      payload: { branch, sha },
      idempotencyKey: `${ctx.ticket.ident}:push:${sha}`,
    });
    return { enqueued: "push", sha };
  });

  registry.register("merge:pr-ensure", (ctx: HandlerContext) => {
    const branch = branchNameFor(ctx.ticket);
    const base = deps.profile.defaultBranch;
    const title = `${ctx.ticket.ident}${ctx.ticket.title ? ` ${ctx.ticket.title}` : ""}`;
    const body = renderPrBody(ctx.db, ctx.ticket);
    enqueue(ctx.db, {
      ticketId: ctx.ticket.id,
      target: "forge",
      op: "pr_create",
      payload: { branch, base, title, body },
      idempotencyKey: `${ctx.ticket.ident}:pr_create:${branch}`,
    });
    return { enqueued: "pr_create" };
  });
```

- [ ] **Step 4: Run tests + full suite**

Run: `bun test test/dispatch/merge-handlers.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS. The walking-skeleton registers its own mock `merge:push`/`merge:pr-ensure` (own registry) and is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/merge-handlers.test.ts
git commit -m "feat(m6b-1): merge:push + merge:pr-ensure handlers (enqueue forge ops; templated PR body)"
```

---

### Task 5: `released:project` handler

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/merge-handlers.test.ts` (extend)

**Interfaces:**
- Consumes: `removeWorktree` (`src/dispatch/worktree.ts`); the `worktreeFor`/`getProject` already in handlers.ts.
- Produces: a registered `"released:project"` handler — best-effort worktree cleanup; returns `{ released: true }`. The Linear "Done" projection is ALREADY enqueued by the `merge→released` transition's `enqueueStageProjection` (released → `done`), so `released:project` does NOT re-enqueue it (avoids a redundant row).

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/merge-handlers.test.ts`:

```typescript
import { removeWorktree } from "../../src/dispatch/worktree.ts"; // referenced by the handler; import for clarity if needed
import { getByKey } from "../../src/db/repos/workflow-step.ts";

test("released:project runs (best-effort worktree cleanup) and succeeds", async () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'released' WHERE id = ?").run(ticketId);
  await advanceOneStep(db, ticketId, registryFor()); // resolver → released:project
  const step = getByKey(db, ticketId, "released:project");
  db.close();
  expect(step?.status).toBe("succeeded"); // cleanup is best-effort; the step doesn't fail if the worktree is absent
});
```

> Implementer note: the worktree for the test ticket won't exist on disk; `released:project` must NOT throw on a missing worktree (wrap `removeWorktree` so a missing worktree is a no-op, not a failure). Confirm `removeWorktree(repoPath, worktreePath)`'s signature in `src/dispatch/worktree.ts` and how `worktreeFor`/`getProject` give the repo + worktree paths (mirror the verify handlers).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/merge-handlers.test.ts`
Expected: FAIL — no `released:project` handler.

- [ ] **Step 3: Implement the handler**

In `src/dispatch/handlers.ts`, register inside `buildDispatchRegistry` (add the `removeWorktree` import):

```typescript
  registry.register("released:project", (ctx: HandlerContext) => {
    // The Done projection is enqueued by the merge→released transition (enqueueStageProjection,
    // released→done). Here we only clean up the per-ticket worktree (best-effort).
    const { repoPath, worktreePath } = worktreeFor(ctx, deps);
    try {
      removeWorktree(repoPath, worktreePath);
    } catch {
      // already gone / never created — fine; cleanup must not fail the terminal step.
    }
    return { released: true };
  });
```

(`worktreeFor` is the existing helper in handlers.ts that returns `{ repoPath, worktreePath, branch }`.)

- [ ] **Step 4: Run test + full suite**

Run: `bun test test/dispatch/merge-handlers.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/merge-handlers.test.ts
git commit -m "feat(m6b-1): released:project handler (best-effort worktree cleanup)"
```

---

### Task 6: End-to-end forge-write merge flow

**Files:**
- Test: `test/dispatch/merge-e2e.test.ts`

Cover the forge-write path end-to-end with a real `tick` + a fake forge (mirror `test/dispatch/projector-e2e.test.ts`):

1. **Merge-write flow → PR opened → parks awaiting checks.** Seed a ticket at `stage='merge'` with a completed dispatch (branch head sha) and a work unit. Drive `tick({ ports: { issueTracker: fakeIssueTracker(), forge: fakeForge() } })` repeatedly. Assert across ticks: `merge:push` runs → a `forge`/`push` row drains to the fake forge (`push` recorded); `merge:pr-ensure` runs → a `forge`/`pr_create` row drains (`ensurePr` recorded; the `pr_create` outbox row is `sent` with `response_ref` = the PR ref); and the ticket ends parked on the `external_checks` signal (the resolver's wait — nothing delivers it in M6b-1, which is the correct M6b-1 end-state). Assert `getTicket(...).status === "waiting"` and a pending `external_checks` signal exists.
2. **Idempotent re-drive.** Running another `tick` does not enqueue duplicate forge rows (deterministic keys) and the fake forge isn't called again for an already-sent row.

- [ ] **Step 1: Write the e2e tests** (drive real `tick`; assert the forge ops reached the fake forge and the ticket parked on `external_checks`; the projection rows come from the real merge handlers + drainer, not hand-inserted).

> Implementer note: confirm the exact tick count to walk merge:push → drain → merge:pr-ensure → drain → wait(external_checks). `advanceOneStep` does one real step per call; `tick` advances each ready ticket once then drains. Loop until `getTicket(...).status === "waiting"` (parked on checks) or a max-iteration guard. Keep it genuine.

- [ ] **Step 2: Run**

Run: `bun test test/dispatch/merge-e2e.test.ts && bun run lint`
Expected: PASS (both).

- [ ] **Step 3: Commit**

```bash
git add test/dispatch/merge-e2e.test.ts
git commit -m "test(m6b-1): e2e forge-write merge flow (push + PR → parks awaiting checks)"
```

---

## Final Verification (before PR)

- [ ] Full gate fresh: `bun test && bun run lint && bun run typecheck && bun run build` — all pass; the binary bundles `@octokit/rest`.
- [ ] Confirm NO schema change: `git diff main -- src/db/schema.sql docs/architecture/schema.sql` is empty.
- [ ] Confirm zero-lock-in: `@octokit/rest` imported ONLY in `src/integrations/adapters/github.ts` (grep); the core (projector/handlers/repos) imports only `ForgePort`.
- [ ] Whole-branch review on the most capable model; fix any Critical/Important.
- [ ] `finishing-a-development-branch`: push `feat/m6b-1-forge-merge`, open PR into `main`. **Do not merge** — the operator merges.
- [ ] Watch CI to green.

## Carries into M6b-2 / later
- **`external_pr_result` delivery** (drainer delivers the PR# from the `pr_create` `response_ref` to a parked signal) + the checks poll consuming it.
- **Checks-system:** `ChecksPort` + GitHub checks adapter + `pollChecks` (deliver `external_checks`; `checksSystem=none` → skip) + resolver `checksSystem` handling + the live merge→released completion e2e.
- **Daemon-entrypoint wiring:** `selectForge(runtimeConfig, { github: () => githubForge({ repoPath: profile.targetRepo }) })` + `GITHUB_TOKEN` → `tick`'s `ports`.
- **Octokit adapter hardening:** paginate `pulls.list`/`listComments` probes (the M6a `addComment`/labels first-page carry applies to GitHub's PR-comment probe too) before high-volume use; with-lease force-push guard verification.
- **Cheap-LLM PR description**; stale-branch handling (CL-STALE); automated merge detection / `pr_merge`.
- zod-validate forge outbox payloads at a hardening pass; `AgentConfig`→`RuntimeConfig` unification (operator-flagged).

## Self-Review
- **Spec coverage:** ForgePort + factory + fake + config (T1); Octokit GitHub adapter (T2); drainer forge arm + ProjectorPorts.forge (T3); merge:push/merge:pr-ensure (T4); released:project (T5); forge-write e2e (T6). The checks/completion/wiring are explicitly M6b-2. Covered.
- **Invariants:** zero-lock-in (core imports only ForgePort; Octokit confined to the adapter; neutral `forge` target; config-selected); sole-writer (handlers enqueue, drainer applies); two-layer idempotency (unique keys + adapter probes); failure-never-blocks-loop (reuses M6a drainer); one config (forge on RuntimeConfig; creds env; instance injected); no schema change. Held.
- **Placeholder scan:** complete code in every step. The Octokit adapter (T2) specifies behavior + the exact probe/dispatch semantics and instructs consulting the SDK docs for method names (the vendor edge, build-verified) — with a pure helper (`parseGitHubRemote`) unit-tested. Implementer-notes flag the resolver-pre-state seeding (T4/T6) and the missing-worktree no-op (T5); one test has an explicitly-noted unused import to drop.
- **Type consistency:** `ForgePort` method signatures (T1) match the drainer dispatch (T3), the fake (T1), and the GitHub adapter (T2); `forge` outbox `op`/payload shapes (`push {branch,sha}`, `pr_create {branch,base,title,body}`, `pr_comment {prRef,body}`) match between the merge handlers (T4) and the drainer arm (T3); `ProjectorPorts.forge?` (T3) matches the e2e ports (T6); `renderPrBody(db, ticket)` (T4) consistent with its call + test.
