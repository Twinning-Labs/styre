# Slack Notifications (Piece A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OSS-core outbound notifier (Slack = first adapter) that posts to Slack on escalations, terminals (pr-ready / gave-up), park, and — at higher verbosity — stage transitions.

**Architecture:** A vendor-neutral `NotifierPort` (mirrors `selectIssueTracker`) delivered as a third `projection_outbox` target (`notify`). Rows are enqueued by a **driver-level sweep** inside `driveToTerminal` that mirrors the telemetry emitter (per-tick event sweep + a drive-end terminal enqueue), then drained by the projector — with a new **post-loop `drainOutbox`** so the terminal rows actually send. Notify failures never escalate; idempotency is keyed on the event `seq`.

**Tech Stack:** TypeScript, `bun test`, `bun:sqlite`, zod. Slack Web API `chat.postMessage` over `fetch`.

## Global Constraints

- **Design doc (authoritative):** `docs/brainstorms/2026-07-11-slack-notifications-design.md` (v2). This plan implements Piece A only.
- **Scope = outbound only.** No two-way / Slack buttons / `styre resolve` (Piece C, deferred). No durable-SoT change (Piece B, deferred).
- **Invariant — notify is lossy-tolerable, never control-relevant:** a failed notification must **never** escalate a ticket or alter control flow.
- **Secret in env, policy in config:** the bot token is read from `SLACK_BOT_TOKEN` (env); `notifier`/`notify`/`slack.channel` live in `config.json`. Never put the token in config.
- **Fail-loud is an eager startup check** in `run.ts`, not a lazy adapter read.
- **Dual schema files:** any `schema.sql` edit must be made in **both** `src/db/schema.sql` (authoritative) and `docs/architecture/schema.sql` (mirror).
- **Test runner:** `bun test`. Real DB in tests via `makeTestDb()` from `test/helpers/db.ts`. Fakes live under `src/integrations/adapters/`.
- **Commits:** conventional, one per task. Branch is `feat/slack-notifications` (already checked out).

## File Structure

**New files:**
- `src/integrations/notifier.ts` — `NotifierPort`, `NotificationMessage`, `NotifySeverity`, `NotifierFactory`, `selectNotifier`, `assertSlackConfigured`.
- `src/integrations/adapters/slack.ts` — `slackNotifier(...)` (the `fetch`-based adapter).
- `src/integrations/adapters/fake-notifier.ts` — `fakeNotifier(...)` (recording fake for tests).
- `src/daemon/notify.ts` — `createNotifier(config)` → `{ sweepNew, notifyTerminal }` (policy filter + neutral-message build + outbox enqueue).
- Tests mirroring each under `test/…`.

**Modified files:**
- `src/config/runtime-config.ts` — `notifier` / `notify` / `slack` fields.
- `src/db/schema.sql` **and** `docs/architecture/schema.sql` — add `'notify'` to the `projection_outbox` target CHECK (leave `projection_state` untouched).
- `src/db/repos/projection-outbox.ts` — `OutboxTarget` union += `"notify"`.
- `src/daemon/projector.ts` — `ProjectorPorts.notifier?`; `applyRow` `case "notify"`; `drainOutbox` non-escalate guard.
- `src/daemon/ports.ts` — construct the notifier in `makeProjectorPorts`.
- `src/daemon/run-ticket.ts` — thread `createNotifier`; per-tick `sweepNew`; `finish()` → terminal notify + `await drainOutbox`.
- `src/cli/run.ts` — `assertSlackConfigured` + startup log line.

**Message shape (v1, intentionally minimal — noted in the design):** `{ ticketIdent, event, severity, reason? }`. `ticketTitle` and `links` from design §1 are deferred enrichments (rendering ident + event + reason is fully sufficient for v1); calling this out explicitly rather than silently dropping it.

---

### Task 1: Config schema fields

**Files:**
- Modify: `src/config/runtime-config.ts:4-11`
- Test: `test/config/runtime-config-notify.test.ts`

**Interfaces:**
- Produces: `RuntimeConfig` gains `notifier: "none" | "slack"` (default `"none"`), `notify: "escalations" | "transitions" | "everything"` (default `"escalations"`), `slack?: { channel: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/config/runtime-config-notify.test.ts
import { expect, test } from "bun:test";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("notify fields default to off/escalations and parse a slack block", () => {
  const def = RuntimeConfigSchema.parse({});
  expect(def.notifier).toBe("none");
  expect(def.notify).toBe("escalations");
  expect(def.slack).toBeUndefined();

  const cfg = RuntimeConfigSchema.parse({
    notifier: "slack",
    notify: "transitions",
    slack: { channel: "#styre" },
  });
  expect(cfg.notifier).toBe("slack");
  expect(cfg.notify).toBe("transitions");
  expect(cfg.slack?.channel).toBe("#styre");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config/runtime-config-notify.test.ts`
Expected: FAIL — `def.notifier` is `undefined` (field not yet on the schema).

- [ ] **Step 3: Add the fields**

In `src/config/runtime-config.ts`, add three fields to the `RuntimeConfigSchema` `z.object({...})` (after `telemetry`, before `agent`):

```ts
  telemetry: z.boolean().default(true),
  notifier: z.enum(["none", "slack"]).default("none"),
  notify: z.enum(["escalations", "transitions", "everything"]).default("escalations"),
  slack: z.object({ channel: z.string() }).optional(),
  agent: AgentConfigSchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config/runtime-config-notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/runtime-config.ts test/config/runtime-config-notify.test.ts
git commit -m "feat(notify): add notifier/notify/slack runtime-config fields"
```

---

### Task 2: Notifier port, selector, fail-loud validation, and fake

**Files:**
- Create: `src/integrations/notifier.ts`
- Create: `src/integrations/adapters/fake-notifier.ts`
- Test: `test/integrations/notifier.test.ts`

**Interfaces:**
- Produces:
  - `type NotifySeverity = "high" | "success" | "info"`
  - `interface NotificationMessage { ticketIdent: string; event: string; severity: NotifySeverity; reason?: string }`
  - `interface NotifierPort { notify(msg: NotificationMessage): Promise<{ ref: string }> }`
  - `type NotifierFactory = () => NotifierPort`
  - `selectNotifier(config: { notifier: string }, adapters: Record<string, NotifierFactory>): NotifierPort | undefined`
  - `assertSlackConfigured(config: { notifier: string; slack?: { channel: string } }, env?: { SLACK_BOT_TOKEN?: string }): void`
  - `fakeNotifier(opts?: { fail?: boolean }): NotifierPort & { calls: NotificationMessage[] }`

- [ ] **Step 1: Write the failing test**

```ts
// test/integrations/notifier.test.ts
import { expect, test } from "bun:test";
import { assertSlackConfigured, selectNotifier } from "../../src/integrations/notifier.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";

test("selectNotifier: 'none' → undefined, 'slack' → adapter, unknown → throw", () => {
  expect(selectNotifier({ notifier: "none" }, {})).toBeUndefined();
  const fake = fakeNotifier();
  expect(selectNotifier({ notifier: "slack" }, { slack: () => fake })).toBe(fake);
  expect(() => selectNotifier({ notifier: "discord" }, { slack: () => fake })).toThrow();
});

test("assertSlackConfigured: passes when off; throws on missing token or channel", () => {
  expect(() => assertSlackConfigured({ notifier: "none" }, {})).not.toThrow();
  expect(() =>
    assertSlackConfigured({ notifier: "slack", slack: { channel: "#x" } }, {}),
  ).toThrow(/SLACK_BOT_TOKEN/);
  expect(() =>
    assertSlackConfigured({ notifier: "slack" }, { SLACK_BOT_TOKEN: "xoxb-1" }),
  ).toThrow(/slack.channel/);
  expect(() =>
    assertSlackConfigured({ notifier: "slack", slack: { channel: "#x" } }, { SLACK_BOT_TOKEN: "xoxb-1" }),
  ).not.toThrow();
});

test("fakeNotifier records calls and can force failure", async () => {
  const ok = fakeNotifier();
  const r = await ok.notify({ ticketIdent: "ENG-1", event: "escalated", severity: "high" });
  expect(r.ref).toContain("fake-ts");
  expect(ok.calls[0]?.ticketIdent).toBe("ENG-1");
  const bad = fakeNotifier({ fail: true });
  await expect(bad.notify({ ticketIdent: "ENG-2", event: "x", severity: "info" })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integrations/notifier.test.ts`
Expected: FAIL — module `notifier.ts` not found.

- [ ] **Step 3: Create `src/integrations/notifier.ts`**

```ts
/** Vendor-neutral notifier port (zero lock-in). The core builds a neutral NotificationMessage;
 *  Slack/Discord/etc. are config-selected adapters behind this interface. Mirrors selectIssueTracker
 *  (src/integrations/issue-tracker.ts). Outbound-only: a notification is a one-way projection and
 *  must never be read for control flow. */

export type NotifySeverity = "high" | "success" | "info";

export interface NotificationMessage {
  ticketIdent: string; // "ENG-1"
  event: string; // "escalated" | "implement→verify" | "PR ready to merge" | ...
  severity: NotifySeverity;
  reason?: string;
}

export interface NotifierPort {
  /** Deliver one rendered notification. Returns a provider ref (e.g. Slack ts). Throws on
   *  transport failure — the projector's drain decides retry (and never escalates a notify row). */
  notify(msg: NotificationMessage): Promise<{ ref: string }>;
}

export type NotifierFactory = () => NotifierPort;

export function selectNotifier(
  config: { notifier: string },
  adapters: Record<string, NotifierFactory>,
): NotifierPort | undefined {
  if (config.notifier === "none") return undefined;
  const factory = adapters[config.notifier];
  if (!factory) {
    throw new Error(`selectNotifier: no adapter registered for '${config.notifier}'`);
  }
  return factory();
}

/** Fail-loud config validation (design §4). MUST run eagerly at startup, not lazily inside the
 *  adapter — a lazy read would surface as a swallowed transport error (no escalate) = silent drop. */
export function assertSlackConfigured(
  config: { notifier: string; slack?: { channel: string } },
  env: { SLACK_BOT_TOKEN?: string } = process.env as { SLACK_BOT_TOKEN?: string },
): void {
  if (config.notifier !== "slack") return;
  if (!env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN.length === 0) {
    throw new Error(
      "notifier 'slack' is set but SLACK_BOT_TOKEN is missing from the environment",
    );
  }
  if (!config.slack || config.slack.channel.length === 0) {
    throw new Error("notifier 'slack' is set but slack.channel is missing from config.json");
  }
}
```

- [ ] **Step 4: Create `src/integrations/adapters/fake-notifier.ts`**

```ts
import type { NotificationMessage, NotifierPort } from "../notifier.ts";

/** Recording fake notifier for tests. Mirrors fakeIssueTracker. `fail:true` forces notify() to throw. */
export function fakeNotifier(
  opts?: { fail?: boolean },
): NotifierPort & { calls: NotificationMessage[] } {
  const calls: NotificationMessage[] = [];
  return {
    calls,
    async notify(msg) {
      calls.push(msg);
      if (opts?.fail) throw new Error("fake notifier: forced failure");
      return { ref: `fake-ts-${calls.length}` };
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/integrations/notifier.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add src/integrations/notifier.ts src/integrations/adapters/fake-notifier.ts test/integrations/notifier.test.ts
git commit -m "feat(notify): notifier port, selectNotifier, assertSlackConfigured, fake"
```

---

### Task 3: Slack adapter

**Files:**
- Create: `src/integrations/adapters/slack.ts`
- Test: `test/integrations/slack.test.ts`

**Interfaces:**
- Consumes: `NotifierPort`, `NotificationMessage` (Task 2).
- Produces: `slackNotifier(opts: { token: string; channel: string; fetch?: FetchLike }): NotifierPort` where `type FetchLike = (url: string, init: RequestInit) => Promise<Response>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/integrations/slack.test.ts
import { expect, test } from "bun:test";
import { slackNotifier } from "../../src/integrations/adapters/slack.ts";

test("slackNotifier posts chat.postMessage with token+channel and returns the ts", async () => {
  const seen: { url: string; init: RequestInit } = { url: "", init: {} };
  const fakeFetch = async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), { status: 200 });
  };
  const port = slackNotifier({ token: "xoxb-abc", channel: "#styre", fetch: fakeFetch });
  const r = await port.notify({ ticketIdent: "ENG-1", event: "escalated", severity: "high", reason: "step failed" });

  expect(r.ref).toBe("1700000000.000100");
  expect(seen.url).toBe("https://slack.com/api/chat.postMessage");
  expect((seen.init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-abc");
  const body = JSON.parse(seen.init.body as string) as { channel: string; text: string };
  expect(body.channel).toBe("#styre");
  expect(body.text).toContain("🔴");
  expect(body.text).toContain("ENG-1");
  expect(body.text).toContain("step failed");
});

test("slackNotifier throws when Slack returns ok:false", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
  const port = slackNotifier({ token: "t", channel: "#x", fetch: fakeFetch });
  await expect(port.notify({ ticketIdent: "ENG-1", event: "x", severity: "info" })).rejects.toThrow(
    /channel_not_found/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integrations/slack.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/integrations/adapters/slack.ts`**

```ts
import type { NotificationMessage, NotifierPort } from "../notifier.ts";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const EMOJI: Record<NotificationMessage["severity"], string> = {
  high: "🔴",
  success: "🟢",
  info: "▸",
};

/** Slack adapter: posts one message per notification via chat.postMessage. Token + channel are
 *  passed in (token originates from SLACK_BOT_TOKEN in env, resolved in makeProjectorPorts).
 *  `fetch` is injectable for tests. v1 renders mrkdwn text; Block Kit is a later enrichment. */
export function slackNotifier(opts: { token: string; channel: string; fetch?: FetchLike }): NotifierPort {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  return {
    async notify(msg) {
      const text = `${EMOJI[msg.severity]} *${msg.ticketIdent}* ${msg.event}${
        msg.reason ? `: ${msg.reason}` : ""
      }`;
      const res = await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ channel: opts.channel, text }),
      });
      const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
      if (!data.ok) {
        throw new Error(`slack chat.postMessage failed: ${data.error ?? "unknown error"}`);
      }
      return { ref: data.ts ?? "" };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/integrations/slack.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/adapters/slack.ts test/integrations/slack.test.ts
git commit -m "feat(notify): Slack chat.postMessage adapter"
```

---

### Task 4: Outbox `notify` target — schema, union, projector dispatch, non-escalate guard

**Files:**
- Modify: `src/db/schema.sql:475` **and** `docs/architecture/schema.sql` (same line)
- Modify: `src/db/repos/projection-outbox.ts:4`
- Modify: `src/daemon/projector.ts` (`ProjectorPorts` ~`:82-86`, `applyRow` ~`:148`, `drainOutbox` ~`:183`)
- Test: `test/daemon/notify-outbox.test.ts`

**Interfaces:**
- Consumes: `NotifierPort` (Task 2), `fakeNotifier` (Task 2), `enqueue`/`listPending` (existing).
- Produces: `OutboxTarget` includes `"notify"`; `ProjectorPorts` gains `notifier?: NotifierPort`; `drainOutbox` delivers `notify` rows and never escalates them.

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/notify-outbox.test.ts
import { expect, test } from "bun:test";
import { drainOutbox } from "../../src/daemon/projector.ts";
import { enqueue, listPending } from "../../src/db/repos/projection-outbox.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";
import { listByTicket } from "../../src/db/repos/event-log.ts";
import { makeTestDb } from "../helpers/db.ts";

test("drainOutbox delivers a notify row via the notifier port and marks it sent", async () => {
  const { db, ticketId } = makeTestDb();
  const msg = { ticketIdent: "ENG-1", event: "escalated", severity: "high", reason: "step failed" };
  enqueue(db, { ticketId, target: "notify", op: "post", payload: msg, idempotencyKey: "notify:1:evt:1" });
  const fake = fakeNotifier();
  const out = await drainOutbox(db, { issueTracker: fakeIssueTracker(), notifier: fake });
  db.close();
  expect(out.sent).toBe(1);
  expect(fake.calls[0]?.ticketIdent).toBe("ENG-1");
  expect(fake.calls[0]?.event).toBe("escalated");
});

test("a failing notify row is marked failed but NEVER escalates the ticket", async () => {
  const { db, ticketId } = makeTestDb();
  const msg = { ticketIdent: "ENG-1", event: "escalated", severity: "high" };
  enqueue(db, { ticketId, target: "notify", op: "post", payload: msg, idempotencyKey: "notify:1:evt:1" });
  const fake = fakeNotifier({ fail: true });
  // retryBudget:1 → the single failing attempt exhausts immediately.
  const out = await drainOutbox(db, { issueTracker: fakeIssueTracker(), notifier: fake }, { retryBudget: 1 });
  const escalations = listByTicket(db, ticketId).filter((e) => e.kind === "escalated");
  db.close();
  expect(out.failed).toBe(1);
  expect(escalations.length).toBe(0); // the asymmetry: notify failure does not escalate
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/notify-outbox.test.ts`
Expected: FAIL — `enqueue` rejects target `"notify"` (type error) / DB CHECK violation / `applyRow` throws "no adapter for target 'notify'".

- [ ] **Step 3: Add `'notify'` to both schema CHECKs (projection_outbox only)**

In **`src/db/schema.sql`** find the `projection_outbox` table's target line (has `op TEXT NOT NULL` immediately below it) and change:

```sql
    target          TEXT NOT NULL CHECK (target IN ('issue_tracker','forge')),
    op              TEXT NOT NULL,                       -- 'set_labels'/'add_comment'/'set_state'
```
to:
```sql
    target          TEXT NOT NULL CHECK (target IN ('issue_tracker','forge','notify')),
    op              TEXT NOT NULL,                       -- 'set_labels'/'add_comment'/'set_state'/'post'
```

Make the **identical** edit in `docs/architecture/schema.sql`. **Do NOT touch** the `projection_state` CHECK (the other, earlier occurrence) — notify rows never use that table.

- [ ] **Step 4: Widen the `OutboxTarget` union**

In `src/db/repos/projection-outbox.ts:4`:
```ts
export type OutboxTarget = "issue_tracker" | "forge" | "notify";
```

- [ ] **Step 5: Add the notifier port to `ProjectorPorts` and a `notify` branch to `applyRow`**

In `src/daemon/projector.ts`, add the import near the other integration imports:
```ts
import type { NotifierPort, NotificationMessage } from "../integrations/notifier.ts";
```
Extend `ProjectorPorts` (`:82-86`):
```ts
export interface ProjectorPorts {
  issueTracker: IssueTrackerPort;
  forge?: ForgePort;
  checks?: ChecksPort;
  notifier?: NotifierPort;
}
```
In `applyRow`, add this block immediately **before** the final `throw new Error(\`projector: no adapter for target '${row.target}'\`);`:
```ts
  if (row.target === "notify") {
    if (!ports.notifier) {
      throw new Error("projector: notify outbox row but no notifier port configured");
    }
    switch (row.op) {
      case "post": {
        const { ref } = await ports.notifier.notify(payload as unknown as NotificationMessage);
        return ref;
      }
      default:
        throw new Error(`projector: unknown notify op '${row.op}'`);
    }
  }
```

- [ ] **Step 6: Guard `drainOutbox` so notify failures do not escalate**

In `src/daemon/projector.ts` `drainOutbox`, change the budget-exhaustion branch:
```ts
      if (row.attempts + 1 >= budget) {
        markFailed(db, row.id, message);
        if (row.target !== "notify") {
          escalateProjection(db, row.ticket_id, `projection failing: ${message}`);
        }
        failed += 1;
      } else {
        bumpAttempt(db, row.id, message);
      }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test test/daemon/notify-outbox.test.ts`
Expected: PASS (both). Then `bun test test/daemon/projector.test.ts` to confirm no regression in the existing projector tests.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql docs/architecture/schema.sql src/db/repos/projection-outbox.ts src/daemon/projector.ts test/daemon/notify-outbox.test.ts
git commit -m "feat(notify): notify outbox target + projector dispatch + non-escalate guard"
```

---

### Task 5: Construct the notifier in `makeProjectorPorts`

**Files:**
- Modify: `src/daemon/ports.ts`
- Test: `test/daemon/ports-notifier.test.ts`

**Interfaces:**
- Consumes: `selectNotifier`, `NotifierFactory` (Task 2); `slackNotifier` (Task 3).
- Produces: `makeProjectorPorts(runtimeConfig, profile, deps?)` attaches `notifier` when `runtimeConfig.notifier === "slack"`; `deps.notifier` overrides the registry for tests.

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/ports-notifier.test.ts
import { expect, test } from "bun:test";
import { makeProjectorPorts } from "../../src/daemon/ports.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";

const profile = { checksSystem: "none", targetRepo: "/tmp/repo" };

test("makeProjectorPorts attaches the selected notifier; 'none' → undefined", () => {
  const fake = fakeNotifier();
  const withSlack = makeProjectorPorts(
    { issueTracker: "linear", forge: "github", notifier: "slack", slack: { channel: "#x" } },
    profile,
    { notifier: { slack: () => fake } },
  );
  expect(withSlack.notifier).toBe(fake);

  const off = makeProjectorPorts({ issueTracker: "linear", forge: "github", notifier: "none" }, profile);
  expect(off.notifier).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/ports-notifier.test.ts`
Expected: FAIL — `withSlack.notifier` is `undefined` (ports doesn't build it yet).

- [ ] **Step 3: Wire the notifier into `makeProjectorPorts`**

In `src/daemon/ports.ts`, add imports:
```ts
import { slackNotifier } from "../integrations/adapters/slack.ts";
import { type NotifierFactory, selectNotifier } from "../integrations/notifier.ts";
```
Widen the `runtimeConfig` param type and the `deps` type:
```ts
export function makeProjectorPorts(
  runtimeConfig: {
    issueTracker: string;
    forge: string;
    notifier?: string;
    slack?: { channel: string };
  },
  profile: { checksSystem: string; targetRepo: string },
  deps?: {
    issueTracker?: Record<string, IssueTrackerFactory>;
    forge?: Record<string, ForgeFactory>;
    checks?: Record<string, ChecksFactory>;
    notifier?: Record<string, NotifierFactory>;
  },
): ProjectorPorts {
```
Add the adapter registry default (beside `checksAdapters`):
```ts
  const notifierAdapters = deps?.notifier ?? {
    slack: () =>
      slackNotifier({
        token: process.env.SLACK_BOT_TOKEN ?? "",
        channel: runtimeConfig.slack?.channel ?? "",
      }),
  };
```
Add the `notifier` line to the returned object:
```ts
  return {
    issueTracker: selectIssueTracker(runtimeConfig, itAdapters),
    forge: selectForge(runtimeConfig, forgeAdapters),
    checks: selectChecks(profile.checksSystem, checksAdapters) ?? undefined,
    notifier: selectNotifier({ notifier: runtimeConfig.notifier ?? "none" }, notifierAdapters),
  };
```
(Token/channel default to `""` here; `assertSlackConfigured` in Task 8 guarantees they are present before this runs when `notifier === "slack"`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/daemon/ports-notifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/ports.ts test/daemon/ports-notifier.test.ts
git commit -m "feat(notify): construct notifier in makeProjectorPorts"
```

---

### Task 6: The sweep — `createNotifier` (policy filter + message build + enqueue)

**Files:**
- Create: `src/daemon/notify.ts`
- Test: `test/daemon/notify-sweep.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig` (Task 1); `listByTicketSince`, `appendEvent` (existing event-log); `enqueue`, `listPending` (outbox); `getTicket` (existing ticket repo); `NotificationMessage`, `NotifySeverity` (Task 2).
- Produces: `createNotifier(config: RuntimeConfig): { sweepNew(db, ticketId): void; notifyTerminal(db, ticketId, outcome: string): void }`. Both enqueue `notify` outbox rows keyed `notify:<tid>:evt:<seq>` / `notify:<tid>:term:<outcome>`. No-ops when `config.notifier === "none"`.

**Policy + severity mapping (the decision table this task encodes):**
- Events: `escalated`→high (all levels); `parked`→high (all levels); `transition`→info (`transitions`+); `loopback`→info (`everything`); `resumed`/`note`→never.
- Terminals: `pr-ready`→success; `done`→success; `no-progress`→high. `parked` terminal → skip (already emitted a `parked` event, swept). `blocked` terminal → skip (escalation-blocked already emitted an `escalated` event; the rare dead-end blocked is exit-code-only for v1 — explicitly deferred to avoid double-notifying the common escalation case).

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/notify-sweep.test.ts
import { expect, test } from "bun:test";
import { createNotifier } from "../../src/daemon/notify.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/projection-outbox.ts";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";
import { makeTestDb } from "../helpers/db.ts";

function cfg(notify: "escalations" | "transitions" | "everything") {
  return RuntimeConfigSchema.parse({ notifier: "slack", notify, slack: { channel: "#x" } });
}
const payloads = (db: ReturnType<typeof makeTestDb>["db"]) =>
  listPending(db)
    .filter((r) => r.target === "notify")
    .map((r) => JSON.parse(r.payload_json as string) as { event: string; severity: string });

test("sweepNew enqueues escalated+parked at 'escalations', adds transition/loopback by tier", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, { ticketId, kind: "escalated", reason: "step failed" });
  appendEvent(db, { ticketId, kind: "transition", fromStage: "implement", toStage: "verify" });
  appendEvent(db, { ticketId, kind: "loopback" });

  createNotifier(cfg("escalations")).sweepNew(db, ticketId);
  let evs = payloads(db).map((p) => p.event);
  expect(evs).toEqual(["escalated"]); // transition + loopback filtered out

  // higher tier re-sweeps from scratch on a fresh notifier instance:
  const { db: db2, ticketId: t2 } = makeTestDb();
  appendEvent(db2, { ticketId: t2, kind: "escalated", reason: "x" });
  appendEvent(db2, { ticketId: t2, kind: "transition", fromStage: "implement", toStage: "verify" });
  appendEvent(db2, { ticketId: t2, kind: "loopback" });
  createNotifier(cfg("everything")).sweepNew(db2, t2);
  evs = payloads(db2).map((p) => p.event);
  expect(evs).toEqual(["escalated", "implement→verify", "loopback"]);
  db.close();
  db2.close();
});

test("notifyTerminal enqueues pr-ready(success) and no-progress(high); skips blocked/parked", () => {
  const { db, ticketId } = makeTestDb();
  const n = createNotifier(cfg("escalations"));
  n.notifyTerminal(db, ticketId, "pr-ready");
  n.notifyTerminal(db, ticketId, "no-progress");
  n.notifyTerminal(db, ticketId, "blocked");
  n.notifyTerminal(db, ticketId, "parked");
  const got = payloads(db);
  db.close();
  expect(got).toEqual([
    { event: "PR ready to merge", severity: "success" },
    { event: "gave up (no progress)", severity: "high" },
  ]);
});

test("disabled notifier enqueues nothing", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, { ticketId, kind: "escalated", reason: "x" });
  const off = RuntimeConfigSchema.parse({});
  createNotifier(off).sweepNew(db, ticketId);
  createNotifier(off).notifyTerminal(db, ticketId, "pr-ready");
  const got = payloads(db);
  db.close();
  expect(got.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: FAIL — module `notify.ts` not found.

- [ ] **Step 3: Create `src/daemon/notify.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { type EventLogRow, listByTicketSince } from "../db/repos/event-log.ts";
import { enqueue } from "../db/repos/projection-outbox.ts";
import { getTicket } from "../db/repos/ticket.ts";
import type { NotificationMessage, NotifySeverity } from "../integrations/notifier.ts";

type Policy = RuntimeConfig["notify"];
const RANK: Record<Policy, number> = { escalations: 0, transitions: 1, everything: 2 };

/** Map an event_log kind → (severity, label) under the policy, or null if it shouldn't notify. */
function eventDecision(
  e: EventLogRow,
  policy: Policy,
): { severity: NotifySeverity; label: string } | null {
  switch (e.kind) {
    case "escalated":
      return { severity: "high", label: "escalated" };
    case "parked":
      return { severity: "high", label: "parked" };
    case "transition":
      return RANK[policy] >= 1
        ? { severity: "info", label: `${e.from_stage ?? "?"}→${e.to_stage ?? "?"}` }
        : null;
    case "loopback":
      return RANK[policy] >= 2 ? { severity: "info", label: "loopback" } : null;
    default:
      return null; // resumed, note
  }
}

/** Map a terminal outcome → (severity, event) or null. `blocked`/`parked` are intentionally null:
 *  their notification already went out as a swept event (`escalated`/`parked`); the rare dead-end
 *  `blocked` is exit-code-only for v1 (deferred, to avoid double-notifying escalation-blocked). */
function terminalDecision(outcome: string): { severity: NotifySeverity; event: string } | null {
  switch (outcome) {
    case "pr-ready":
      return { severity: "success", event: "PR ready to merge" };
    case "done":
      return { severity: "success", event: "released" };
    case "no-progress":
      return { severity: "high", event: "gave up (no progress)" };
    default:
      return null; // blocked, parked
  }
}

/** Sibling of the telemetry emitter (src/telemetry/emitter.ts): a per-tick event sweep with a
 *  monotonic watermark + a drive-end terminal enqueue. Both ENQUEUE notify outbox rows (the projector
 *  drain delivers them). Idempotency keyed on event `seq` / terminal outcome. No-op when disabled. */
export function createNotifier(config: RuntimeConfig): {
  sweepNew(db: Database, ticketId: number): void;
  notifyTerminal(db: Database, ticketId: number, outcome: string): void;
} {
  let lastEventSeq = 0;
  const enabled = config.notifier !== "none";

  const identOf = (db: Database, ticketId: number): string =>
    getTicket(db, ticketId)?.ident ?? String(ticketId);

  const post = (db: Database, ticketId: number, key: string, msg: NotificationMessage): void => {
    enqueue(db, { ticketId, target: "notify", op: "post", payload: msg, idempotencyKey: key });
  };

  return {
    sweepNew(db, ticketId) {
      if (!enabled) return;
      for (const e of listByTicketSince(db, ticketId, lastEventSeq)) {
        lastEventSeq = e.seq;
        const d = eventDecision(e, config.notify);
        if (!d) continue;
        post(db, ticketId, `notify:${ticketId}:evt:${e.seq}`, {
          ticketIdent: identOf(db, ticketId),
          event: d.label,
          severity: d.severity,
          reason: e.reason ?? undefined,
        });
      }
    },
    notifyTerminal(db, ticketId, outcome) {
      if (!enabled) return;
      const d = terminalDecision(outcome);
      if (!d) return;
      post(db, ticketId, `notify:${ticketId}:term:${outcome}`, {
        ticketIdent: identOf(db, ticketId),
        event: d.event,
        severity: d.severity,
      });
    },
  };
}
```

- [ ] **Step 4: Verify `getTicket` import**

Run: `grep -n "export function getTicket" src/db/repos/ticket.ts`
Expected: a `getTicket(db, id)` returning a row with an `ident` field. If the name/path differs, adjust the import in `notify.ts` (it is the same `getTicket` used in `src/daemon/projector.ts`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/notify.ts test/daemon/notify-sweep.test.ts
git commit -m "feat(notify): driver-level sweep (policy filter + terminal) enqueuing notify rows"
```

---

### Task 7: Wire the sweep into `driveToTerminal` + post-loop drain

**Files:**
- Modify: `src/daemon/run-ticket.ts` (`driveToTerminal` `:31-82`)
- Test: `test/daemon/run-ticket-notify.test.ts`

**Interfaces:**
- Consumes: `createNotifier` (Task 6); `drainOutbox` (existing); `fakeNotifier`, `fakeIssueTracker`.
- Produces: `driveToTerminal` enqueues per-tick event notifications and, on every terminal, a terminal notification, then drains the outbox so they are actually delivered.

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/run-ticket-notify.test.ts
import { expect, test } from "bun:test";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a drive that idles to no-progress delivers the terminal 'gave up' notification (post-loop drain)", async () => {
  const { db, ticketId } = makeTestDb();
  const notifier = fakeNotifier();
  const config = RuntimeConfigSchema.parse({ notifier: "slack", notify: "escalations", slack: { channel: "#x" } });

  // An empty registry never advances → driveToTerminal idles to "no-progress" in a few ticks.
  const result = await driveToTerminal(db, {} as never, {
    ticketId,
    config,
    ports: { issueTracker: fakeIssueTracker(), notifier },
    profile: { checksSystem: "none" },
  });
  db.close();

  expect(result.outcome).toBe("no-progress");
  // The centerpiece guard: the terminal notify was DELIVERED, not left pending.
  expect(notifier.calls.some((c) => c.event === "gave up (no progress)" && c.severity === "high")).toBe(true);
});
```

> If an empty registry throws instead of idling, seed the ticket into a state whose first step is
> unregistered so `advanceOneStep` reports `advanced: 0`; the assertion (terminal notification
> delivered) stays fixed. This test's job is to prove the `finish()` terminal-enqueue + post-loop
> drain actually send — the per-event mapping is already covered by Task 6.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/run-ticket-notify.test.ts`
Expected: FAIL — `notifier.calls` is empty (no sweep/terminal wiring yet; the notify row, if any, is never drained).

- [ ] **Step 3: Thread `createNotifier` and add the terminal enqueue + post-loop drain**

In `src/daemon/run-ticket.ts`, add imports:
```ts
import { createNotifier } from "./notify.ts";
import { drainOutbox } from "./projector.ts";
```
Inside `driveToTerminal`, right after the emitter is created:
```ts
  const emitter = createTelemetryEmitter(opts.emit ?? noopSink);
  const notifier = createNotifier(opts.config);
```
Change `finish` to `async` and add the notifier calls + the post-loop drain:
```ts
  const finish = async (result: RunResult): Promise<RunResult> => {
    emitter.flushNew(db, opts.ticketId);
    emitter.emitSummary(db, opts.ticketId, result);
    notifier.sweepNew(db, opts.ticketId); // catch the final tick's events
    notifier.notifyTerminal(db, opts.ticketId, result.outcome);
    await drainOutbox(db, opts.ports); // BLOCKER-1 fix: flush the terminal + tail notify rows
    return result;
  };
```
Add the per-tick sweep right after the existing per-tick `emitter.flushNew(...)` (`:58`):
```ts
    emitter.flushNew(db, opts.ticketId);
    notifier.sweepNew(db, opts.ticketId);
```
Change **every** `return finish({...})` to `return await finish({...})` (the 6 terminal sites at `:64,65,67,69,72,76` and the final `:81`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/daemon/run-ticket-notify.test.ts`
Expected: PASS (`result.outcome === "no-progress"` and the terminal notification was delivered).

- [ ] **Step 5: Run the run-ticket regression suite**

Run: `bun test test/daemon/`
Expected: PASS — existing run-ticket / projector tests unaffected (default `notifier:"none"` → sweeps are no-ops; the extra post-loop `drainOutbox` finds nothing pending → `{sent:0}`).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/run-ticket.ts test/daemon/run-ticket-notify.test.ts
git commit -m "feat(notify): sweep + terminal notify + post-loop drain in driveToTerminal"
```

---

### Task 8: Startup fail-loud + confirmation log in `run.ts`

**Files:**
- Modify: `src/cli/run.ts` (after config discovery `:86`)
- Test: covered by `assertSlackConfigured` unit tests (Task 2); wiring verified by typecheck + a smoke run.

**Interfaces:**
- Consumes: `assertSlackConfigured` (Task 2); `runtimeConfig` (existing `:86`).
- Produces: `styre run` throws before any work when `notifier:"slack"` is misconfigured, and logs a one-line confirmation to stderr when notifications are active.

- [ ] **Step 1: Add the eager validation + log line**

In `src/cli/run.ts`, add the import:
```ts
import { assertSlackConfigured } from "../integrations/notifier.ts";
```
Immediately after `const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug });` (`:86`):
```ts
    assertSlackConfigured(runtimeConfig);
    if (runtimeConfig.notifier !== "none") {
      // human-readable status → stderr (stdout carries only NDJSON telemetry)
      process.stderr.write(
        `notifier: ${runtimeConfig.notifier} → ${runtimeConfig.slack?.channel} (policy: ${runtimeConfig.notify})\n`,
      );
    }
```

- [ ] **Step 2: Typecheck + full suite**

Run: `bun run typecheck` (or the repo's typecheck script — check `package.json`), then `bun test`.
Expected: clean typecheck; full suite green.

- [ ] **Step 3: Smoke — fail-loud is eager**

Run (no token set):
```bash
SLACK_BOT_TOKEN= bun run src/index.ts run ENG-1 --config /dev/stdin <<'JSON' 2>&1 | head -3 || true
{ "notifier": "slack", "notify": "escalations", "slack": { "channel": "#styre" } }
JSON
```
Expected: it exits early with the message `notifier 'slack' is set but SLACK_BOT_TOKEN is missing from the environment` — before any ticket work. (If `--config /dev/stdin` isn't supported, write the JSON to a temp file and pass its path; the point is to observe the eager throw.)

- [ ] **Step 4: Commit**

```bash
git add src/cli/run.ts
git commit -m "feat(notify): eager fail-loud + startup confirmation line in run.ts"
```

---

## Final verification

- [ ] `bun test` — full suite green.
- [ ] `bun run typecheck` — clean.
- [ ] `bun run lint` (if present) — clean.
- [ ] Manual: with a real `SLACK_BOT_TOKEN` + `slack.channel`, run a ticket that escalates and confirm a 🔴 message lands; run one to pr-ready and confirm a 🟢 "PR ready to merge" lands. (This is the end-to-end proof the design exists for.)
- [ ] Update `docs/brainstorms/2026-07-11-slack-notifications-design.md` status → "implemented" and the `brainstorm.md` §10 Open Decisions Register / §11 changelog to record D3 reopened (Slack-outbound → OSS). Commit.

## Self-review notes (coverage against the spec)

- **§1 abstraction** → Tasks 2, 3, 5. **§2 delivery (outbox + sweep + post-loop drain + non-escalate + seq idempotency)** → Tasks 4, 6, 7. **§3 policy dial + silent terminals** → Task 6 (+7 for the terminal path). **§4 setup/fail-loud** → Tasks 1, 2, 8. **§8 deferrals** honored (no two-way, no durable SoT).
- **Known v1 narrowing (explicitly deferred, not silent):** message omits `ticketTitle`/`links`; dead-end `blocked` terminal is exit-code-only (avoids double-notifying escalation-blocked); Slack render is mrkdwn text, not Block Kit. Each is a trivial later enrichment.
