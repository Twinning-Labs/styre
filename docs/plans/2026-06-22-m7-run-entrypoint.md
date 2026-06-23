# M7 — `styre run <ticket>` Entrypoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `styre run <ticket>` — a one-shot headless entrypoint that ingests ONE ticket by reading it from Linear, boots the loop context (migrate → recover → wire ports), drives the ticket to PR-ready, prints a telemetry summary, and exits.

**Architecture:** Everything the loop needs (M0–M6) already exists as tested seams — `tick`, `recover`, the `select*` factories + env-cred adapters, `buildDispatchRegistry`, `migrate`/`openDb`. M7 is the first integrator: it adds (1) a ticket-ingestion READ on the issue-tracker port (Linear `client.issue(ref)` → SoT row), (2) a `makeProjectorPorts` factory, (3) a bounded driver loop with PR-ready/blocked detection, (4) the `styre run` citty command, plus two cross-cutting fixes the entrypoint forces: a ticket `description` column threaded into the design prompt, and scrubbing the daemon's creds from the agent subprocess env.

**Tech Stack:** TypeScript + Bun (`bun:sqlite`), citty (CLI), zod, `@linear/sdk` (confined to one adapter), `@octokit/rest` (confined to one adapter). Commands: `bun test`, `bun run lint`, `bun run typecheck`, `bun run build`.

## Global Constraints

Load-bearing invariants. Code that violates them is wrong even if tests pass.

- **Linear is read for INGESTION ONLY, never for control flow.** `fetchTicket` is called exactly once per ticket at trigger (in `runTicket`), to seed the SoT. The control loop reads only the SoT (`getTicket`/signals) thereafter — never re-reads Linear. Do not call `fetchTicket` anywhere in `src/daemon/` or the resolver.
- **Capability isolation (move-4):** the daemon holds `LINEAR_API_KEY`/`GITHUB_TOKEN` and constructs the adapters; the agent subprocess must NOT inherit them. The single `Bun.spawn` in `src/agent/providers/claude.ts` must pass a curated env with those creds removed.
- **Vendor-SDK firewall (zero lock-in):** `@linear/sdk` stays imported only in `src/integrations/adapters/linear.ts`; `@octokit/*` only in `src/integrations/adapters/github.ts`. The new `fetchTicket` read goes through the neutral `IssueTrackerPort`; the core depends only on the port + a neutral `IngestedTicket` type.
- **Ephemeral per-run SQLite:** `styre run` defaults to a FRESH temp DB path, NOT `defaultDbPath()` (which is the persistent daemon DB). The durable output is the git branch + the printed telemetry, not the DB.
- **`run` exits at PR-ready.** The terminal success state is the ticket parked at `stage='merge'` on a pending `human_merge_approval` signal (PR opened, awaiting the human merge gate). `run` NEVER delivers `human_merge_approval` (the operator merges the PR on GitHub) and never auto-merges.
- **`run` must pass `profile` to `tick`** so `pollChecks` runs — otherwise the ticket parks on `external_checks` forever and never opens the PR. With `checksSystem:'none'`, `external_checks` auto-delivers and the ticket advances to the `human_merge_approval` park.
- **No control-flow self-report:** the run's exit verdict comes from SoT state (ticket stage/status + pending signals), not from any agent's claim.
- **Schema change discipline:** the one new column (`ticket.description`) must be added to BOTH `src/db/schema.sql` and `docs/architecture/schema.sql` identically (the dual-schema rule).
- **Timestamps UTC** via `nowUtc()`.

---

## File Structure

**New files:**
- `src/integrations/ticket-source.ts` — the neutral `IngestedTicket` type + pure `deriveTypeLabel` / `branchPrefixFor` helpers (the ingestion contract, vendor-free).
- `src/daemon/ports.ts` — `makeProjectorPorts(runtimeConfig, profile, deps?)` factory.
- `src/daemon/run-ticket.ts` — `driveToTerminal` (bounded driver loop) + `runTicket` (ingest → drive → summarize) + `formatRunSummary`.
- `src/cli/run.ts` — the `styre run` citty command (builds real deps, calls `runTicket`).
- `test/helpers/skeleton-registry.ts` — the mock full-pipeline registry extracted from `walking-skeleton.test.ts` (reused by the run integration test).
- Tests: `test/integrations/ticket-source.test.ts`, `test/db/ticket-description.test.ts`, `test/integrations/fetch-ticket.test.ts`, `test/daemon/ports.test.ts`, `test/agent/agent-env.test.ts`, `test/daemon/run-ticket.test.ts`, `test/cli/run-e2e.test.ts`.

**Modified files:**
- `src/db/schema.sql` + `docs/architecture/schema.sql` — add `description TEXT` to the `ticket` table.
- `src/db/repos/ticket.ts` — `TicketRow` + `COLS` + `insertTicket` gain `description`/`title`/`typeLabel`/`branchPrefix`/`linearIssueUuid`.
- `src/dispatch/prompt-vars.ts` — `designVars` adds `description`.
- `prompts/design.md` — add `{{description}}`.
- `src/integrations/issue-tracker.ts` — `IssueTrackerPort` gains `fetchTicket`.
- `src/integrations/adapters/linear.ts` — implement `fetchTicket` (the `@linear/sdk` read).
- `src/integrations/adapters/fake-issue-tracker.ts` — fake `fetchTicket`.
- `src/agent/providers/claude.ts` — `agentEnv` curated env + pass to `Bun.spawn`.
- `src/index.ts` — register the `run` subcommand.
- `test/daemon/walking-skeleton.test.ts` — import `skeletonRegistry` from the new helper (extraction).

---

### Task 1: `ticket.description` column + `insertTicket` ingestion fields

**Files:**
- Modify: `src/db/schema.sql` (ticket table), `docs/architecture/schema.sql` (ticket table — identical)
- Modify: `src/db/repos/ticket.ts:4-48` (`TicketRow`, `COLS`, `insertTicket`)
- Test: `test/db/ticket-description.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `insertTicket(db, { projectId, ident, stage?, status?, track?, needsDocs?, title?, description?, typeLabel?, branchPrefix?, linearIssueUuid? }): number` — persists the new fields. `TicketRow` gains `description: string | null` (and already has `title`/`type_label`/`branch_prefix`). `getTicket` returns `description`.

- [ ] **Step 1: Write the failing test**

`test/db/ticket-description.test.ts`:
```ts
import { expect, test } from "bun:test";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { makeTestDb } from "../helpers/db.ts";

test("insertTicket persists ingestion fields incl. description", () => {
  const { db } = makeTestDb();
  const projectId = insertProject(db, { slug: "demo", targetRepo: "/tmp/x" });
  const id = insertTicket(db, {
    projectId,
    ident: "ENG-9",
    title: "Add a thing",
    description: "## Context\nDo the thing.",
    typeLabel: "Bug",
    branchPrefix: "fix",
    linearIssueUuid: "uuid-123",
  });
  const t = getTicket(db, id);
  expect(t?.title).toBe("Add a thing");
  expect(t?.description).toBe("## Context\nDo the thing.");
  expect(t?.type_label).toBe("Bug");
  expect(t?.branch_prefix).toBe("fix");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/ticket-description.test.ts`
Expected: FAIL — `description` is not a column / not returned (and `insertTicket` rejects the extra fields by ignoring them, so `t.description` is `undefined`).

- [ ] **Step 3: Add the column to BOTH schema files**

In `src/db/schema.sql` AND `docs/architecture/schema.sql`, in the `CREATE TABLE ticket (...)` block, add a `description` column right after `title`:
```sql
    title                 TEXT,
    description           TEXT,                              -- the ingested ticket body (design input)
```
The two files must remain byte-identical in this table.

- [ ] **Step 4: Extend `TicketRow`, `COLS`, and `insertTicket` in `src/db/repos/ticket.ts`**

Add `description` to `TicketRow` (after `title`):
```ts
  title: string | null;
  description: string | null;
```
Add it to `COLS`:
```ts
const COLS =
  "id, project_id, ident, title, description, stage, status, track, needs_docs, branch_name, branch_prefix, type_label";
```
Replace `insertTicket` (lines 21-48) with the extended version:
```ts
export function insertTicket(
  db: Database,
  t: {
    projectId: number;
    ident: string;
    stage?: string;
    status?: string;
    track?: string;
    needsDocs?: number;
    title?: string | null;
    description?: string | null;
    typeLabel?: string | null;
    branchPrefix?: string | null;
    linearIssueUuid?: string | null;
  },
): number {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ticket
         (project_id, ident, title, description, type_label, branch_prefix, linear_issue_uuid,
          stage, status, track, needs_docs, created_at, updated_at)
       VALUES ($pid, $ident, $title, $description, $typeLabel, $branchPrefix, $linearIssueUuid,
          $stage, $status, $track, $needsDocs, $now, $now)`,
    )
    .run({
      $pid: t.projectId,
      $ident: t.ident,
      $title: t.title ?? null,
      $description: t.description ?? null,
      $typeLabel: t.typeLabel ?? null,
      $branchPrefix: t.branchPrefix ?? null,
      $linearIssueUuid: t.linearIssueUuid ?? null,
      $stage: t.stage ?? "design",
      $status: t.status ?? "active",
      $track: t.track ?? null,
      $needsDocs: t.needsDocs ?? 0,
      $now: now,
    });
  return Number(res.lastInsertRowid);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/db/ticket-description.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm no regression (every test that inserts a ticket)**

Run: `bun test 2>&1 | tail -3`
Expected: all pass (the new column is nullable; the `insertTicket` extension is additive — existing callers passing only the old fields still work).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
bun run lint && bun run typecheck
git add src/db/schema.sql docs/architecture/schema.sql src/db/repos/ticket.ts test/db/ticket-description.test.ts
git commit -m "feat(m7): ticket.description column + insertTicket ingestion fields"
```

---

### Task 2: Thread `{{description}}` into the design prompt

**Files:**
- Modify: `src/dispatch/prompt-vars.ts:30-43` (`designVars`)
- Modify: `prompts/design.md`
- Test: `test/dispatch/design-vars.test.ts`

**Interfaces:**
- Consumes: `TicketRow.description` (Task 1).
- Produces: `designVars(ticket: { ident; title; description }, profile)` includes a `description` key. The design template references `{{description}}`.

**Context:** `renderPrompt` (`src/dispatch/render-prompt.ts`) treats any `{{name}}` with no value in `vars` as a CL-PROFILE failure (`missing`). So adding `{{description}}` to the template REQUIRES `designVars` to supply `description` — make both changes together.

- [ ] **Step 1: Write the failing test**

`test/dispatch/design-vars.test.ts`:
```ts
import { expect, test } from "bun:test";
import { DESIGN_TEMPLATE, designVars } from "../../src/dispatch/prompt-vars.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: {} });

test("designVars supplies description", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: "the body" }, profile);
  expect(vars.description).toBe("the body");
});

test("designVars tolerates a null description", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: null }, profile);
  expect(vars.description).toBe("");
});

test("the design template's placeholders are all satisfied by designVars", () => {
  const vars = designVars({ ident: "ENG-1", title: "T", description: "b" }, profile);
  const result = renderPrompt(DESIGN_TEMPLATE, vars);
  expect(result.ok).toBe(true);
  expect(placeholders(DESIGN_TEMPLATE)).toContain("description");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/design-vars.test.ts`
Expected: FAIL — `designVars` doesn't accept/return `description`; the template has no `{{description}}` placeholder.

- [ ] **Step 3: Update `designVars` in `src/dispatch/prompt-vars.ts`**

Replace `designVars` (lines 30-43):
```ts
export function designVars(
  ticket: { ident: string; title: string | null; description: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    description: ticket.description ?? "",
    slug: profile.slug,
    stack: "",
    ...profile.promptVars,
  };
}
```

- [ ] **Step 4: Add `{{description}}` to `prompts/design.md`**

Insert a ticket-body section after the first line:
```markdown
You are designing ticket {{ident}} ("{{title}}") in the project {{slug}}.

Ticket description / acceptance criteria:
{{description}}

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
with `linear: {{ident}}` frontmatter. Per work-unit, state: kind, files to touch, whether it
is behavioral (and how it's tested), the verify check-types, and dependencies — as prose.

Project stack notes: {{stack}}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/dispatch/design-vars.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm the design handler still typechecks against the new `designVars` shape**

`src/dispatch/handlers.ts:130` calls `designVars(ctx.ticket, deps.profile)` — `ctx.ticket` is a `TicketRow`, which now has `description` (Task 1), so it satisfies the new param type.

Run: `bun run typecheck && bun test test/dispatch/ 2>&1 | tail -3`
Expected: typecheck clean; dispatch tests pass.

- [ ] **Step 7: Lint, commit**

```bash
bun run lint
git add src/dispatch/prompt-vars.ts prompts/design.md test/dispatch/design-vars.test.ts
git commit -m "feat(m7): thread ticket description into the design prompt"
```

---

### Task 3: `fetchTicket` ingestion read (IssueTrackerPort + Linear + fake)

**Files:**
- Create: `src/integrations/ticket-source.ts`
- Modify: `src/integrations/issue-tracker.ts` (`IssueTrackerPort`)
- Modify: `src/integrations/adapters/linear.ts` (implement `fetchTicket`)
- Modify: `src/integrations/adapters/fake-issue-tracker.ts` (fake `fetchTicket`)
- Test: `test/integrations/ticket-source.test.ts`, `test/integrations/fetch-ticket.test.ts`

**Interfaces:**
- Produces:
  - `type TypeLabel = "Bug" | "Feature" | "Improvement"` and `interface IngestedTicket { ident: string; title: string; description: string | null; typeLabel: TypeLabel; linearIssueUuid: string | null; url: string | null }` (in `ticket-source.ts`).
  - pure `deriveTypeLabel(labelNames: string[]): TypeLabel` (matches a label named Bug/Feature/Improvement case-insensitively, else `"Feature"`) and `branchPrefixFor(t: TypeLabel): "fix" | "feat"` (`Bug → "fix"`, else `"feat"`).
  - `IssueTrackerPort.fetchTicket(ref: string): Promise<IngestedTicket>` (the ingestion-only read).
  - `fakeIssueTracker()` records a `fetchTicket` call and returns a canned `IngestedTicket` (configurable).

**Context:** The Linear SDK read primitive already exists — `await client.issue(ref)` resolves both `ENG-123` and the internal UUID (used 3× in `linear.ts` for writes). A fetched issue exposes `identifier`, `title`, `description`, `id` (uuid), `url`, and `await issue.labels()` → `.nodes[].name`. The SDK-calling body of `fetchTicket` is a NOT-unit-tested vendor edge (the `githubForge` precedent); the PURE helpers (`deriveTypeLabel`/`branchPrefixFor`) and the fake ARE unit-tested.

- [ ] **Step 1: Write the failing tests**

`test/integrations/ticket-source.test.ts` (pure helpers):
```ts
import { expect, test } from "bun:test";
import { branchPrefixFor, deriveTypeLabel } from "../../src/integrations/ticket-source.ts";

test("deriveTypeLabel matches a Bug/Feature/Improvement label case-insensitively", () => {
  expect(deriveTypeLabel(["bug"])).toBe("Bug");
  expect(deriveTypeLabel(["Improvement", "p1"])).toBe("Improvement");
  expect(deriveTypeLabel(["Feature"])).toBe("Feature");
});

test("deriveTypeLabel defaults to Feature when no type label is present", () => {
  expect(deriveTypeLabel([])).toBe("Feature");
  expect(deriveTypeLabel(["p1", "frontend"])).toBe("Feature");
});

test("branchPrefixFor: Bug→fix, else feat", () => {
  expect(branchPrefixFor("Bug")).toBe("fix");
  expect(branchPrefixFor("Feature")).toBe("feat");
  expect(branchPrefixFor("Improvement")).toBe("feat");
});
```

`test/integrations/fetch-ticket.test.ts` (the fake):
```ts
import { expect, test } from "bun:test";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

test("fakeIssueTracker.fetchTicket returns the canned ticket and records the call", async () => {
  const it = fakeIssueTracker({
    ticket: { ident: "ENG-1", title: "T", description: "B", typeLabel: "Bug", linearIssueUuid: "u", url: "http://x" },
  });
  const got = await it.fetchTicket("ENG-1");
  expect(got.ident).toBe("ENG-1");
  expect(got.typeLabel).toBe("Bug");
  expect(it.calls.some((c) => c.method === "fetchTicket" && c.args[0] === "ENG-1")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/integrations/ticket-source.test.ts test/integrations/fetch-ticket.test.ts`
Expected: FAIL — `ticket-source.ts` doesn't exist; `fakeIssueTracker` has no `fetchTicket`/`ticket` option.

- [ ] **Step 3: Write `src/integrations/ticket-source.ts`**

```ts
/** The vendor-neutral ticket-ingestion contract. A `fetchTicket` read (issue-tracker port) maps a
 *  vendor issue (Linear/JIRA/...) onto this shape ONCE at trigger, to seed the SoT. The control
 *  loop then runs purely off the SoT — the tracker is never read again for control flow. */
export type TypeLabel = "Bug" | "Feature" | "Improvement";

export interface IngestedTicket {
  ident: string;
  title: string;
  description: string | null;
  typeLabel: TypeLabel;
  linearIssueUuid: string | null;
  url: string | null;
}

const TYPE_LABELS: TypeLabel[] = ["Bug", "Feature", "Improvement"];

/** Pick the ticket's type from its label names (case-insensitive); default Feature. Pure. */
export function deriveTypeLabel(labelNames: string[]): TypeLabel {
  const lowered = labelNames.map((n) => n.toLowerCase());
  for (const t of TYPE_LABELS) {
    if (lowered.includes(t.toLowerCase())) return t;
  }
  return "Feature";
}

/** Branch prefix from the type: Bug → fix, else feat (schema CHECK + branch-shape rule). Pure. */
export function branchPrefixFor(t: TypeLabel): "fix" | "feat" {
  return t === "Bug" ? "fix" : "feat";
}
```

- [ ] **Step 4: Add `fetchTicket` to the port (`src/integrations/issue-tracker.ts`)**

Add the import + the method (keep the existing write methods):
```ts
import type { IngestedTicket } from "./ticket-source.ts";

export interface IssueTrackerPort {
  /** Ingestion-only READ: fetch a ticket by ref to seed the SoT (control-loop trigger). MUST NOT
   *  be called from the control loop — the loop reads the SoT, never the tracker. */
  fetchTicket(ref: string): Promise<IngestedTicket>;
  setState(ref: string, state: IssueState): Promise<void>;
  setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void>;
  addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null>;
}
```

- [ ] **Step 5: Implement `fetchTicket` in `src/integrations/adapters/linear.ts`**

Add the imports and the method on the returned object (alongside the existing `setState`/`setLabels`/`addComment`). Use the existing `client` from `linearIssueTracker`:
```ts
import { branchPrefixFor, deriveTypeLabel, type IngestedTicket } from "../ticket-source.ts";
// ... inside the returned port object:
    async fetchTicket(ref: string): Promise<IngestedTicket> {
      const issue = await client.issue(ref);
      const labels = await issue.labels();
      const labelNames = labels.nodes.map((l) => l.name);
      const typeLabel = deriveTypeLabel(labelNames);
      // branchPrefixFor is applied by the ingestion caller; surface typeLabel here.
      return {
        ident: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        typeLabel,
        linearIssueUuid: issue.id,
        url: issue.url ?? null,
      };
    },
```
(Note: `branchPrefixFor` is imported for symmetry but the caller in Task 7 derives the prefix from `typeLabel`; if biome flags the unused import, import only `deriveTypeLabel` + the type.)

- [ ] **Step 6: Add `fetchTicket` to the fake (`src/integrations/adapters/fake-issue-tracker.ts`)**

Extend `fakeIssueTracker` to accept an optional canned ticket and record the call:
```ts
import type { IngestedTicket } from "../ticket-source.ts";

export function fakeIssueTracker(opts?: { ticket?: IngestedTicket }): IssueTrackerPort & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const cannedTicket: IngestedTicket = opts?.ticket ?? {
    ident: "ENG-1",
    title: "fake ticket",
    description: "fake body",
    typeLabel: "Feature",
    linearIssueUuid: "fake-uuid",
    url: "https://fake/ENG-1",
  };
  return {
    calls,
    async fetchTicket(ref: string) {
      calls.push({ method: "fetchTicket", args: [ref] });
      return cannedTicket;
    },
    async setState(ref: string, state: IssueState) {
      calls.push({ method: "setState", args: [ref, state] });
    },
    async setLabels(ref: string, change: { add: string[]; remove: string[] }) {
      calls.push({ method: "setLabels", args: [ref, change] });
    },
    async addComment(ref: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addComment", args: [ref, body, idempotencyKey] });
      return `fake-comment-${calls.length}`;
    },
  };
}
```

- [ ] **Step 7: Run tests + the no-regression set**

Run: `bun test test/integrations/ticket-source.test.ts test/integrations/fetch-ticket.test.ts test/daemon/ test/dispatch/ 2>&1 | tail -4 && bun run typecheck`
Expected: PASS (the fake's existing callers pass no `opts` → still get a working fake); typecheck clean. Confirm `@linear/sdk` still imported in only `linear.ts`: `grep -rln 'from.*@linear' src/` → one file.

- [ ] **Step 8: Lint, commit**

```bash
bun run lint
git add src/integrations/ticket-source.ts src/integrations/issue-tracker.ts src/integrations/adapters/linear.ts src/integrations/adapters/fake-issue-tracker.ts test/integrations/ticket-source.test.ts test/integrations/fetch-ticket.test.ts
git commit -m "feat(m7): fetchTicket ingestion read (IssueTrackerPort + Linear + fake) + ticket-source contract"
```

---

### Task 4: `makeProjectorPorts` factory

**Files:**
- Create: `src/daemon/ports.ts`
- Test: `test/daemon/ports.test.ts`

**Interfaces:**
- Consumes: `selectIssueTracker`/`selectForge`/`selectChecks` + the real adapters; `ProjectorPorts` (`src/daemon/projector.ts`).
- Produces: `makeProjectorPorts(runtimeConfig: { issueTracker: string; forge: string }, profile: { checksSystem: string; targetRepo: string }, deps?: { issueTracker?: Record<string, IssueTrackerFactory>; forge?: Record<string, ForgeFactory>; checks?: Record<string, ChecksFactory> }): ProjectorPorts` — wires the three ports. Real adapters by default; `deps` overrides for tests.

**Context:** The real `githubForge`/`githubChecks` read the git remote at construction (need a real repo), so the factory takes injectable adapter maps (mirroring how `selectForge` already takes `adapters`). `selectChecks` returns `null` for `checksSystem` not in the map (e.g. `"none"`) → map to `undefined` for `ProjectorPorts.checks`.

- [ ] **Step 1: Write the failing test**

`test/daemon/ports.test.ts`:
```ts
import { expect, test } from "bun:test";
import { makeProjectorPorts } from "../../src/daemon/ports.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

const deps = {
  issueTracker: { linear: () => fakeIssueTracker() },
  forge: { github: () => fakeForge() },
  checks: { github: () => fakeChecks() },
};

test("wires issueTracker + forge from runtime config", () => {
  const ports = makeProjectorPorts(
    { issueTracker: "linear", forge: "github" },
    { checksSystem: "github", targetRepo: "/tmp/x" },
    deps,
  );
  expect(ports.issueTracker).toBeDefined();
  expect(ports.forge).toBeDefined();
  expect(ports.checks).toBeDefined();
});

test("checksSystem 'none' yields no checks port", () => {
  const ports = makeProjectorPorts(
    { issueTracker: "linear", forge: "github" },
    { checksSystem: "none", targetRepo: "/tmp/x" },
    deps,
  );
  expect(ports.checks).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/ports.test.ts`
Expected: FAIL — `ports.ts` does not exist.

- [ ] **Step 3: Write `src/daemon/ports.ts`**

```ts
import type { ProjectorPorts } from "./projector.ts";
import { type ChecksFactory, selectChecks } from "../integrations/checks.ts";
import { type ForgeFactory, selectForge } from "../integrations/forge.ts";
import { type IssueTrackerFactory, selectIssueTracker } from "../integrations/issue-tracker.ts";
import { githubChecks } from "../integrations/adapters/github-checks.ts";
import { githubForge } from "../integrations/adapters/github.ts";
import { linearIssueTracker } from "../integrations/adapters/linear.ts";

/** Build the outward ports from runtime config + profile, reading creds from env via the real
 *  adapters. `deps` overrides the adapter maps (tests inject fakes). The daemon entrypoint's single
 *  wiring point — mirrors selectForge/selectIssueTracker (config in, live ports out). */
export function makeProjectorPorts(
  runtimeConfig: { issueTracker: string; forge: string },
  profile: { checksSystem: string; targetRepo: string },
  deps?: {
    issueTracker?: Record<string, IssueTrackerFactory>;
    forge?: Record<string, ForgeFactory>;
    checks?: Record<string, ChecksFactory>;
  },
): ProjectorPorts {
  const itAdapters = deps?.issueTracker ?? { linear: () => linearIssueTracker() };
  const forgeAdapters = deps?.forge ?? {
    github: () => githubForge({ repoPath: profile.targetRepo }),
  };
  const checksAdapters = deps?.checks ?? {
    github: () => githubChecks({ repoPath: profile.targetRepo }),
  };
  return {
    issueTracker: selectIssueTracker(runtimeConfig, itAdapters),
    forge: selectForge(runtimeConfig, forgeAdapters),
    checks: selectChecks(profile.checksSystem, checksAdapters) ?? undefined,
  };
}
```
(If `IssueTrackerFactory`/`ForgeFactory` are not currently exported from their modules, export them — they mirror `ChecksFactory`, which is exported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/daemon/ports.test.ts && bun run typecheck`
Expected: PASS (2 tests) + typecheck clean.

- [ ] **Step 5: Lint, commit**

```bash
bun run lint
git add src/daemon/ports.ts src/integrations/issue-tracker.ts src/integrations/forge.ts test/daemon/ports.test.ts
git commit -m "feat(m7): makeProjectorPorts factory (config + env creds → ProjectorPorts)"
```

---

### Task 5: Capability isolation — scrub creds from the agent subprocess env

**Files:**
- Modify: `src/agent/providers/claude.ts:44-49` (the `Bun.spawn`)
- Test: `test/agent/agent-env.test.ts`

**Interfaces:**
- Produces: `agentEnv(parentEnv: Record<string, string | undefined>): Record<string, string>` (exported from `claude.ts`) — returns a copy of `parentEnv` with the daemon-held creds removed. The `Bun.spawn` passes `env: agentEnv(process.env)`.

**Context:** The spawn currently passes no `env`, so the child inherits the full `process.env` — leaking `LINEAR_API_KEY`/`GITHUB_TOKEN` into the agent (capability-isolation move-4 violation). These two are read only in `linear.ts`/`github.ts` (the parent's adapters), so removing them from the agent env is safe. A denylist (not an allowlist) keeps whatever the `claude` CLI needs for its own auth intact.

- [ ] **Step 1: Write the failing test**

`test/agent/agent-env.test.ts`:
```ts
import { expect, test } from "bun:test";
import { agentEnv } from "../../src/agent/providers/claude.ts";

test("agentEnv strips the daemon-held creds, keeps everything else", () => {
  const out = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LINEAR_API_KEY: "secret-linear",
    GITHUB_TOKEN: "secret-gh",
    SOME_OTHER: "keep",
    UNDEF: undefined,
  });
  expect(out.PATH).toBe("/usr/bin");
  expect(out.HOME).toBe("/home/x");
  expect(out.SOME_OTHER).toBe("keep");
  expect("LINEAR_API_KEY" in out).toBe(false);
  expect("GITHUB_TOKEN" in out).toBe(false);
  expect("UNDEF" in out).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/agent/agent-env.test.ts`
Expected: FAIL — `agentEnv` is not exported.

- [ ] **Step 3: Add `agentEnv` and wire it into the spawn (`src/agent/providers/claude.ts`)**

Add near the top of the file:
```ts
/** Creds the daemon holds and must NOT leak into the agent subprocess (capability isolation,
 *  move-4: agents get no ambient LINEAR_API_KEY / GITHUB_TOKEN; the worktree is their only surface). */
const AGENT_ENV_DENYLIST = ["LINEAR_API_KEY", "GITHUB_TOKEN"];

/** A curated env for the agent subprocess: the parent env minus the daemon-held creds (and minus
 *  undefined values). Denylist, not allowlist, so the `claude` CLI keeps whatever it needs to auth. */
export function agentEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v !== undefined && !AGENT_ENV_DENYLIST.includes(k)) out[k] = v;
  }
  return out;
}
```
Then add `env` to the `Bun.spawn` options (lines 44-49):
```ts
  const proc = Bun.spawn([command, ...buildClaudeArgs(input)], {
    cwd: input.cwd,
    env: agentEnv(process.env),
    stdin: new TextEncoder().encode(input.prompt),
    stdout: "pipe",
    stderr: "pipe",
  });
```

- [ ] **Step 4: Run test + the agent suite (no regression)**

Run: `bun test test/agent/agent-env.test.ts test/agent/ 2>&1 | tail -3 && bun run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Lint, commit**

```bash
bun run lint
git add src/agent/providers/claude.ts test/agent/agent-env.test.ts
git commit -m "fix(m7): scrub LINEAR_API_KEY/GITHUB_TOKEN from the agent subprocess env (capability isolation)"
```

---

### Task 6: `driveToTerminal` — the bounded run driver loop

**Files:**
- Create: `src/daemon/run-ticket.ts` (the `driveToTerminal` export; `runTicket`/`formatRunSummary` land in Task 7)
- Test: `test/daemon/run-ticket.test.ts`

**Interfaces:**
- Consumes: `tick` (`src/daemon/loop.ts`), `getTicket` (`src/db/repos/ticket.ts`), `listPending` (`src/db/repos/signal.ts`).
- Produces:
  - `type RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress"`
  - `interface RunResult { outcome: RunOutcome; iterations: number; stage: string; status: string }`
  - `driveToTerminal(db, registry, opts: { ticketId: number; config; ports; profile; cap?: number }): Promise<RunResult>`

**Context (exit conditions, checked in this order each iteration after `tick`):**
1. `status === "done"` → `done`.
2. a pending `human_resume` signal → `blocked` (failure-policy / pollChecks escalated; `run` can't satisfy it).
3. `stage === "merge"` AND a pending `human_merge_approval` signal → `pr-ready` (PR opened, awaiting the human merge gate). **This is the success exit.**
4. `tick` returned `advanced === 0` for `IDLE_CAP` consecutive iterations → `no-progress` (stalled; e.g. misconfigured checks). Reset the idle counter whenever `advanced > 0`.
5. otherwise continue (bounded by `cap`).

`run` passes `profile` so `pollChecks` runs; with `checksSystem:'none'`, `external_checks` auto-delivers, so the only durable park `run` stops at is `human_merge_approval`.

- [ ] **Step 1: Write the failing test**

`test/daemon/run-ticket.test.ts`:
```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", commands: {}, checksSystem: "none" });

function reg() {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => { throw new Error("no agent in merge"); }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rt-")),
  });
}

function seedAtMerge(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'merge' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "sha1" });
}

const ports = () => ({ issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: fakeChecks("passing") });

test("drives a merge-stage ticket to pr-ready (parked on human_merge_approval)", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const r = await driveToTerminal(db, reg(), { ticketId, config: DEFAULT_RUNTIME_CONFIG, ports: ports(), profile });
  expect(r.outcome).toBe("pr-ready");
  expect(r.stage).toBe("merge");
  db.close();
});

test("reports blocked when a human_resume escalation is pending", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  insertPending(db, { ticketId, signalType: "human_resume", reason: "stuck" });
  const r = await driveToTerminal(db, reg(), { ticketId, config: DEFAULT_RUNTIME_CONFIG, ports: ports(), profile });
  expect(r.outcome).toBe("blocked");
  db.close();
});

test("reports no-progress when nothing advances and no terminal is reached", async () => {
  const { db, ticketId } = makeTestDb();
  // Park on external_checks but drive WITHOUT a profile-less tick path: pass an unsupported
  // checksSystem so pollChecks never delivers → the ticket stalls.
  const stalledProfile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: {}, checksSystem: "external" });
  seedAtMerge(db, ticketId);
  const r = await driveToTerminal(db, reg(), { ticketId, config: DEFAULT_RUNTIME_CONFIG, ports: ports(), profile: stalledProfile, cap: 12 });
  expect(r.outcome).toBe("no-progress");
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/run-ticket.test.ts`
Expected: FAIL — `run-ticket.ts` / `driveToTerminal` does not exist.

- [ ] **Step 3: Write `driveToTerminal` in `src/daemon/run-ticket.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { listPending } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { tick } from "./loop.ts";
import type { ProjectorPorts } from "./projector.ts";
import type { StepRegistry } from "./step-registry.ts";

export type RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress";
export interface RunResult {
  outcome: RunOutcome;
  iterations: number;
  stage: string;
  status: string;
}

const DEFAULT_CAP = 200; // overall iteration budget for one ticket
const IDLE_CAP = 3; // consecutive zero-advance ticks → stalled

/** Drive ONE ticket through repeated ticks until a terminal state. `run` exits at PR-ready (the
 *  ticket parked at merge on human_merge_approval — the PR is open, awaiting the human merge gate
 *  which `run` never delivers). Passes `profile` so pollChecks delivers external_checks. */
export async function driveToTerminal(
  db: Database,
  registry: StepRegistry,
  opts: {
    ticketId: number;
    config: RuntimeConfig;
    ports: ProjectorPorts;
    profile: { checksSystem: string };
    cap?: number;
  },
): Promise<RunResult> {
  const cap = opts.cap ?? DEFAULT_CAP;
  let idle = 0;
  let last = { stage: "", status: "" };
  for (let i = 1; i <= cap; i++) {
    const r = await tick(db, registry, { config: opts.config, ports: opts.ports, profile: opts.profile });
    const t = getTicket(db, opts.ticketId);
    if (!t) throw new Error(`driveToTerminal: ticket ${opts.ticketId} not found`);
    last = { stage: t.stage, status: t.status };
    const pending = listPending(db, opts.ticketId);

    if (t.status === "done") return { outcome: "done", iterations: i, ...last };
    if (pending.some((s) => s.signal_type === "human_resume"))
      return { outcome: "blocked", iterations: i, ...last };
    if (t.stage === "merge" && pending.some((s) => s.signal_type === "human_merge_approval"))
      return { outcome: "pr-ready", iterations: i, ...last };

    if (r.advanced === 0) {
      idle += 1;
      if (idle >= IDLE_CAP) return { outcome: "no-progress", iterations: i, ...last };
    } else {
      idle = 0;
    }
  }
  return { outcome: "no-progress", iterations: cap, ...last };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/daemon/run-ticket.test.ts && bun run typecheck`
Expected: PASS (3 tests) + typecheck clean. (The pr-ready test: with `checksSystem:'none'`, the poll auto-delivers `external_checks`, the ticket parks on `human_merge_approval`. The no-progress test: `checksSystem:'external'` is never delivered, so after `merge:pr-ensure` the ticket parks on `external_checks` and stalls → `no-progress`.)

- [ ] **Step 5: Lint, commit**

```bash
bun run lint
git add src/daemon/run-ticket.ts test/daemon/run-ticket.test.ts
git commit -m "feat(m7): driveToTerminal — bounded run driver with pr-ready/blocked/no-progress detection"
```

---

### Task 7: `runTicket` + `styre run` command + telemetry summary

**Files:**
- Modify: `src/daemon/run-ticket.ts` (add `runTicket` + `formatRunSummary`)
- Create: `src/cli/run.ts` (the citty command)
- Modify: `src/index.ts` (register `run`)
- Create: `test/helpers/skeleton-registry.ts` (extract from `walking-skeleton.test.ts`)
- Modify: `test/daemon/walking-skeleton.test.ts` (import the extracted helper)
- Test: `test/cli/run-e2e.test.ts`

**Interfaces:**
- Consumes: `driveToTerminal` (Task 6); `fetchTicket` (Task 3); `makeProjectorPorts` (Task 4); `insertProject`/`insertTicket`; `branchPrefixFor`; `listByTicket` (`src/db/repos/event-log.ts`); `recover`/`realRecoverDeps`; `migrate`; `openDb`; `loadProfile`; `selectAgentRunner` + `claudeAgentRunner`; `buildDispatchRegistry`; `DEFAULT_RUNTIME_CONFIG`/`RuntimeConfigSchema`; `DEFAULT_AGENT_CONFIG`.
- Produces:
  - `runTicket(deps: { db; profile: Profile; runtimeConfig: RuntimeConfig; ports: ProjectorPorts; registry: StepRegistry; ticketRef: string }): Promise<RunResult & { ticketId: number; summary: string }>` — fetch → ingest (insertProject + insertTicket) → driveToTerminal → summarize.
  - `formatRunSummary(db, ticketId: number, result: RunResult): string` — a multi-line summary from `event_log` + final ticket stage/status.
  - `runCommand` (citty) wired into `src/index.ts`.

**Context:** `runTicket` is the testable core (deps injected — tests pass fakes + the skeleton registry). `runCommand` is the thin wrapper that builds the REAL deps (migrate temp DB → openDb → recover → loadProfile → load config → makeProjectorPorts → real agent runner + registry) and calls `runTicket`. The end-to-end against real Linear/GitHub/Claude is the operator smoke test (the adapter-smoke-test precedent), since the SDK paths aren't unit-tested.

- [ ] **Step 1: Extract the skeleton registry to a test helper**

Move the `skeletonRegistry()` function out of `test/daemon/walking-skeleton.test.ts` into a new `test/helpers/skeleton-registry.ts` that exports it (`export function skeletonRegistry(): StepRegistry { ... }` — same body, with its imports). In `walking-skeleton.test.ts`, delete the local definition and add `import { skeletonRegistry } from "../helpers/skeleton-registry.ts";`. Run `bun test test/daemon/walking-skeleton.test.ts` to confirm the extraction is behavior-preserving (still PASS).

- [ ] **Step 2: Write the failing integration test**

`test/cli/run-e2e.test.ts`:
```ts
import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { runTicket } from "../../src/daemon/run-ticket.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { skeletonRegistry } from "../helpers/skeleton-registry.ts";
import { makeTestDb } from "../helpers/db.ts";

test("runTicket ingests a Linear ticket and drives it to pr-ready", async () => {
  const { db } = makeTestDb({ seedTicket: false }); // a project/ticket-free DB; runTicket ingests
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main", commands: {}, checksSystem: "none" });
  const ports = {
    issueTracker: fakeIssueTracker({
      ticket: { ident: "ENG-42", title: "Real title", description: "Real body / AC", typeLabel: "Bug", linearIssueUuid: "uuid-42", url: "http://x/42" },
    }),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };

  const out = await runTicket({
    db,
    profile,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ports,
    registry: skeletonRegistry(),
    ticketRef: "ENG-42",
  });

  expect(out.outcome).toBe("pr-ready");
  // Ingestion persisted the fetched fields.
  const t = getTicket(db, out.ticketId);
  expect(t?.ident).toBe("ENG-42");
  expect(t?.title).toBe("Real title");
  expect(t?.description).toBe("Real body / AC");
  expect(t?.type_label).toBe("Bug");
  expect(t?.branch_prefix).toBe("fix");
  // fetchTicket was the ingestion read.
  expect(ports.issueTracker.calls.some((c) => c.method === "fetchTicket")).toBe(true);
  // Summary mentions the final stage.
  expect(out.summary).toContain("merge");
  db.close();
});
```
NOTE: if `makeTestDb` does not support a `{ seedTicket: false }` option, adapt: use `makeTestDb()` and ingest a DISTINCT ident (`ENG-42`) so it doesn't collide with any pre-seeded ticket (the assertions read `out.ticketId`, the row `runTicket` created). Confirm the helper's behavior first and pick the form that gives `runTicket` a clean project/ident to insert.

⚠️ The skeleton registry must reach `stage='merge'` and open the PR park. Confirm `skeletonRegistry` registers `merge:push`/`merge:pr-ensure` (the walking-skeleton drives to released, so it must). If those skeleton handlers don't enqueue real forge ops, the ticket still parks on `human_merge_approval` after `external_checks` auto-delivers (the resolver doesn't gate on `external_pr_result`), so `pr-ready` is still reached — the fake forge need not be called for this assertion.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/cli/run-e2e.test.ts`
Expected: FAIL — `runTicket` is not exported yet.

- [ ] **Step 4: Add `runTicket` + `formatRunSummary` to `src/daemon/run-ticket.ts`**

```ts
import { listByTicket } from "../db/repos/event-log.ts";
import { insertProject } from "../db/repos/project.ts";
import { insertTicket } from "../db/repos/ticket.ts";
import { branchPrefixFor } from "../integrations/ticket-source.ts";
import type { Profile } from "../dispatch/profile.ts";

/** Ingest ONE ticket (read from the tracker) into the SoT, then drive it to a terminal. The single
 *  Linear read happens here, at trigger — never in the control loop. */
export async function runTicket(deps: {
  db: Database;
  profile: Profile;
  runtimeConfig: RuntimeConfig;
  ports: ProjectorPorts;
  registry: StepRegistry;
  ticketRef: string;
}): Promise<RunResult & { ticketId: number; summary: string }> {
  const ingested = await deps.ports.issueTracker.fetchTicket(deps.ticketRef);
  const projectId = insertProject(deps.db, {
    slug: deps.profile.slug,
    targetRepo: deps.profile.targetRepo,
    defaultBranch: deps.profile.defaultBranch,
  });
  const ticketId = insertTicket(deps.db, {
    projectId,
    ident: ingested.ident,
    title: ingested.title,
    description: ingested.description,
    typeLabel: ingested.typeLabel,
    branchPrefix: branchPrefixFor(ingested.typeLabel),
    linearIssueUuid: ingested.linearIssueUuid,
  });
  const result = await driveToTerminal(deps.db, deps.registry, {
    ticketId,
    config: deps.runtimeConfig,
    ports: deps.ports,
    profile: deps.profile,
  });
  return { ...result, ticketId, summary: formatRunSummary(deps.db, ticketId, result) };
}

/** A plain-text run summary from the durable SoT: outcome + final stage/status + the event timeline.
 *  (Per-step cost/usage needs a metric_event writer — deferred.) */
export function formatRunSummary(db: Database, ticketId: number, result: RunResult): string {
  const events = listByTicket(db, ticketId);
  const lines = [
    `run: ${result.outcome} (stage=${result.stage}, status=${result.status}, ${result.iterations} ticks)`,
    `events: ${events.length}`,
    ...events.map(
      (e) =>
        `  #${e.seq} ${e.kind}${e.from_stage ? ` ${e.from_stage}→${e.to_stage}` : ""}${e.reason ? ` — ${e.reason}` : ""}`,
    ),
  ];
  return lines.join("\n");
}
```
(Confirm the `event_log` row field names via `src/db/repos/event-log.ts` — `seq`, `kind`, `from_stage`, `to_stage`, `reason`. Adjust the template to the actual `EventRow` field names.)

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `bun test test/cli/run-e2e.test.ts && bun run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Write the `styre run` command (`src/cli/run.ts`)**

```ts
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../config/runtime-config.ts";
import { claudeAgentRunner } from "../agent/providers/claude.ts";
import { selectAgentRunner } from "../agent/registry.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import { recover, realRecoverDeps } from "../daemon/recover.ts";
import { runTicket } from "../daemon/run-ticket.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import { loadProfile } from "../dispatch/profile.ts";

export const runCommand = defineCommand({
  meta: { name: "run", description: "Ingest one ticket and drive it to PR-ready, then exit." },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket ref (e.g. ENG-123)" },
    profile: { type: "string", required: true, description: "Path to the project-profile JSON" },
    config: { type: "string", description: "Path to a runtime config.json (optional)" },
    db: { type: "string", description: "DB path (default: a fresh per-run temp DB)" },
  },
  async run({ args }) {
    const dbPath = args.db && args.db.length > 0 ? args.db : join(mkdtempSync(join(tmpdir(), "styre-run-")), "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    recover(db, realRecoverDeps());

    const profile = loadProfile(args.profile);
    const runtimeConfig =
      args.config && args.config.length > 0
        ? RuntimeConfigSchema.parse(JSON.parse(readFileSync(args.config, "utf8")))
        : DEFAULT_RUNTIME_CONFIG;

    const ports = makeProjectorPorts(runtimeConfig, profile);
    const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
    const registry = buildDispatchRegistry({
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile,
      worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
    });

    const out = await runTicket({ db, profile, runtimeConfig, ports, registry, ticketRef: args.ticket });
    console.log(out.summary);
    db.close();
    if (out.outcome === "blocked" || out.outcome === "no-progress") {
      throw new Error(`run: ticket ${args.ticket} ended ${out.outcome}`);
    }
  },
});
```
(Confirm `selectAgentRunner`'s adapter-map key is `claude` and `claudeAgentRunner()`'s signature from `src/agent/registry.ts` / `src/agent/providers/claude.ts`; adjust if the registry key differs.)

- [ ] **Step 7: Register `run` in `src/index.ts`**

Add the import and the subcommand:
```ts
import { runCommand } from "./cli/run.ts";
// ... in defineCommand({ subCommands: { migrate: migrateCommand, run: runCommand } })
```

- [ ] **Step 8: Verify the command wires up (typecheck + build + a smoke of arg parsing)**

Run: `bun run typecheck && bun run build && bun run src/index.ts run --help 2>&1 | head -20`
Expected: typecheck + build clean; `run --help` prints the command usage (the ticket positional + `--profile`/`--config`/`--db` flags). (A real `styre run ENG-x --profile ...` needs live creds + repo — that's the operator smoke test, not CI.)

- [ ] **Step 9: Lint, commit**

```bash
bun run lint
git add src/daemon/run-ticket.ts src/cli/run.ts src/index.ts test/helpers/skeleton-registry.ts test/daemon/walking-skeleton.test.ts test/cli/run-e2e.test.ts
git commit -m "feat(m7): styre run command — ingest a ticket, drive to PR-ready, telemetry summary"
```

---

## Final Verification (run after all tasks)

```bash
bun test           # all green (prior suite + new M7 tests)
bun run lint       # clean
bun run typecheck  # clean
bun run build      # single binary builds
git diff main -- src/db/schema.sql docs/architecture/schema.sql   # shows ONLY the +description column, identical in both
grep -rln 'from.*@linear' src/    # exactly one: src/integrations/adapters/linear.ts
grep -rln 'from.*@octokit' src/   # exactly one: src/integrations/adapters/github.ts
bun run src/index.ts run --help   # the run command is registered
```

## Operator smoke test (manual — the real end-to-end)

The SDK paths (Linear read, GitHub push/PR, the `claude` agent) aren't unit-tested. After merge, verify against a real ticket:
```bash
GITHUB_TOKEN=… LINEAR_API_KEY=… ANTHROPIC_API_KEY=… \
  bun run src/index.ts run ENG-XXX --profile ./demo-profile.json
```
Expect: a plan committed under `docs/plans/`, work units implemented + verified, a review, a branch pushed and a PR opened, then the run prints `run: pr-ready (...)` and exits 0. The PR awaits your manual merge (no auto-merge).

## Out of Scope (carries → later milestones)

- **`styre daemon`** (persistent loop on POLL_INTERVAL) + the **needs-you inbox CLI** (`resume`/`approve`/`abandon`/`status`) — M7b. (M7 `run` exits at PR-ready and needs no human-signal delivery.)
- **`styre setup`** (profile auto-probe + `testFilePattern` probe + launchd/systemd install + Linear id-cache seed) — its own milestone. M7 takes a hand-written `--profile` JSON.
- **`metric_event` writer** (per-step cost/tokens) — M7's summary uses `event_log` only.
- **Rich ticket-contract ingestion** (the `styre_config` per-ticket config block, AC checklist, context-files, the "Ready for Agent" trigger state) — M7 ingests ident/title/description/type. Per-ticket config precedence + structured AC ride a later ticket-contract milestone.
- **Config precedence** beyond `--config config.json` + defaults (workspace-dir discovery via `$XDG_CONFIG_HOME`, profile-tier merge, per-ticket overrides).
- **Wait-budget enforcement, `"external"` checks translator, red-checks→re-code loopback, live human-merge poll + stale-branch, comment projections / `pr_comment` enqueuer, AgentConfig↔RuntimeConfig unification** — all prior M6 carries, untouched.
