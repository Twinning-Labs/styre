# Slack Notifications Piece A — Polish/Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the remaining gaps in Piece A: message enrichment (title + PR link, Block Kit), the dead-end `blocked` notification, a `NotificationMessage` zod schema, robust Slack error handling, and a `styre notify --test` command.

**Architecture:** All changes sit behind the existing notifier abstraction. The neutral `NotificationMessage` gains optional `ticketTitle`/`prUrl` fields (validated by a new zod schema, populated in the driver-level sweep, rendered by the Slack adapter as Block Kit). No control-flow changes; notifications remain lossy-tolerable.

**Tech Stack:** TypeScript, `bun test`, `bun:sqlite`, zod, citty (CLI), Slack Web API `chat.postMessage`.

## Global Constraints

- **Design doc (authoritative):** `docs/brainstorms/2026-07-11-slack-notifications-design.md`; this batch's decisions: PR link only (issue URL not in SoT), single channel (NO per-severity), include `styre notify --test`.
- **Notifications are lossy-tolerable / never control-relevant.** No change may let a notification alter control flow or escalate a ticket.
- **`notify.ts` must not call adapters** — it only reads the SoT and enqueues. PR URL comes from the SoT (a delivered `external_pr_result` signal), not an adapter call.
- **Secret in env, policy in config.** `styre notify --test` reads the token from `SLACK_BOT_TOKEN` and must run `assertSlackConfigured` (fail-loud).
- **Backward compatible:** the new message fields are OPTIONAL; a `NotificationMessage` without them still validates and renders.
- **Test runner** `bun test`; **typecheck** `bun run typecheck` (`tsc --noEmit`); **lint** `bun run lint` (`biome check`) — run all three before each commit. Conventional commits; branch `feat/slack-notifications` (don't touch main).

## File Structure

**New:** `src/cli/notify.ts` (the `notify --test` command + a testable `runNotifyTest` helper).
**Modified:** `src/integrations/notifier.ts` (fields + `NotificationMessageSchema` + `process.env` cast), `src/db/repos/signal.ts` (`getDeliveredPayload`), `src/daemon/notify.ts` (populate title/prUrl; dead-end blocked), `src/integrations/adapters/slack.ts` (Block Kit + error handling), `src/daemon/projector.ts` (validate payload), `src/index.ts` (register command). Controller applies the trivial `src/daemon/run-ticket.ts:50` comment reword during final integration (comment-only, no test).

---

### Task 1: Widen `NotificationMessage` + zod schema + projector validation

**Files:**
- Modify: `src/integrations/notifier.ts`
- Modify: `src/daemon/projector.ts` (the `applyRow` `notify`/`post` branch)
- Test: `test/integrations/notifier.test.ts` (add cases)

**Interfaces:**
- Produces: `NotificationMessage` gains `ticketTitle?: string` and `prUrl?: string`; new `NotificationMessageSchema` (zod) and it is used in `applyRow` to parse the payload.

- [ ] **Step 1: Write the failing test** (append to `test/integrations/notifier.test.ts`)

```ts
import { NotificationMessageSchema } from "../../src/integrations/notifier.ts";

test("NotificationMessageSchema accepts optional title/prUrl and rejects a bad severity", () => {
  const ok = NotificationMessageSchema.parse({
    ticketIdent: "ENG-1", event: "escalated", severity: "high",
    reason: "boom", ticketTitle: "Fix widget", prUrl: "https://gh/pr/1",
  });
  expect(ok.ticketTitle).toBe("Fix widget");
  expect(ok.prUrl).toBe("https://gh/pr/1");
  // minimal message still valid (fields optional)
  expect(NotificationMessageSchema.parse({ ticketIdent: "ENG-2", event: "x", severity: "info" }).ticketTitle).toBeUndefined();
  // invalid severity rejected
  expect(() => NotificationMessageSchema.parse({ ticketIdent: "ENG-3", event: "x", severity: "loud" })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integrations/notifier.test.ts`
Expected: FAIL — `NotificationMessageSchema` is not exported.

- [ ] **Step 3: Add the fields + schema in `src/integrations/notifier.ts`**

Add `import { z } from "zod";` at the top. Replace the `NotificationMessage` interface with an interface PLUS a schema (keep the interface for existing consumers; derive nothing — declare both explicitly to avoid churn):

```ts
export interface NotificationMessage {
  ticketIdent: string;
  event: string;
  severity: NotifySeverity;
  reason?: string;
  ticketTitle?: string;
  prUrl?: string;
}

export const NotificationMessageSchema = z.object({
  ticketIdent: z.string(),
  event: z.string(),
  severity: z.enum(["high", "success", "info"]),
  reason: z.string().optional(),
  ticketTitle: z.string().optional(),
  prUrl: z.string().optional(),
});
```

Also, while in this file, narrow the `assertSlackConfigured` env default (Minor from review): change
`env: { SLACK_BOT_TOKEN?: string } = process.env as { SLACK_BOT_TOKEN?: string }` to read from a typed accessor:
`env: { SLACK_BOT_TOKEN?: string } = { SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN }`.

- [ ] **Step 4: Validate the payload in `projector.ts`**

In `src/daemon/projector.ts`, the `notify`/`post` branch currently does `payload as unknown as NotificationMessage`. Import the schema (`import { NotificationMessageSchema } from "../integrations/notifier.ts";` — keep the existing `NotificationMessage` type import) and change the call to:

```ts
      case "post": {
        const msg = NotificationMessageSchema.parse(payload);
        const { ref } = await ports.notifier.notify(msg);
        return ref;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/integrations/notifier.test.ts test/daemon/notify-outbox.test.ts`
Expected: PASS. (The existing `notify-outbox` test enqueues a valid message, so `.parse` succeeds.)

- [ ] **Step 6: typecheck + lint + commit**

Run: `bun run typecheck` and `bun run lint` (clean).
```bash
git add src/integrations/notifier.ts src/daemon/projector.ts test/integrations/notifier.test.ts
git commit -m "feat(notify): widen NotificationMessage (title/prUrl) + zod schema + validate in projector"
```

---

### Task 2: `getDeliveredPayload` signal-repo getter

**Files:**
- Modify: `src/db/repos/signal.ts`
- Test: `test/db/signal-delivered-payload.test.ts`

**Interfaces:**
- Produces: `getDeliveredPayload(db, ticketId, signalType): Record<string, unknown> | null` — the parsed `payload_json` of the most-recent delivered/consumed signal of that type, or null.

- [ ] **Step 1: Write the failing test**

```ts
// test/db/signal-delivered-payload.test.ts
import { expect, test } from "bun:test";
import { getDeliveredPayload, recordDelivered } from "../../src/db/repos/signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("getDeliveredPayload returns the delivered payload, else null", () => {
  const { db, ticketId } = makeTestDb();
  expect(getDeliveredPayload(db, ticketId, "external_pr_result")).toBeNull();
  recordDelivered(db, {
    ticketId, signalType: "external_pr_result",
    payload: { ref: "42", url: "https://github.com/x/y/pull/42" },
    idempotencyKey: "ENG-1:pr_result",
  });
  const p = getDeliveredPayload(db, ticketId, "external_pr_result");
  db.close();
  expect(p?.url).toBe("https://github.com/x/y/pull/42");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/signal-delivered-payload.test.ts`
Expected: FAIL — `getDeliveredPayload` not exported.

- [ ] **Step 3: Add the getter to `src/db/repos/signal.ts`** (model on the existing `hasDelivered`)

```ts
export function getDeliveredPayload(
  db: Database,
  ticketId: number,
  signalType: string,
): Record<string, unknown> | null {
  const row = db
    .query<{ payload_json: string | null }, [number, string]>(
      `SELECT payload_json FROM signal
         WHERE ticket_id = ? AND signal_type = ? AND status IN ('delivered','consumed')
         ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, signalType);
  if (!row || row.payload_json === null) return null;
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/signal-delivered-payload.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck + lint + commit**

```bash
git add src/db/repos/signal.ts test/db/signal-delivered-payload.test.ts
git commit -m "feat(notify): getDeliveredPayload signal getter (reads PR url from the SoT)"
```

---

### Task 3: Populate `ticketTitle` + `prUrl` in the sweep

**Files:**
- Modify: `src/daemon/notify.ts`
- Test: `test/daemon/notify-sweep.test.ts` (add a case)

**Interfaces:**
- Consumes: `getTicket().title` (existing), `getDeliveredPayload` (Task 2), widened `NotificationMessage` (Task 1).
- Produces: every enqueued message carries `ticketTitle` (from ticket title, omitted when null) and `prUrl` (from a delivered `external_pr_result`, omitted when absent).

- [ ] **Step 1: Write the failing test** (append)

```ts
import { getDeliveredPayload, recordDelivered } from "../../src/db/repos/signal.ts";

test("sweep enriches the message with ticket title and PR url when available", () => {
  const { db, ticketId } = makeTestDb(); // seeds ENG-1 (title null by default)
  // give the ticket a title + a delivered PR result
  db.query("UPDATE ticket SET title = ? WHERE id = ?").run("Fix the widget", ticketId);
  recordDelivered(db, { ticketId, signalType: "external_pr_result", payload: { ref: "42", url: "https://gh/pr/42" }, idempotencyKey: "ENG-1:pr_result" });
  appendEvent(db, { ticketId, kind: "escalated", reason: "boom" });
  createNotifier(cfg("escalations")).sweepNew(db, ticketId);
  const msg = JSON.parse(
    listPending(db).find((r) => r.target === "notify")!.payload_json as string,
  ) as { ticketTitle?: string; prUrl?: string };
  db.close();
  expect(msg.ticketTitle).toBe("Fix the widget");
  expect(msg.prUrl).toBe("https://gh/pr/42");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: FAIL — `msg.ticketTitle`/`msg.prUrl` are `undefined` (sweep doesn't populate them yet).

- [ ] **Step 3: Populate the fields in `src/daemon/notify.ts`**

Add `import { getDeliveredPayload } from "../db/repos/signal.ts";`. Replace the inline message construction so both `sweepNew` and `notifyTerminal` build the message via a shared helper that adds title + prUrl:

```ts
  const buildMsg = (
    db: Database,
    ticketId: number,
    event: string,
    severity: NotifySeverity,
    reason?: string,
  ): NotificationMessage => {
    const t = getTicket(db, ticketId);
    const pr = getDeliveredPayload(db, ticketId, "external_pr_result");
    const prUrl = typeof pr?.url === "string" ? pr.url : undefined;
    return {
      ticketIdent: t?.ident ?? String(ticketId),
      event,
      severity,
      reason,
      ticketTitle: t?.title ?? undefined,
      prUrl,
    };
  };
```

Replace the two `post(...)` call sites so they pass `buildMsg(...)` instead of the inline object. Keep the idempotency keys exactly as they are (`notify:${ticketId}:evt:${e.seq}` / `:term:${outcome}`). The `identOf` helper can be removed if `buildMsg` subsumes it (or kept — but avoid two `getTicket` calls per message; prefer `buildMsg` doing a single fetch).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: PASS (existing sweep tests + the new enrichment test — existing tests assert `event`/`severity` and are unaffected by the added optional fields).

- [ ] **Step 5: typecheck + lint + commit**

```bash
git add src/daemon/notify.ts test/daemon/notify-sweep.test.ts
git commit -m "feat(notify): enrich swept message with ticket title + PR url"
```

---

### Task 4: Dead-end `blocked` notification

**Files:**
- Modify: `src/daemon/notify.ts` (`notifyTerminal`)
- Test: `test/daemon/notify-sweep.test.ts` (add cases)

**Interfaces:**
- Consumes: `listPending` from `src/db/repos/signal.ts` (signals, `(db, ticketId)`).
- Produces: `notifyTerminal(db, ticketId, "blocked")` enqueues a high "gave up (blocked)" message ONLY when no `human_resume` signal is pending (i.e. a resolver dead-end, not an escalation).

- [ ] **Step 1: Write the failing test** (append)

```ts
import { insertPending } from "../../src/db/repos/signal.ts";

test("blocked terminal: dead-end notifies, escalation-blocked does not (already evented)", () => {
  // dead-end: no pending human_resume → a "gave up (blocked)" notification.
  // Reuse the file's existing `payloads(db)` helper (returns {event, severity}).
  const a = makeTestDb();
  createNotifier(cfg("escalations")).notifyTerminal(a.db, a.ticketId, "blocked");
  const aPayloads = payloads(a.db);
  a.db.close();
  expect(aPayloads).toEqual([{ event: "gave up (blocked)", severity: "high" }]);

  // escalation-blocked: a pending human_resume → NO terminal notification.
  const b = makeTestDb();
  insertPending(b.db, { ticketId: b.ticketId, signalType: "human_resume", reason: "boom" });
  createNotifier(cfg("escalations")).notifyTerminal(b.db, b.ticketId, "blocked");
  const bCount = payloads(b.db).length;
  b.db.close();
  expect(bCount).toBe(0);
});
```

*(If `insertPending`'s exact param shape differs, the implementer confirms it by reading `src/db/repos/signal.ts` — it is the same `insertPending` used across the daemon. `payloads` is the existing helper already defined at the top of `notify-sweep.test.ts`.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: FAIL — the dead-end case currently enqueues nothing (`blocked` → null today).

- [ ] **Step 3: Handle `blocked` in `terminalDecision` / `notifyTerminal`**

In `src/daemon/notify.ts`, add `import { listPending } from "../db/repos/signal.ts";`. The `blocked` decision now depends on DB state, so move it out of the pure `terminalDecision` into `notifyTerminal` (or pass a flag). Concretely, in `notifyTerminal`, before consulting `terminalDecision`, special-case `blocked`:

```ts
    notifyTerminal(db, ticketId, outcome) {
      if (!enabled) return;
      if (outcome === "blocked") {
        // Escalation-blocked already emitted an `escalated` event (swept). Only a resolver
        // dead-end (no pending human_resume) needs a terminal ping.
        const pending = listPending(db, ticketId);
        if (pending.some((s) => s.signal_type === "human_resume")) return;
        post(db, ticketId, `notify:${ticketId}:term:blocked`, {
          ...buildMsg(db, ticketId, "gave up (blocked)", "high"),
        });
        return;
      }
      const d = terminalDecision(outcome);
      if (!d) return;
      post(db, ticketId, `notify:${ticketId}:term:${outcome}`, buildMsg(db, ticketId, d.event, d.severity));
    },
```

Leave `terminalDecision`'s `blocked`/`parked` → null as-is (parked stays suppressed; blocked is now handled above).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: PASS (both new cases + all existing).

- [ ] **Step 5: typecheck + lint + commit**

```bash
git add src/daemon/notify.ts test/daemon/notify-sweep.test.ts
git commit -m "feat(notify): notify dead-end blocked terminals (not escalation-blocked)"
```

---

### Task 5: Block Kit rendering + robust Slack error handling

**Files:**
- Modify: `src/integrations/adapters/slack.ts`
- Test: `test/integrations/slack.test.ts` (add cases; keep existing)

**Interfaces:**
- Consumes: widened `NotificationMessage` (Task 1).
- Produces: `slackNotifier(...).notify()` POSTs `{ channel, blocks, text }`; a PR button is included when `prUrl` is set; non-OK HTTP and non-JSON bodies throw diagnosable errors.

- [ ] **Step 1: Write the failing tests** (add to `test/integrations/slack.test.ts`)

```ts
test("notify sends Block Kit blocks + a text fallback, with a PR button when prUrl is set", async () => {
  let body: any;
  const port = slackNotifier({ token: "t", channel: "#x", fetch: async (_u, i) => { body = JSON.parse(i.body as string); return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 }); } });
  await port.notify({ ticketIdent: "ENG-1", event: "PR ready to merge", severity: "success", ticketTitle: "Fix widget", prUrl: "https://gh/pr/42" });
  expect(Array.isArray(body.blocks)).toBe(true);
  expect(typeof body.text).toBe("string"); // fallback present
  const flat = JSON.stringify(body.blocks);
  expect(flat).toContain("ENG-1");
  expect(flat).toContain("Fix widget");
  expect(flat).toContain("https://gh/pr/42"); // PR button url
});

test("notify throws a diagnosable error on a non-JSON / non-OK body", async () => {
  const port = slackNotifier({ token: "t", channel: "#x", fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }) });
  await expect(port.notify({ ticketIdent: "ENG-1", event: "x", severity: "info" })).rejects.toThrow(/502/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/integrations/slack.test.ts`
Expected: FAIL — current adapter sends `{ channel, text }` (no `blocks`), and a 502 non-JSON body currently throws a bare `SyntaxError` (won't match `/502/`).

- [ ] **Step 3: Rewrite the adapter body in `src/integrations/adapters/slack.ts`**

```ts
    async notify(msg) {
      const emoji = EMOJI[msg.severity];
      const title = msg.ticketTitle ? ` — ${msg.ticketTitle}` : "";
      const headline = `${emoji} *${msg.ticketIdent}*${title}`;
      const bodyLine = `*${msg.event}*${msg.reason ? `\n${msg.reason}` : ""}`;
      const text = `${emoji} ${msg.ticketIdent}${title} ${msg.event}${msg.reason ? `: ${msg.reason}` : ""}`; // notification fallback
      const blocks: Record<string, unknown>[] = [
        { type: "section", text: { type: "mrkdwn", text: `${headline}\n${bodyLine}` } },
      ];
      if (msg.prUrl) {
        blocks.push({
          type: "actions",
          elements: [{ type: "button", text: { type: "plain_text", text: "View PR" }, url: msg.prUrl }],
        });
      }
      const res = await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ channel: opts.channel, blocks, text }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`slack chat.postMessage HTTP ${res.status}: ${raw.slice(0, 200)}`);
      let data: { ok: boolean; ts?: string; error?: string };
      try {
        data = JSON.parse(raw) as { ok: boolean; ts?: string; error?: string };
      } catch {
        throw new Error(`slack chat.postMessage returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 120)}`);
      }
      if (!data.ok) throw new Error(`slack chat.postMessage failed: ${data.error ?? "unknown error"}`);
      return { ref: data.ts ?? "" };
    },
```

(The existing two tests still pass: `ok:true` → `res.ok` true, JSON parses; `ok:false` at status 200 → parses, `data.ok` false → throws `channel_not_found`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/integrations/slack.test.ts`
Expected: PASS (2 existing + 2 new).

- [ ] **Step 5: typecheck + lint + commit**

```bash
git add src/integrations/adapters/slack.ts test/integrations/slack.test.ts
git commit -m "feat(notify): Slack Block Kit rendering + diagnosable HTTP/non-JSON errors"
```

---

### Task 6: `styre notify --test` command

**Files:**
- Create: `src/cli/notify.ts`
- Modify: `src/index.ts` (register the subcommand)
- Test: `test/cli/notify-test.test.ts`

**Interfaces:**
- Produces: `runNotifyTest(rc, deps): Promise<string>` (testable core — returns the sent `ref`) and `notifyCommand` (citty command wiring the real Slack notifier + stdout).

- [ ] **Step 1: Write the failing test**

```ts
// test/cli/notify-test.test.ts
import { expect, test } from "bun:test";
import { runNotifyTest } from "../../src/cli/notify.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("runNotifyTest sends one test message via the notifier and returns its ref", async () => {
  const notifier = fakeNotifier();
  const rc = RuntimeConfigSchema.parse({ notifier: "slack", notify: "escalations", slack: { channel: "#x" } });
  const ref = await runNotifyTest(rc, { notifier });
  expect(notifier.calls.length).toBe(1);
  expect(notifier.calls[0]?.event).toContain("test");
  expect(ref).toContain("fake-ts");
});

test("runNotifyTest fails loud when notifier is not configured", async () => {
  const rc = RuntimeConfigSchema.parse({}); // notifier: "none"
  await expect(runNotifyTest(rc, {})).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/notify-test.test.ts`
Expected: FAIL — `src/cli/notify.ts` does not exist.

- [ ] **Step 3: Create `src/cli/notify.ts`**

```ts
import { defineCommand } from "citty";
import { discoverRuntimeConfig } from "../config/discover.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { slackNotifier } from "../integrations/adapters/slack.ts";
import { assertSlackConfigured, type NotifierPort, selectNotifier } from "../integrations/notifier.ts";

/** Testable core: send one test notification. Throws (fail-loud) if the notifier is misconfigured. */
export async function runNotifyTest(
  rc: RuntimeConfig,
  deps: { notifier?: NotifierPort },
): Promise<string> {
  // Only validate + construct the real notifier when one isn't injected. `assertSlackConfigured`
  // reads the env token, so it must NOT run when a test supplies a fake notifier.
  let notifier = deps.notifier;
  if (!notifier) {
    assertSlackConfigured(rc); // fail-loud on the real path (missing token/channel)
    notifier = selectNotifier({ notifier: rc.notifier }, {
      slack: () => slackNotifier({ token: process.env.SLACK_BOT_TOKEN ?? "", channel: rc.slack?.channel ?? "" }),
    });
  }
  if (!notifier) throw new Error('notify --test: no notifier configured (set notifier: "slack")');
  const { ref } = await notifier.notify({
    ticketIdent: "styre",
    event: "notifier test — hello from Styre",
    severity: "info",
  });
  return ref;
}

export const notifyCommand = defineCommand({
  meta: { name: "notify", description: "Notifier utilities" },
  args: {
    test: { type: "boolean", description: "Send one test message to the configured channel" },
    config: { type: "string", description: "Explicit config.json path" },
  },
  async run({ args }) {
    if (!args.test) {
      process.stderr.write("usage: styre notify --test\n");
      process.exitCode = 2;
      return;
    }
    const rc = discoverRuntimeConfig({ explicitPath: args.config });
    const ref = await runNotifyTest(rc, {});
    process.stderr.write(`notifier: ${rc.notifier} → ${rc.slack?.channel}\n✓ sent test message (ts ${ref})\n`);
  },
});
```

- [ ] **Step 4: Register in `src/index.ts`**

Add `import { notifyCommand } from "./cli/notify.ts";` and add `notify: notifyCommand,` to the `subCommands` map (alongside `migrate`/`run`/`setup`).

- [ ] **Step 5: Run tests + verify registration**

Run: `bun test test/cli/notify-test.test.ts`
Expected: PASS.
Run: `bun run src/index.ts notify 2>&1 | head -2`
Expected: prints the `usage: styre notify --test` line (no crash; command is registered).

- [ ] **Step 6: typecheck + lint + commit**

```bash
git add src/cli/notify.ts src/index.ts test/cli/notify-test.test.ts
git commit -m "feat(notify): styre notify --test command"
```

---

## Final verification (controller)

- [ ] Apply the trivial `src/daemon/run-ticket.ts:50` comment reword (cosmetic; e.g. `// backstop: re-sweep in case the terminal tick enqueued late events`). No test.
- [ ] `bun test` full suite green; `bun run typecheck` clean; `bun run lint` clean.
- [ ] Whole-branch review on Opus (the enrichment batch), then push.

## Self-review notes (coverage vs the approved design)

- **Widen message + zod + projector validate** → Task 1 (also folds the `process.env` cast Minor). **PR-url getter** → Task 2. **Populate title+prUrl** → Task 3. **Dead-end blocked** → Task 4. **Block Kit + robust errors** → Task 5 (folds the non-JSON Minor). **`notify --test`** → Task 6. **Comment Minor** → controller final step.
- **Confirmed out of scope:** per-severity channels; issue/Linear URL.
- **Type consistency:** `NotificationMessage`/`NotificationMessageSchema` fields (`ticketTitle`, `prUrl`) match across notifier.ts, notify.ts (buildMsg), slack.ts (render), and the projector validation. `getDeliveredPayload` signature is consistent between Task 2 (def) and Task 3 (use).
