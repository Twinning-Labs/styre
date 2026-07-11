# M-jira-2: JIRA Cloud Issue-Tracker Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class JIRA Cloud adapter implementing the existing `IssueTrackerPort`, config-selected as `issueTracker: "jira"`, at functional parity with the Linear adapter (inbound fetch + outbound state/labels/comments) — including a structured, monitorable telemetry event when a state projection is skipped.

**Architecture:** One new adapter file `src/integrations/adapters/jira.ts` (the vendor edge, hand-rolled `fetch` — no SDK) plus `src/integrations/adapters/jira-adf.ts` (ADF→markdown for descriptions). Following the established adapter convention (`linear.ts` / `github.ts`): **all decision logic lives in pure, unit-tested helpers; the HTTP-calling methods are thin shells, covered by the loop-level fake port + a documented operator smoke test, not unit tests.** A foundation task first makes `setState` return a disposition so the **projector** (which holds the DB + ticket) writes a structured `projection_skipped` telemetry event when the board can't be updated — the DB-backed telemetry path Styre already uses, keeping the vendor adapter free of telemetry plumbing.

**Tech Stack:** TypeScript, Bun (`bun test`), `zod` (config), the global `fetch`. No new dependencies.

## Global Constraints

- **Never commit to `main`.** Work on `feat/jira-adapter` (branched after M-jira-1). Branch prefix `feat/`; PR-only; **no auto-merge** (operator merges).
- **Depends on M-jira-1** (the `externalId` / `external_*` neutralization — PR #74). `IngestedTicket` fields: `ident`, `title`, `description: string | null`, `typeLabel: "Bug"|"Feature"|"Improvement"`, `externalId: string | null`, `url: string | null`.
- **The vendor edge stays in `jira.ts`.** No `fetch`/JIRA calls anywhere else. The core depends only on `../issue-tracker.ts`. The adapter gets NO `db`, `emit`, or telemetry handle — it is a pure vendor edge (linear.ts:1-8 precedent).
- **`IssueState` values (exact):** `"in_progress" | "in_review" | "done" | "canceled" | "blocked"` (`src/integrations/issue-tracker.ts:6`).
- **`setState` return contract (NEW — Task 1):** `setState(ref, state): Promise<SetStateResult>` where `SetStateResult = { applied: boolean; reason?: string }`. `applied: true` = state set (or already correct); `applied: false` = projection skipped, board left unchanged (a workflow mismatch, NOT a transport failure). This changes the shared `IssueTrackerPort` and both existing implementers (Linear + fake) plus the projector — a small typed change, done in Task 1 before the JIRA adapter uses it.
- **Observable soft-fail (the resolved design decision):** on a workflow mismatch / screen-field rejection, `setState` **returns `{ applied: false, reason }`** (never throws, never `console.warn`). The projector turns that into a **structured telemetry event** via `appendEvent(db, { kind: "note", reason, payload: { event: "projection_skipped", target_state } })`, which the existing per-run emitter streams to the NDJSON feed (the same DB-backed path the projector already uses for escalations). This is the monitorable board-drift signal the design requires. Genuine transport errors (5xx / 401 / network) still **throw** so the outbox retries. (We reuse the existing `event_log` kind `"note"` + a machine-readable payload discriminator — **no schema change**; a dedicated `EventKind` is a trivial future promotion if monitoring wants one.)
- **No schema change** in M-jira-2 (uses the existing `"note"` event kind).
- **Auth:** JIRA Cloud, REST API v3 at `<JIRA_BASE_URL>/rest/api/3`, Basic auth `base64(JIRA_EMAIL:JIRA_API_TOKEN)`. Missing any of the three env vars → a setup/GOAL-INSTALL error (mirrors `linear.ts:71`).
- **AC parsing depends on the ADF renderer:** JIRA v3 descriptions are always ADF; the renderer MUST turn `taskList`/`taskItem` nodes into GFM `- [ ]` / `- [x]` so `parseAcChecklist` (`src/dispatch/ac-checklist.ts`, regex `^\s*[-*+]\s+\[[ xX]\]`) sees them.
- **Testing convention (binding):** unit-test ONLY the pure helpers (mirrors `test/integrations/linear-adapter.test.ts`). Do NOT write unit tests that hit `fetch` or mock the HTTP layer for the adapter methods — they are verified by typecheck + build + the loop-level fake + the operator smoke test documented in the adapter docstring.
- **Commands** (from worktree root): typecheck `bun run typecheck`, tests `bun test`, lint `bun run lint`. Commits: Conventional Commits with the `Co-Authored-By: Claude Opus 4.8 (1M context)` + `Claude-Session:` trailers.

---

## File Structure

- Modify: `src/integrations/issue-tracker.ts` — add `SetStateResult`; change `setState` return type. (Task 1)
- Modify: `src/integrations/adapters/linear.ts` — return the disposition. (Task 1)
- Modify: `src/integrations/adapters/fake-issue-tracker.ts` — return the disposition. (Task 1)
- Modify: `src/daemon/projector.ts` — capture the `setState` disposition; emit the `projection_skipped` note. (Task 1)
- Modify: `test/daemon/projector.test.ts` — add the projection-skipped-emits-a-note test. (Task 1)
- Create: `src/integrations/adapters/jira-adf.ts` + `test/integrations/jira-adf.test.ts` — ADF→markdown renderer. (Task 2)
- Create: `src/integrations/adapters/jira.ts` — pure helpers (Task 3) + factory/methods (Task 4).
- Create: `test/integrations/jira-adapter.test.ts` — pure-helper unit tests. (Task 3)
- Modify: `src/config/runtime-config.ts` + `test/config/runtime-config.test.ts` — the `jira` config block. (Task 3)
- Modify: `src/daemon/ports.ts` + `test/integrations/issue-tracker.test.ts` — register `jira`. (Task 4)
- Modify: `src/cli/setup.ts` + create `test/cli/setup-cred-note.test.ts` — tracker-aware readiness. (Task 5)
- Modify: `src/agent/agent-env.ts` + `test/agent/agent-env.test.ts` — scrub `JIRA_API_TOKEN`. (Task 5)

---

## Task 1: `setState` disposition + structured `projection_skipped` telemetry

**Files:**
- Modify: `src/integrations/issue-tracker.ts:6-19`
- Modify: `src/integrations/adapters/linear.ts:95-111`
- Modify: `src/integrations/adapters/fake-issue-tracker.ts:23-25`
- Modify: `src/daemon/projector.ts:107-109`
- Test: `test/daemon/projector.test.ts`

**Interfaces:**
- Produces: `interface SetStateResult { applied: boolean; reason?: string }`, exported from `issue-tracker.ts`; `IssueTrackerPort.setState(ref, state): Promise<SetStateResult>`. Consumed by every adapter (Linear now, JIRA in Task 4) and by the projector.

- [ ] **Step 1: Write the failing projector test**

Add to `test/daemon/projector.test.ts` (note the imports it needs — `listByTicket` from the event-log repo; check the file's existing imports and add if missing):

```ts
import { listByTicket } from "../../src/db/repos/event-log.ts";

test("a skipped state projection (applied:false) emits a projection_skipped note, row delivered", async () => {
  const { db, ticketId } = makeTestDb();
  enqueue(db, {
    ticketId,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: "done" },
    idempotencyKey: "k-skip",
  });
  const skipping = fakeIssueTracker();
  skipping.setState = async () => ({ applied: false, reason: "no transition to Done" });
  const out = await drainOutbox(db, { issueTracker: skipping });
  const events = listByTicket(db, ticketId);
  db.close();
  expect(out.sent).toBe(1); // a skip is a delivered row, not a transport failure/retry
  const note = events.find(
    (e) => e.kind === "note" && (e.payload_json ?? "").includes("projection_skipped"),
  );
  expect(note).toBeDefined();
  expect(note?.reason).toContain("no transition to Done");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/daemon/projector.test.ts`
Expected: FAIL — `applied`/return-type mismatch (the fake `setState` returns void today) and no `projection_skipped` note is written.

- [ ] **Step 3: Add `SetStateResult` and change the port in `src/integrations/issue-tracker.ts`**

```ts
// after the IssueState line (line 6), add:
export interface SetStateResult {
  /** true = the tracker state was set (or already correct); false = the projection was skipped and
   *  the board left unchanged (a workflow mismatch — NOT a transport failure, which throws). */
  applied: boolean;
  /** when !applied: a short human reason, surfaced in the projection_skipped telemetry note. */
  reason?: string;
}
```
```ts
// change the setState signature in the interface (line 13):
// before
  setState(ref: string, state: IssueState): Promise<void>;
// after
  setState(ref: string, state: IssueState): Promise<SetStateResult>;
```

- [ ] **Step 4: Return the disposition from the Linear adapter (`src/integrations/adapters/linear.ts`)**

```ts
// import (add SetStateResult to the existing type import on line 25):
import type { IssueState, IssueTrackerPort, SetStateResult } from "../issue-tracker.ts";
```
```ts
// setState signature (line 95):
    async setState(ref: string, state: IssueState): Promise<SetStateResult> {
```
```ts
// the already-there no-op (line 100):
// before
      if (currentState?.name === targetName) return;
// after
      if (currentState?.name === targetName) return { applied: true };
```
```ts
// end of setState, after `await client.updateIssue(issue.id, { stateId: target.id });` (line 110):
      return { applied: true };
```
(The existing `throw`s for a missing team / missing workflow state stay — those are hard config/transport errors, not soft skips. Linear's behavior is otherwise unchanged.)

- [ ] **Step 5: Return the disposition from the fake (`src/integrations/adapters/fake-issue-tracker.ts`)**

```ts
// import (line 1):
import type { IssueState, IssueTrackerPort, SetStateResult } from "../issue-tracker.ts";
```
```ts
// setState (lines 23-25):
// before
    async setState(ref: string, state: IssueState) {
      calls.push({ method: "setState", args: [ref, state] });
    },
// after
    async setState(ref: string, state: IssueState): Promise<SetStateResult> {
      calls.push({ method: "setState", args: [ref, state] });
      return { applied: true };
    },
```

- [ ] **Step 6: Emit the note in the projector (`src/daemon/projector.ts`)**

`appendEvent` is already imported (used by `escalateProjection`). Change the `set_state` case (lines 107-109):

```ts
// before
      case "set_state":
        await it.setState(ref, payload.state as IssueState);
        return null;
// after
      case "set_state": {
        const res = await it.setState(ref, payload.state as IssueState);
        if (!res.applied) {
          // Board could not be updated (workflow mismatch) — NOT a transport failure. Record a
          // structured, monitorable telemetry note; the row is still delivered (control runs on).
          appendEvent(db, {
            ticketId: row.ticket_id,
            kind: "note",
            reason: res.reason ?? "issue-tracker state projection skipped (board left unchanged)",
            payload: { event: "projection_skipped", target_state: payload.state },
          });
        }
        return null;
      }
```

- [ ] **Step 7: Run tests + typecheck + lint**

Run: `bun test test/daemon/projector.test.ts` → PASS (the new test + the existing ones; the two `throwing.setState = async () => { throw … }` stubs still typecheck — a thrown promise is assignable to `Promise<SetStateResult>`).
Run: `bun test` → PASS (full suite; every `setState` caller now returns/handles the disposition).
Run: `bun run typecheck` → PASS. Run: `bun run lint` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/integrations/issue-tracker.ts src/integrations/adapters/linear.ts \
  src/integrations/adapters/fake-issue-tracker.ts src/daemon/projector.ts test/daemon/projector.test.ts
git commit -m "feat(projector): setState disposition + projection_skipped telemetry note

setState returns { applied, reason? }; when a state projection is skipped
(board unchanged, not a transport failure) the projector writes a structured
event_log 'note' (payload.event=projection_skipped) that streams to the NDJSON
telemetry feed. Foundation for the JIRA adapter's soft-fail. (M-jira-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Task 2: ADF → markdown renderer

**Files:**
- Create: `src/integrations/adapters/jira-adf.ts`
- Test: `test/integrations/jira-adf.test.ts`

**Interfaces:**
- Produces: `adfToMarkdown(doc: unknown): string` — renders a JIRA v3 ADF `doc` object to markdown; returns `""` for `null`/non-doc input; never throws. Consumed by `jira.ts` `fetchTicket` (Task 4).

- [ ] **Step 1: Write the failing tests**

Create `test/integrations/jira-adf.test.ts`:

```ts
import { expect, test } from "bun:test";
import { adfToMarkdown } from "../../src/integrations/adapters/jira-adf.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("task-list nodes become GFM checkboxes (the load-bearing case)", () => {
  const adf = doc({
    type: "taskList",
    content: [
      { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "done item" }] },
      { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "todo item" }] },
    ],
  });
  expect(adfToMarkdown(adf)).toBe("- [x] done item\n- [ ] todo item");
});

test("paragraphs, headings, and marks", () => {
  const adf = doc(
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "bold", marks: [{ type: "strong" }] },
        { type: "text", text: " and " },
        { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "http://x" } }] },
      ],
    },
  );
  expect(adfToMarkdown(adf)).toBe("## Title\n\n**bold** and [link](http://x)");
});

test("bullet and ordered lists", () => {
  const adf = doc(
    { type: "bulletList", content: [
      { type: "listItem", content: [para("a")] },
      { type: "listItem", content: [para("b")] },
    ] },
    { type: "orderedList", content: [
      { type: "listItem", content: [para("one")] },
    ] },
  );
  expect(adfToMarkdown(adf)).toBe("- a\n- b\n\n1. one");
});

test("code block with language", () => {
  const adf = doc({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "x = 1" }] });
  expect(adfToMarkdown(adf)).toBe("```ts\nx = 1\n```");
});

test("unknown node degrades to its text; never throws", () => {
  const adf = doc({ type: "someFutureNode", content: [{ type: "text", text: "kept" }] });
  expect(adfToMarkdown(adf)).toBe("kept");
});

test("null / non-doc input returns empty string", () => {
  expect(adfToMarkdown(null)).toBe("");
  expect(adfToMarkdown({ type: "paragraph" })).toBe("");
  expect(adfToMarkdown("plain")).toBe("");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/integrations/jira-adf.test.ts`
Expected: FAIL — `adfToMarkdown` is not defined / module missing.

- [ ] **Step 3: Implement `src/integrations/adapters/jira-adf.ts`**

```ts
/** Minimal ADF (Atlassian Document Format) -> Markdown renderer. ONE direction, for JIRA Cloud v3
 *  issue DESCRIPTIONS (always an ADF `doc` or null). We render to markdown so the existing
 *  parseAcChecklist sees GFM task-list items — the taskList/taskItem node is the load-bearing case
 *  (that is how a JIRA checklist becomes acceptance criteria). Unknown nodes degrade to their text
 *  content; the renderer never throws. Pure + unit-tested. Comments do NOT use this. */

type Mark = { type: string; attrs?: Record<string, unknown> };
type AdfNode = {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
};

function applyMarks(text: string, marks?: Mark[]): string {
  if (!marks) return text;
  let out = text;
  for (const m of marks) {
    if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `*${out}*`;
    else if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "link") out = `[${out}](${(m.attrs?.href as string) ?? ""})`;
  }
  return out;
}

function renderInline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += applyMarks(n.text ?? "", n.marks);
    else if (n.type === "hardBreak") out += "\n";
    else out += renderInline(n.content); // unknown inline → its text
  }
  return out;
}

function renderList(node: AdfNode, marker: (i: number) => string, indent: string): string {
  return (node.content ?? [])
    .map((item, i) => `${indent}${marker(i)} ${renderInline(item.content?.[0]?.content).trim()}`)
    .join("\n");
}

function renderTaskList(node: AdfNode, indent: string): string {
  return (node.content ?? [])
    .map((item) => {
      const box = item.attrs?.state === "DONE" ? "[x]" : "[ ]";
      return `${indent}- ${box} ${renderInline(item.content)}`;
    })
    .join("\n");
}

function renderBlock(node: AdfNode, indent: string): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${renderInline(node.content)}`;
    }
    case "bulletList":
      return renderList(node, () => "-", indent);
    case "orderedList":
      return renderList(node, (i) => `${i + 1}.`, indent);
    case "taskList":
      return renderTaskList(node, indent);
    case "codeBlock":
      return `\`\`\`${(node.attrs?.language as string) ?? ""}\n${renderInline(node.content)}\n\`\`\``;
    case "blockquote":
      return renderBlocks(node.content ?? [], indent)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    default:
      return node.content ? renderBlocks(node.content, indent) : (node.text ?? "");
  }
}

function renderBlocks(nodes: AdfNode[], indent: string): string {
  return nodes
    .map((n) => renderBlock(n, indent))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const root = doc as AdfNode;
  if (root.type !== "doc" || !root.content) return "";
  return renderBlocks(root.content, "");
}
```

Note on `renderList`: list items wrap their text in a `paragraph` child, so it reads `item.content?.[0]?.content` (the paragraph's inline content). Minimal-but-correct; deeply nested lists degrade gracefully.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/integrations/jira-adf.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/adapters/jira-adf.ts test/integrations/jira-adf.test.ts
git commit -m "feat(jira): ADF->markdown renderer for issue descriptions

Task-list nodes become GFM checkboxes so parseAcChecklist sees them; unknown
nodes degrade to text, never throws. Pure + unit-tested. (M-jira-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Task 3: Adapter pure helpers + config schema

**Files:**
- Create: `src/integrations/adapters/jira.ts` (helpers + types only in this task; the factory/methods are Task 4)
- Test: `test/integrations/jira-adapter.test.ts`
- Modify: `src/config/runtime-config.ts`
- Test: `test/config/runtime-config.test.ts`

**Interfaces:**
- Produces (from `jira.ts`), consumed by Task 4:
  - `interface JiraStatusTarget { status: string; resolution?: string }`
  - `interface JiraAdapterConfig { statusMap?: Record<string, JiraStatusTarget>; bugTypeNames?: string[] }`
  - `jiraTypeLabel(issueTypeName: string, bugTypeNames?: string[]): TypeLabel`
  - `resolveStatusTarget(state: IssueState, cfg?: JiraAdapterConfig): JiraStatusTarget`
  - `interface JiraTransition { id: string; name: string; to: { name: string }; fields?: Record<string, { required: boolean }> }`
  - `type TransitionPick = { kind: "found"; id: string; setResolution: boolean } | { kind: "none" } | { kind: "unsatisfiable" }`
  - `pickTransition(transitions: JiraTransition[], target: JiraStatusTarget): TransitionPick`
  - `labelUpdateOps(change: { add: string[]; remove: string[] }): { update: { labels: ({ add: string } | { remove: string })[] } }`
  - `projKeyMarker(idempotencyKey: string): string`
  - `adfComment(body: string, idempotencyKey: string): unknown`
  - `commentHasMarker(commentBodies: unknown[], idempotencyKey: string): boolean`
  - `mapJiraError(status: number, bodyText: string): Error & { status: number }`
- Produces (from `runtime-config.ts`): `RuntimeConfigSchema` now has an optional `jira` block; `runtimeConfig.jira` is `{ statusMap?: Record<string,{status:string;resolution?:string}>; bugTypeNames?: string[] } | undefined`.

- [ ] **Step 1: Write the failing helper tests**

Create `test/integrations/jira-adapter.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  adfComment,
  commentHasMarker,
  jiraTypeLabel,
  labelUpdateOps,
  mapJiraError,
  pickTransition,
  projKeyMarker,
  resolveStatusTarget,
} from "../../src/integrations/adapters/jira.ts";

test("jiraTypeLabel: Bug -> Bug, everything else -> Feature; bugTypeNames override", () => {
  expect(jiraTypeLabel("Bug")).toBe("Bug");
  expect(jiraTypeLabel("Story")).toBe("Feature");
  expect(jiraTypeLabel("Task")).toBe("Feature");
  expect(jiraTypeLabel("Defect", ["Bug", "Defect"])).toBe("Bug");
  expect(jiraTypeLabel("bug")).toBe("Bug"); // case-insensitive
});

test("resolveStatusTarget: defaults + config override", () => {
  expect(resolveStatusTarget("in_progress")).toEqual({ status: "In Progress" });
  expect(resolveStatusTarget("done")).toEqual({ status: "Done", resolution: "Done" });
  expect(resolveStatusTarget("canceled")).toEqual({ status: "Done", resolution: "Won't Do" });
  expect(resolveStatusTarget("in_review", { statusMap: { in_review: { status: "Reviewing" } } }))
    .toEqual({ status: "Reviewing" });
});

const tr = (id: string, toName: string, fields?: Record<string, { required: boolean }>) => ({
  id, name: `to ${toName}`, to: { name: toName }, fields,
});

test("pickTransition: matches target status by name (case-insensitive)", () => {
  const pick = pickTransition([tr("11", "In Progress"), tr("21", "Done")], { status: "in progress" });
  expect(pick).toEqual({ kind: "found", id: "11", setResolution: false });
});

test("pickTransition: no transition to the target -> none", () => {
  expect(pickTransition([tr("21", "Done")], { status: "In Review" })).toEqual({ kind: "none" });
});

test("pickTransition: required resolution present on screen + configured -> found w/ setResolution", () => {
  const pick = pickTransition([tr("31", "Done", { resolution: { required: true } })], { status: "Done", resolution: "Done" });
  expect(pick).toEqual({ kind: "found", id: "31", setResolution: true });
});

test("pickTransition: required resolution but none configured -> unsatisfiable", () => {
  const pick = pickTransition([tr("31", "Done", { resolution: { required: true } })], { status: "Done" });
  expect(pick).toEqual({ kind: "unsatisfiable" });
});

test("pickTransition: an OTHER required field we cannot supply -> unsatisfiable", () => {
  const pick = pickTransition([tr("41", "Done", { customfield_1: { required: true } })], { status: "Done", resolution: "Done" });
  expect(pick).toEqual({ kind: "unsatisfiable" });
});

test("labelUpdateOps: atomic add/remove ops", () => {
  expect(labelUpdateOps({ add: ["styre"], remove: ["old"] })).toEqual({
    update: { labels: [{ add: "styre" }, { remove: "old" }] },
  });
});

test("projKeyMarker / adfComment / commentHasMarker round-trip", () => {
  const marker = projKeyMarker("k1");
  expect(marker).toBe("[proj-key:k1]");
  const adf = adfComment("hello", "k1");
  expect(JSON.stringify(adf)).toContain("hello");
  expect(JSON.stringify(adf)).toContain(marker);
  expect(commentHasMarker([adfComment("other", "k1")], "k1")).toBe(true);
  expect(commentHasMarker([adfComment("other", "k2")], "k1")).toBe(false);
});

test("mapJiraError: 401 -> expired/invalid token; parses JIRA error body", () => {
  const e401 = mapJiraError(401, "unauth");
  expect(e401.status).toBe(401);
  expect(e401.message).toContain("expired");
  const e400 = mapJiraError(400, JSON.stringify({ errorMessages: ["bad field"], errors: { resolution: "required" } }));
  expect(e400.status).toBe(400);
  expect(e400.message).toContain("bad field");
  expect(e400.message).toContain("required");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/integrations/jira-adapter.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement the helpers in `src/integrations/adapters/jira.ts`**

Create the file with the docstring + helpers (the factory is appended in Task 4 — leave a `// --- factory (jiraIssueTracker) added in Task 4 ---` marker at the end):

```ts
/**
 * The hand-rolled JIRA Cloud adapter — the thin vendor edge implementing the neutral
 * `IssueTrackerPort` over the JIRA REST API v3 (Basic auth, `fetch`; NO SDK — jira.js is
 * single-maintainer 3P and does no ADF conversion). Only file in the repo that talks to JIRA.
 *
 * Per the adapter convention (linear.ts / github.ts): the DECISION logic lives in the pure helpers
 * below (unit-tested); the HTTP-calling methods in the factory are thin shells, covered by the fake
 * port + this smoke test, not unit tests.
 *
 * SMOKE TEST (operator-run, no real API in CI): a Cloud site + a scratch issue, then:
 *
 *   JIRA_BASE_URL=https://you.atlassian.net JIRA_EMAIL=you@x.com JIRA_API_TOKEN=xxx bun run -e '
 *     import { jiraIssueTracker } from "./src/integrations/adapters/jira.ts";
 *     const t = jiraIssueTracker();
 *     console.log(await t.fetchTicket("PROJ-1"));
 *     console.log(await t.setState("PROJ-1", "in_progress"));
 *     await t.setLabels("PROJ-1", { add: ["styre"], remove: [] });
 *     console.log(await t.addComment("PROJ-1", "smoke from styre", "smoke-" + Date.now()));
 *   '
 *
 * Expect: the ticket prints; setState returns {applied:true} (or {applied:false, reason} if the
 * workflow has no path); the "styre" label is added; a comment posts and a repeat key returns null.
 */
import type { IssueState, IssueTrackerPort, SetStateResult } from "../issue-tracker.ts";
import type { IngestedTicket, TypeLabel } from "../ticket-source.ts";
import { adfToMarkdown } from "./jira-adf.ts";

export interface JiraStatusTarget {
  status: string;
  resolution?: string;
}

export interface JiraAdapterConfig {
  /** neutral IssueState -> target JIRA status (+ optional resolution). */
  statusMap?: Record<string, JiraStatusTarget>;
  /** issue-type names treated as Bug (default ["Bug"]). */
  bugTypeNames?: string[];
}

/** Default neutral IssueState -> {status, resolution?}. Overridable via config.statusMap. */
const DEFAULT_STATUS_MAP: Record<IssueState, JiraStatusTarget> = {
  in_progress: { status: "In Progress" },
  in_review: { status: "In Review" },
  done: { status: "Done", resolution: "Done" },
  canceled: { status: "Done", resolution: "Won't Do" },
  blocked: { status: "In Progress" },
};

export function resolveStatusTarget(state: IssueState, cfg?: JiraAdapterConfig): JiraStatusTarget {
  return cfg?.statusMap?.[state] ?? DEFAULT_STATUS_MAP[state];
}

/** Bug -> Bug (fix/), everything else -> Feature (feat/). Case-insensitive; bugTypeNames override. */
export function jiraTypeLabel(issueTypeName: string, bugTypeNames?: string[]): TypeLabel {
  const bugs = (bugTypeNames ?? ["Bug"]).map((s) => s.toLowerCase());
  return bugs.includes(issueTypeName.toLowerCase()) ? "Bug" : "Feature";
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
  fields?: Record<string, { required: boolean }>;
}

export type TransitionPick =
  | { kind: "found"; id: string; setResolution: boolean }
  | { kind: "none" }
  | { kind: "unsatisfiable" };

/** Given the issue's available transitions and the desired {status, resolution?}, choose the
 *  transition to POST. `none` = no transition reaches the target status; `unsatisfiable` = matched
 *  but a required screen field we cannot supply (we can only supply `resolution`, and only when
 *  configured). `setResolution` = send resolution (configured AND the screen offers the field). */
export function pickTransition(transitions: JiraTransition[], target: JiraStatusTarget): TransitionPick {
  const match = transitions.find((t) => t.to?.name?.toLowerCase() === target.status.toLowerCase());
  if (!match) return { kind: "none" };
  const fields = match.fields ?? {};
  const required = Object.entries(fields)
    .filter(([, f]) => f.required)
    .map(([k]) => k);
  const canSupply = new Set<string>();
  if (target.resolution) canSupply.add("resolution");
  if (required.some((k) => !canSupply.has(k))) return { kind: "unsatisfiable" };
  return { kind: "found", id: match.id, setResolution: !!target.resolution && "resolution" in fields };
}

/** Atomic JIRA label edit ops (no read-merge; never clobbers labels outside the delta). */
export function labelUpdateOps(change: {
  add: string[];
  remove: string[];
}): { update: { labels: ({ add: string } | { remove: string })[] } } {
  return {
    update: {
      labels: [...change.add.map((l) => ({ add: l })), ...change.remove.map((l) => ({ remove: l }))],
    },
  };
}

/** Visible dedup marker embedded in a comment (ADF has no hidden-comment node). Pure. */
export function projKeyMarker(idempotencyKey: string): string {
  return `[proj-key:${idempotencyKey}]`;
}

/** Minimal ADF comment doc: the body paragraph + a marker paragraph for dedup. */
export function adfComment(body: string, idempotencyKey: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: body }] },
      { type: "paragraph", content: [{ type: "text", text: projKeyMarker(idempotencyKey) }] },
    ],
  };
}

/** Probe serialized comment bodies (ADF JSON) for the idempotency marker. */
export function commentHasMarker(commentBodies: unknown[], idempotencyKey: string): boolean {
  const marker = projKeyMarker(idempotencyKey);
  return commentBodies.some((b) => JSON.stringify(b ?? "").includes(marker));
}

/** Map a non-2xx JIRA response to a typed Error carrying `.status`. Parses JIRA's
 *  `{errorMessages, errors}` body; 401 -> a clear expired/invalid-token message. */
export function mapJiraError(status: number, bodyText: string): Error & { status: number } {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})];
    if (parts.length) detail = parts.join("; ");
  } catch {
    /* non-JSON body; keep raw text */
  }
  const msg =
    status === 401
      ? `jira: 401 unauthorized — JIRA_API_TOKEN invalid or expired (regenerate it). ${detail}`
      : `jira: HTTP ${status} — ${detail}`;
  const e = new Error(msg.trim()) as Error & { status: number };
  e.status = status;
  return e;
}

// --- factory (jiraIssueTracker) added in Task 4 ---
```

(The `IngestedTicket` / `IssueTrackerPort` / `SetStateResult` type imports are used by the Task-4 factory; unused `import type` does not error under this repo's `tsc`. Verify in Step 6.)

- [ ] **Step 4: Add the `jira` block to `RuntimeConfigSchema`**

In `src/config/runtime-config.ts`, add after the `issueTracker` line (line 15):

```ts
  // M-jira-2: JIRA adapter policy (non-secret). Absent -> built-in defaults; creds via env.
  jira: z
    .object({
      // neutral IssueState -> target JIRA status (+ optional resolution)
      statusMap: z.record(z.object({ status: z.string(), resolution: z.string().optional() })).optional(),
      // issue-type names treated as Bug (default ["Bug"])
      bugTypeNames: z.array(z.string()).optional(),
    })
    .optional(),
```

- [ ] **Step 5: Add a config parse test**

In `test/config/runtime-config.test.ts` (add the `RuntimeConfigSchema` import if absent):

```ts
test("parses an optional jira block (statusMap + bugTypeNames)", () => {
  const cfg = RuntimeConfigSchema.parse({
    issueTracker: "jira",
    jira: { statusMap: { done: { status: "Done", resolution: "Fixed" } }, bugTypeNames: ["Bug", "Defect"] },
  });
  expect(cfg.jira?.statusMap?.done).toEqual({ status: "Done", resolution: "Fixed" });
  expect(cfg.jira?.bugTypeNames).toEqual(["Bug", "Defect"]);
});

test("jira block is optional (absent -> undefined)", () => {
  expect(RuntimeConfigSchema.parse({}).jira).toBeUndefined();
});
```

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `bun test test/integrations/jira-adapter.test.ts test/config/runtime-config.test.ts` → PASS.
Run: `bun run typecheck` → PASS. Run: `bun run lint` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/adapters/jira.ts test/integrations/jira-adapter.test.ts \
  src/config/runtime-config.ts test/config/runtime-config.test.ts
git commit -m "feat(jira): adapter pure helpers + jira config block

Type map, status-target resolve, transition pick (required-field aware), atomic
label ops, ADF comment + marker dedup, error mapping — all pure + unit-tested.
Optional jira block (statusMap/bugTypeNames) in RuntimeConfigSchema. (M-jira-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Task 4: The adapter factory + port methods + registration

**Files:**
- Modify: `src/integrations/adapters/jira.ts` (append the factory)
- Modify: `src/daemon/ports.ts`
- Test: `test/integrations/issue-tracker.test.ts` (add one registration/selection test)

**Interfaces:**
- Consumes (from Tasks 1/2/3): `SetStateResult`, `adfToMarkdown`, `resolveStatusTarget`, `jiraTypeLabel`, `pickTransition`, `labelUpdateOps`, `adfComment`, `commentHasMarker`, `mapJiraError`, and the config/transition types.
- Produces: `jiraIssueTracker(opts?: JiraAdapterConfig & { baseUrl?: string; email?: string; token?: string }): IssueTrackerPort`. Registered in `ports.ts` as `jira: () => jiraIssueTracker(runtimeConfig.jira)`.

**Testing note:** per the binding convention, the four methods and `request()` are NOT unit-tested (they hit `fetch`). This task's automated coverage is: (a) typecheck + build; (b) a selection test proving `"jira"` resolves through `makeProjectorPorts`; (c) the loop-level fake (unchanged). Runtime behavior is verified by the operator smoke test in the docstring.

- [ ] **Step 1: Append the factory to `src/integrations/adapters/jira.ts`**

Replace the `// --- factory (jiraIssueTracker) added in Task 4 ---` marker with:

```ts
/**
 * The JIRA adapter. Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN (or opts overrides); a missing
 * value is a setup/GOAL-INSTALL failure. Register as `{ jira: () => jiraIssueTracker(runtimeConfig.jira) }`.
 */
export function jiraIssueTracker(
  opts?: JiraAdapterConfig & { baseUrl?: string; email?: string; token?: string },
): IssueTrackerPort {
  const baseUrl = opts?.baseUrl ?? process.env.JIRA_BASE_URL;
  const email = opts?.email ?? process.env.JIRA_EMAIL;
  const token = opts?.token ?? process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new Error(
      "jiraIssueTracker: missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN — this is a setup/GOAL-INSTALL touchpoint.",
    );
  }
  const site = baseUrl.replace(/\/$/, "");
  const api = `${site}/rest/api/3`;
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  async function request(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && !retried) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") || 1, 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return request(method, path, body, true);
    }
    if (!res.ok) throw mapJiraError(res.status, await res.text());
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    async fetchTicket(ref: string): Promise<IngestedTicket> {
      const issue = (await request("GET", `/issue/${ref}?fields=summary,description,issuetype`)) as {
        id: string;
        key: string;
        fields: { summary: string; description: unknown; issuetype?: { name?: string } };
      };
      const md = adfToMarkdown(issue.fields.description);
      return {
        ident: issue.key,
        title: issue.fields.summary,
        description: md === "" ? null : md,
        typeLabel: jiraTypeLabel(issue.fields.issuetype?.name ?? "", opts?.bugTypeNames),
        externalId: issue.id,
        url: `${site}/browse/${issue.key}`,
      };
    },

    async setState(ref: string, state: IssueState): Promise<SetStateResult> {
      const target = resolveStatusTarget(state, opts);
      // Probe current status: already there → applied (idempotent, crash-safe — CL-3).
      const cur = (await request("GET", `/issue/${ref}?fields=status`)) as {
        fields?: { status?: { name?: string } };
      };
      if (cur.fields?.status?.name?.toLowerCase() === target.status.toLowerCase()) {
        return { applied: true };
      }

      const tr = (await request("GET", `/issue/${ref}/transitions?expand=transitions.fields`)) as {
        transitions?: JiraTransition[];
      };
      const pick = pickTransition(tr.transitions ?? [], target);
      if (pick.kind !== "found") {
        // Soft-fail: no reachable transition / unsatisfiable required field. Board left unchanged;
        // the projector records a structured projection_skipped telemetry note.
        return { applied: false, reason: `${pick.kind}: no usable transition to "${target.status}"` };
      }
      const payload: { transition: { id: string }; fields?: { resolution: { name: string } } } = {
        transition: { id: pick.id },
      };
      if (pick.setResolution && target.resolution) {
        payload.fields = { resolution: { name: target.resolution } };
      }
      try {
        await request("POST", `/issue/${ref}/transitions`, payload);
        return { applied: true };
      } catch (err) {
        const st = (err as { status?: number }).status;
        if (st === 400 || st === 422) {
          // Screen/field rejection = workflow mismatch → soft-fail (not a transport failure).
          return { applied: false, reason: `transition to "${target.status}" rejected (HTTP ${st})` };
        }
        throw err; // transport (5xx/401/network) → outbox retries
      }
    },

    async setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void> {
      if (change.add.length === 0 && change.remove.length === 0) return;
      await request("PUT", `/issue/${ref}`, labelUpdateOps(change));
    },

    async addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null> {
      // Probe existing comments for the marker (dedup); paginate to `total`.
      const bodies: unknown[] = [];
      let startAt = 0;
      for (;;) {
        const page = (await request(
          "GET",
          `/issue/${ref}/comment?startAt=${startAt}&maxResults=100`,
        )) as { comments?: { body: unknown }[]; total?: number };
        const batch = page.comments ?? [];
        for (const c of batch) bodies.push(c.body);
        startAt += batch.length;
        if (batch.length === 0 || startAt >= (page.total ?? 0)) break;
      }
      if (commentHasMarker(bodies, idempotencyKey)) return null;
      const created = (await request("POST", `/issue/${ref}/comment`, {
        body: adfComment(body, idempotencyKey),
      })) as { id?: string };
      return created.id ?? null;
    },
  };
}
```

- [ ] **Step 2: Register the adapter in `src/daemon/ports.ts`**

Add the import (top, alongside the linear import):
```ts
import { jiraIssueTracker } from "../integrations/adapters/jira.ts";
```
Widen the `runtimeConfig` param type (line 13) to thread the jira config:
```ts
// before
  runtimeConfig: { issueTracker: string; forge: string },
// after
  runtimeConfig: { issueTracker: string; forge: string; jira?: import("../integrations/adapters/jira.ts").JiraAdapterConfig },
```
Register `jira` in the default adapter map (line 21):
```ts
// before
  const itAdapters = deps?.issueTracker ?? { linear: () => linearIssueTracker() };
// after
  const itAdapters = deps?.issueTracker ?? {
    linear: () => linearIssueTracker(),
    jira: () => jiraIssueTracker(runtimeConfig.jira),
  };
```
(The callers `run.ts:129` / `park.ts:266` already pass the full `RuntimeConfig`, so `runtimeConfig.jira` is populated.)

- [ ] **Step 3: Add a selection/registration test**

In `test/integrations/issue-tracker.test.ts`, add (do NOT call any method — construction only):

```ts
test("makeProjectorPorts selects the jira adapter when configured", () => {
  const prev = { u: process.env.JIRA_BASE_URL, e: process.env.JIRA_EMAIL, t: process.env.JIRA_API_TOKEN };
  process.env.JIRA_BASE_URL = "https://x.atlassian.net";
  process.env.JIRA_EMAIL = "a@b.com";
  process.env.JIRA_API_TOKEN = "tok";
  try {
    const ports = makeProjectorPorts(
      { issueTracker: "jira", forge: "github" },
      { checksSystem: "none", targetRepo: "/tmp/x" },
    );
    expect(typeof ports.issueTracker.fetchTicket).toBe("function");
  } finally {
    process.env.JIRA_BASE_URL = prev.u;
    process.env.JIRA_EMAIL = prev.e;
    process.env.JIRA_API_TOKEN = prev.t;
  }
});
```
(Add `import { makeProjectorPorts } from "../../src/daemon/ports.ts";` if not already present; match the file's existing import/assertion style.)

- [ ] **Step 4: Typecheck, test, lint**

Run: `bun run typecheck` → PASS (the factory now uses the imported types).
Run: `bun test test/integrations/issue-tracker.test.ts` → PASS.
Run: `bun test` → PASS (full suite). Run: `bun run lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/adapters/jira.ts src/daemon/ports.ts test/integrations/issue-tracker.test.ts
git commit -m "feat(jira): adapter factory + port methods + registration

Hand-rolled fetch client (Basic auth, v3), fetchTicket, transition-based
setState (idempotent probe + resolution + soft-fail via {applied:false}),
atomic setLabels, paginated-dedup addComment. Registered as issueTracker:
'jira'. Vendor I/O paths covered by the fake + docstring smoke test. (M-jira-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Task 5: Cross-cutting — setup readiness + credential isolation

**Files:**
- Modify: `src/cli/setup.ts` (export + rewrite `credNote`)
- Test: `test/cli/setup-cred-note.test.ts` (new)
- Modify: `src/agent/agent-env.ts`
- Test: `test/agent/agent-env.test.ts` (add a case; create if absent)

**Interfaces:**
- Produces: `credNote` exported from `setup.ts` (was private) for testing; `AGENT_ENV_DENYLIST` now includes `JIRA_API_TOKEN`.

- [ ] **Step 1: Write the failing `credNote` test**

Create `test/cli/setup-cred-note.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { credNote } from "../../src/cli/setup.ts";

const KEYS = ["LINEAR_API_KEY", "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "GITHUB_TOKEN"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clear = () => { for (const k of KEYS) delete process.env[k]; };

test("no JIRA vars: reports missing LINEAR_API_KEY", () => {
  clear();
  const note = credNote({ checksSystem: "none" } as never);
  expect(note).toContain("LINEAR_API_KEY");
});

test("any JIRA var present: reports the missing JIRA trio, not LINEAR", () => {
  clear();
  process.env.JIRA_BASE_URL = "https://x.atlassian.net";
  const note = credNote({ checksSystem: "none" } as never);
  expect(note).toContain("JIRA_EMAIL");
  expect(note).toContain("JIRA_API_TOKEN");
  expect(note).not.toContain("LINEAR_API_KEY");
});

test("full JIRA trio present: no ticket-cred note", () => {
  clear();
  process.env.JIRA_BASE_URL = "https://x.atlassian.net";
  process.env.JIRA_EMAIL = "a@b.com";
  process.env.JIRA_API_TOKEN = "tok";
  expect(credNote({ checksSystem: "none" } as never)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/cli/setup-cred-note.test.ts`
Expected: FAIL — `credNote` is not exported (and not yet tracker-aware).

- [ ] **Step 3: Export + rewrite `credNote` in `src/cli/setup.ts`**

```ts
// before
function credNote(profile: Profile): string | null {
  const missing: string[] = [];
  if (profile.checksSystem === "github" && !process.env.GITHUB_TOKEN)
    missing.push("GITHUB_TOKEN (PR/push + checks)");
  if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY (ticket ingest + projection)");
  return missing.length > 0 ? `note — not set for \`styre run\`: ${missing.join(", ")}` : null;
}
// after
/** Non-fatal note about creds a later `styre run` will need. Tracker-aware: if any JIRA_* var is
 *  present we treat JIRA as the intended tracker and require the full trio; otherwise LINEAR_API_KEY. */
export function credNote(profile: Profile): string | null {
  const missing: string[] = [];
  if (profile.checksSystem === "github" && !process.env.GITHUB_TOKEN)
    missing.push("GITHUB_TOKEN (PR/push + checks)");
  const usingJira = !!(
    process.env.JIRA_BASE_URL ||
    process.env.JIRA_EMAIL ||
    process.env.JIRA_API_TOKEN
  );
  if (usingJira) {
    const jira: [string, string][] = [
      ["JIRA_BASE_URL", "site URL"],
      ["JIRA_EMAIL", "account email"],
      ["JIRA_API_TOKEN", "API token"],
    ];
    for (const [k, label] of jira)
      if (!process.env[k]) missing.push(`${k} (${label} — JIRA ticket ingest + projection)`);
  } else if (!process.env.LINEAR_API_KEY) {
    missing.push("LINEAR_API_KEY (ticket ingest + projection)");
  }
  return missing.length > 0 ? `note — not set for \`styre run\`: ${missing.join(", ")}` : null;
}
```

- [ ] **Step 4: Run the credNote test to verify it passes**

Run: `bun test test/cli/setup-cred-note.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Add `JIRA_API_TOKEN` to the agent denylist + test**

In `src/agent/agent-env.ts:8`:
```ts
// before
export const AGENT_ENV_DENYLIST = ["LINEAR_API_KEY", "GITHUB_TOKEN"];
// after
export const AGENT_ENV_DENYLIST = ["LINEAR_API_KEY", "GITHUB_TOKEN", "JIRA_API_TOKEN"];
```
(`VERIFY_ENV_DENYLIST` derives from it, so verify-time scrubbing is covered by this one edit. Only the token is secret; `JIRA_EMAIL`/`JIRA_BASE_URL` are non-secret identifiers.)

Add a test (create `test/agent/agent-env.test.ts` if it does not exist; otherwise add the case):
```ts
import { expect, test } from "bun:test";
import { agentEnv, verifyEnv } from "../../src/agent/agent-env.ts";

test("agentEnv and verifyEnv scrub JIRA_API_TOKEN", () => {
  const parent = { JIRA_API_TOKEN: "secret", JIRA_EMAIL: "a@b.com", PATH: "/bin" };
  expect(agentEnv(parent).JIRA_API_TOKEN).toBeUndefined();
  expect(verifyEnv(parent).JIRA_API_TOKEN).toBeUndefined();
  expect(agentEnv(parent).JIRA_EMAIL).toBe("a@b.com"); // non-secret identifier passes through
  expect(agentEnv(parent).PATH).toBe("/bin");
});
```

- [ ] **Step 6: Full verification**

Run: `bun test` → PASS (whole suite). Run: `bun run typecheck` → PASS. Run: `bun run lint` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/setup.ts test/cli/setup-cred-note.test.ts src/agent/agent-env.ts test/agent/agent-env.test.ts
git commit -m "feat(jira): tracker-aware setup readiness + scrub JIRA_API_TOKEN

credNote reports the JIRA trio when any JIRA_* var is present, else LINEAR_API_KEY.
JIRA_API_TOKEN added to AGENT_ENV_DENYLIST (verify derives from it) so it never
leaks into the agent spawn. (M-jira-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Self-Review

**Spec coverage** (against `docs/brainstorms/2026-07-11-jira-issue-tracker-adapter-design.md`):
- Placement `jira.ts` + register in `ports.ts` → Task 4. ✓
- Auth (3 env vars, Basic, v3, 401→expired, Retry-After, Content-Type) → Task 3 (`mapJiraError`) + Task 4 (`request`). ✓
- `fetchTicket` (key→ident, ADF→md, type map, externalId, url) → Task 2 (renderer) + Task 3 (`jiraTypeLabel`) + Task 4. ✓
- `setState` full model (idempotent probe, transitions-with-fields, resolution, soft-fail, **observable structured signal**) → Task 1 (disposition + projector telemetry note) + Task 3 (`pickTransition`/`resolveStatusTarget`) + Task 4 (method returns `{applied,reason}`). The observability decision is RESOLVED: a structured `projection_skipped` `event_log` note on the NDJSON feed, not a console.warn. ✓
- `setLabels` atomic `update.labels` → Task 3 (`labelUpdateOps`) + Task 4. ✓
- `addComment` minimal ADF + marker + paginated dedup → Task 3 + Task 4. ✓
- Config `jira` block → Task 3. ✓
- Tracker-aware `setup.ts` + `JIRA_API_TOKEN` denylist → Task 5. ✓
- Testing = pure helpers unit-tested; vendor I/O via fake + smoke docstring → per-task tests + Task 4 note. ✓
- No schema change (uses existing `event_log` kind `"note"`). ✓

**Placeholder scan:** every code step shows complete code; every command has an expected result. No TBD/TODO.

**Type consistency:** `SetStateResult` (Task 1) is consumed by Linear/fake (Task 1) and the JIRA factory (Task 4) with identical shape; `JiraAdapterConfig`/`JiraStatusTarget`/`JiraTransition`/`TransitionPick` defined in Task 3 and used in Task 4; the projector's `set_state` case (Task 1) reads `res.applied`/`res.reason` exactly as returned. `runtimeConfig.jira` type in `ports.ts` (Task 4) matches the zod-inferred shape from Task 3.

**Ordering:** Task 1 (port disposition) precedes Task 4 (JIRA `setState` returning it) and Task 3 references it only as a type — correct. Task 2 (renderer) precedes Task 4 (`fetchTicket` uses it). Each task ends green and is independently reviewable.
