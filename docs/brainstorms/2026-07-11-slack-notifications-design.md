# Slack notifications — outbound notifier abstraction (Piece A)

**Status:** design v2 — independent review folded (§10); awaiting operator sign-off
**Date:** 2026-07-11
**Branch/worktree:** `feat/slack-notifications` (off `origin/main` @ `f3e2987` v0.6.0)
**Scope:** Piece **A** only (outbound notifications). Piece B (durable SoT) and Piece C
(inbound 2-way) are **deferred** — see §8.

---

## §0 — What this is, and the open-core split (the load-bearing decision)

The operator wants Slack notifications for **major notifications and escalations**, built as a
**generic notifier abstraction** (Slack = first adapter, exactly like the provider-agnostic
`AgentRunner` and the neutral `issue_tracker`/`forge` ports), with a **configurable policy** (how
chatty), and — eventually — **two-way** Slack (Approve/Reject buttons that feed a decision back into
the loop).

**The frozen design already places "Slack notify" on the commercial side** (`brainstorm.md:423`: the
persistent daemon *is* the commercial plane and owns the needs-you inbox + Slack notify;
`minimal-loop.md:181`: "Slack on each new escalation (the kept `slack.sh` leaf)" is a needs-you-inbox
feature). This design **deliberately reopens that** for the *outbound* half only, and re-draws the
line at the exact seam where it is structurally forced:

- **Outbound notifier + policy → OSS core.** "When X happens, send a message" is a pure one-way
  sink. It touches no control flow, reads nothing back, and violates no invariant. A solo `styre run`
  user benefits directly. **This is Piece A — the subject of this doc.**
- **Two-way listener (Slack buttons → decision) → commercial plane.** Two-way requires a process that
  stays alive across the human's response latency, listening for the click. `styre run` is the
  opposite: a one-shot ephemeral primitive that **exits** at every human gate (pr-ready → exit 0,
  escalation → nonzero, quota death → park exit 75; `run-ticket.ts:64-76`, `park.ts:54-62`). "Holds
  escalated tickets across the human's latency and listens for their answer" is, word for word, how
  the design defines the commercial persistent daemon. So two-way is plane-side **by physics, not by
  preference.** Deferred — §8.
- **The seam between them is the `signal` table.** A Slack button never reads Styre's state for
  control flow; it only **delivers a `human_*` signal** into the SoT — which is exactly how every
  human decision already enters this system (`schema.sql:206-207`: `human_merge_approval` /
  `human_plan_approval` / `human_resume`). The one-way-projection invariant survives. The OSS core
  would expose a thin signal-injection verb (`styre resolve`); the plane owns the listener. Also
  deferred — §8, Piece C.

**Consequence, explicitly accepted:** with only Piece A shipped, the *inbound* half does nothing for
a pure-OSS user. Outbound notifications work fully standalone. This matches the split.

**Engaging the sharpest frozen-text conflict (not just the convenient one).** Two frozen lines put
Slack *and escalation-routing itself* on the plane, and Piece A must meet them head-on, not around
them: **D3** (`brainstorm.md:406`) bundles *"Slack notify + SQLite-backed queue"* with the needs-you
inbox as LATER/plane; and the 2026-06-20 no-fork/telemetry-seam changelog names **"escalation
routing"** among the plane's value ("…dashboards, fleet orchestrator, escalation routing … wraps the
*unmodified* core"). Piece A — post a message on escalation — *is* outbound escalation routing. So the
reopening is real, and rests on one claim: **routing an escalation to a Slack message is a pure
one-way sink that a solo `styre run` user benefits from with zero plane** — it violates no invariant
(move 2's one-way projection holds; nothing is read back for control flow), and the *stateful*
escalation-routing the changelog means (holding a queue, a listener, a dashboard) stays entirely
plane-side. We move the **stateless outbound ping** across the line; we leave **stateful routing**
where it is. Two honest costs of doing so:
- **Double-notify overlap.** A commercial plane already routes escalations to Slack off the NDJSON
  stream. A core that *also* has `notifier:slack` double-pings. Not fatal (the operator sets exactly
  one side), but it means the core now carries a config that overlaps a plane responsibility — the
  "wraps the *unmodified* core" story gains one seam. Recorded in the D3 register entry (§5 item 11).
- **Two-way = commercial is airtight (not hand-waved).** `styre run` exits at *every* gate
  (`run-ticket.ts:64-81`, `park.ts:54-62`); anything that waits for a Slack click is a persistent
  listener, which *is* the daemon by definition. Adding a notifier port to `makeProjectorPorts` leaks
  nothing — a plane sets `notifier:none` and routes off NDJSON as before. There is no cheap OSS path to
  two-way that preserves the ephemeral-runner identity; §8/Piece C stands.

---

## §1 — The notifier abstraction (port + adapter)

A vendor-neutral port, mirroring `issue_tracker`/`forge` (`src/integrations/issue-tracker.ts:23-32`
is the selection pattern to copy):

```ts
// src/integrations/notifier.ts (new)
export interface NotifierPort {
  // Deliver one rendered notification. Returns a provider ref (e.g. Slack ts) for response_ref.
  // Throws on transport failure (caller = the projector decides retry; see §2).
  notify(msg: NotificationMessage): Promise<{ ref: string }>;
}

export interface NotificationMessage {
  ticketIdent: string;          // "ENG-123"
  ticketTitle: string;
  event: NotifiableEvent;       // discriminated (see §3)
  severity: "high" | "success" | "info";  // high=escalation/park/gave-up, success=pr-ready,
                                          // info=transition/loopback. Drives emoji/color.
  reason?: string;              // escalation reason / park cause
  links?: { pr?: string; issue?: string };
}
```

- **The core builds the neutral `NotificationMessage`; the adapter renders it.** A future Discord/
  email adapter is a new file implementing `NotifierPort` and one line in the selector — **zero core
  change**. This is the whole point of the abstraction.
- **Selection + construction** happen in `makeProjectorPorts()` (`src/daemon/ports.ts:12-33`), the
  single place vendor adapters are built from `(runtimeConfig, profile)`. A `selectNotifier(rc)`
  returns the Slack adapter when `rc.notifier === "slack"`, else a no-op notifier (`rc.notifier`
  absent/`"none"`). Constructed exactly as `selectIssueTracker`/`selectForge` are today.
- **Creds from env, never config** (`ports.ts:9` establishes the pattern). The Slack adapter reads
  `SLACK_BOT_TOKEN` from the environment; the config carries only non-secret policy + channel (§4).

### Slack adapter (first implementation)

- **Bot-token app** (operator-chosen — §4), calling Slack Web API `chat.postMessage` with
  `{ channel, blocks }`. Renders `NotificationMessage` → Slack Block Kit: a header with a
  severity emoji (🔴 high / 🟢 success=pr-ready / ▸ info), the ticket ident + title, the reason, and
  PR/issue link buttons when present.
- `channel` comes from `rc.slack.channel`; `token` from `SLACK_BOT_TOKEN`.
- Returns the message `ts` as `{ ref }` (persisted to `projection_outbox.response_ref`).

---

## §2 — Delivery: Slack rows ride the outbox; a **driver-level sweep** enqueues them

Notifications use the projector's `projection_outbox` for **retry + idempotency + crash-safety**, but
— corrected from v1 after review — they are **NOT enqueued in the same transaction as the state
change.** They are enqueued by a **driver-level sweep that mirrors the telemetry emitter**, which is
the only mechanism that (a) has `rc` (the policy) in scope, (b) sees the *silent* terminals, and (c)
needs zero edits to the ~11 escalation call sites. Dropping same-txn is correct here precisely because
a notification is a **lossy-tolerable** sink (asymmetry #1 below) — unlike a Linear/GitHub write, it
must never be coupled to the control transaction.

### The sweep (the load-bearing mechanic)

The telemetry emitter already does exactly the shape we need: every tick it reads new `event_log` rows
since a watermark (`createTelemetryEmitter().flushNew` → `listByTicketSince(db, ticketId, lastSeq)`,
`emitter.ts:122-133`, called at `run-ticket.ts:58`) and emits each, **at the driver, outside any txn,
with `rc`/`ports` in scope**; and it emits a terminal `summary` at drive-end (`emitSummary`). The
notifier is a **sibling** of that emitter:

- **Per-tick — `notifyNewEvents(db, rc, ports, ticketId)`** (called right beside `flushNew` at
  `run-ticket.ts:58`): watermark-sweep the new `event_log` rows; for each whose `kind` passes the §3
  policy dial, build the neutral `NotificationMessage` and **enqueue** a `notify` outbox row. Covers
  every event-backed point — all escalations (`kind='escalated'`), park (`kind='parked'`), transitions,
  loopbacks — with **no escalation-site edits and no `rc`-threading through `appendEvent`.**
- **At drive-end — `notifyTerminal(db, rc, ports, ticketId, outcome)`** (called where `emitSummary`
  is, `run-ticket.ts:45-49`): for the **silent terminals** that write no `event_log` row — `pr-ready`,
  `no-progress`, dead-end `blocked`, `done` — enqueue a `notify` row keyed on the outcome. This is the
  piece the event sweep structurally cannot see (§3 map), so it is explicit and honest: a **post-commit
  best-effort enqueue**, never in-txn.

### Draining (BLOCKER-1 fix — the centerpiece bug in v1)

`drainOutbox` has exactly one call site today: inside `tick()` (`loop.ts:48-49`). So mid-drive
enqueues drain on the next tick, but the **final** sweep's rows and **all** terminal rows are enqueued
*after the last tick* — in v1 nothing drained them, so pr-ready/gave-up pings would sit `pending`
forever (silent on exactly the moments the design exists for). **Fix: one explicit
`drainOutbox(db, ports)` after `driveToTerminal` returns** (in `run-ticket.ts`'s `finish()` / before
`finishRunResult`). Per-tick drains keep escalation pings prompt during a long run; the post-loop drain
flushes the tail (terminals + last sweep).

### Schema + adapter plumbing

- **Schema change — add `'notify'` to the `projection_outbox` target CHECK** at `src/db/schema.sql:475`
  (`target IN ('issue_tracker','forge','notify')`), and its mirror in `docs/architecture/schema.sql`
  (**both copies — lockstep**; `src/db/` is authoritative/loaded, `docs/architecture/` is the doc).
  **Note (NIT):** the *same* CHECK string also appears at `schema.sql:460` for `projection_state` — a
  table **no code references**; notify rows never touch it, so **leave :460 untouched** (do not edit it
  reflexively). TS union `OutboxTarget` (`projection-outbox.ts:4`) gains `"notify"`.
- **Op / payload.** One op `post` under target `notify`; `payload_json` = serialized
  `NotificationMessage` (§1), snapshotted at enqueue.
- **`applyRow` gets a `case "notify"`** (beside `issue_tracker`/`forge`, `projector.ts:98-127`) →
  `ports.notifier.notify(payload)` → `markSent` with the ref.

### Two deliberate asymmetries from the other targets

1. **A failed notification NEVER escalates the ticket.** For `issue_tracker`/`forge`, exhausting
   `OUTBOX_RETRY_BUDGET` (`=5`, `projector.ts:27`) calls `escalateProjection` (`projector.ts:140-146`,
   called `:168`) — a control-relevant projection that can't land means the loop is broken. A
   notification is **not** control-relevant: a dropped "🔴 needs you" ping making the ticket *more*
   stuck is perverse. So the drain path branches on `row.target === 'notify'`: retry within budget,
   then `markFailed` + log, and **skip `escalateProjection`.** (This asymmetry is *why* dropping
   same-txn above is acceptable.)
2. **Idempotency key = the event's `seq` (corrected from v1).** v1 keyed on
   `<discriminant>:<reason>`, which **over-collapses**: signature-less escalations
   (`poll-checks.ts:20`, `projector.ts:159`) and shared reason text (`failure-policy.ts:155,237` both
   `"no progress"`) would merge distinct escalations into one lifetime ping. `appendEvent` returns each
   row's monotonic per-ticket `seq` (`event-log.ts:32,86-92`), so the key is
   `notify:<ticketId>:evt:<seq>` (event-backed) / `notify:<ticketId>:term:<outcome>` (terminal).
   Collision-free by construction, exactly one notify per event, and re-drive-safe: a resumed run that
   re-sweeps the same `seq` hits `INSERT OR IGNORE` (`projection-outbox.ts:37`) → no double-post.

Everything else is inherited free: FIFO drain (`listPending`, `projection-outbox.ts:50-56`), retry
accounting (`bumpAttempt` `:64-68`), status vocab (`pending|sent|failed|skipped`, `schema.sql:480`).

---

## §3 — Policy: one ordered dial + the enqueue-point map

### The dial (runtime-config, per-project overridable)

`rc.notify ∈ { "escalations", "transitions", "everything" }` — **ordered/inclusive** (each level
contains the ones above). Modeled by *minimum importance*, not by event type, so it reshapes cleanly
around "attention-worthy moments" rather than "bad news only":

| `notify` value | Fires on |
|---|---|
| `escalations` (baseline) | escalations · **pr-ready** · park · gave-up (no-progress / dead-end) — every run-ending / needs-you moment |
| `transitions` | above + each stage transition (`design→implement→…→merge`) |
| `everything` | above + loopbacks / retries |

**Deliberately NOT offered:** "transitions without escalations." There is no real appetite for "tell
me when it moves but stay silent when it's stuck and needs me." If ever wanted, the dial becomes
independent toggles; until then it stays an ordered dial. (Flagged, not silently dropped.)

### Notifiable events → the two-part sweep (from the exhaustive termination/escalation/HITM map)

The map (three tables, below) exists to guarantee **no notifiable moment is missed** — and it earned
its place: it isolates the *silent terminals* that emit no `event_log` row, which the event sweep
structurally cannot see and which a naïve "watch the event stream" notifier would drop (this is the
class of bug the map is here to prevent).

The enqueue architecture is the §2 driver-level sweep — **not** an `appendEvent` hook (v1's proposal,
withdrawn: `appendEvent(db, e)` carries no `rc`, and ~11 escalation callers — `applyFailurePolicy`,
`applyChecksVerdict`, `applyArbiterVerdict`, `pollChecks`, `checks-gate-verdict.escalate` — have no
`rc` to thread, so the "one hook, no site edits" claim was self-defeating). Two parts:

- **Event-backed → `notifyNewEvents` per-tick sweep.** Every escalation (`kind='escalated'`; all the
  Table-2 reasons funnel through the single `appendEvent` writer — verified, zero inline inserts),
  park (`advance.ts:161`), transitions (`advance.ts:65`), loopbacks — all are `event_log` rows
  (`kind ∈ {transition,loopback,escalated,resumed,note,parked}`, `schema.sql:289-290`). The sweep reads
  them via the watermark, maps `kind`→severity/tier, applies `rc.notify`, and enqueues. No site edits.
- **Silent terminals → `notifyTerminal` at drive-end.** `pr-ready` (`run-ticket.ts:68-69`; the success
  terminal — `awaitSignal` wrote only a `signal` row in a *prior, already-committed* tick,
  `engine/signals.ts:8-20`, so there is **no** current state change to attach to — it is honestly a
  post-commit enqueue, **not** in-txn), `no-progress` (`run-ticket.ts:74-76,81`), dead-end `blocked`
  (`run-ticket.ts:72`), and `done`. All change no *current* state → all are post-commit best-effort
  enqueues keyed on the outcome. A best-effort enqueue that itself fails is logged and dropped — never
  fatal to the run.

Both parts feed the outbox; the per-tick drain flushes mid-run rows and the **post-loop drain (§2
BLOCKER-1 fix)** flushes the tail. (Minor latency note: the per-tick sweep runs *after* that tick's
own internal drain, so a mid-run ping is delivered by the *next* tick's drain — a one-tick lag, not
"immediately"; terminal delivery is unaffected.) `everything`-tier loopbacks ride the same event sweep,
admitted by the policy filter only at `everything` — no extra wiring.

---

## §4 — Setup / connect (bot-token app)

Two separable things, each onto an existing pattern:

- **The secret → env var.** `export SLACK_BOT_TOKEN=xoxb-…`. Read inside the adapter; never in
  config (`ports.ts:9` pattern).
- **The policy + channel → `config.json`** (the runtime-config layer,
  `discoverRuntimeConfig` `src/config/discover.ts:46-58`; dir `configDir()` `src/config/paths.ts:12-16`).
  **Not** part of `styre setup` — that writes the probed *profile* (product shape only); notification
  preferences are operator policy, so they live in `config.json`.

**Operator-chosen: bot-token app (not incoming webhook).** Rationale: the channel lives in config (so
per-project `config.json` routes different repos to different channels for free via the existing
config layering), richer native Block Kit rendering, and — decisively — it is the **same Slack app**
the future two-way listener (Piece C) will use, so the user sets up Slack **once** for the whole
lifecycle. Webhook was rejected: one-channel-per-URL and no interactivity path.

**One-time Slack setup:** create a Slack app → add `chat:write` scope → install to workspace →
`/invite` the bot into the target channel → copy the bot token.

**Config shape:**
```jsonc
// ~/.config/styre/config.json  (global default)
{
  "notifier": "slack",
  "notify": "escalations",            // the §3 dial
  "slack": { "channel": "#styre" }
}
```
```jsonc
// ~/.config/styre/<project-slug>/config.json  (optional per-project override)
{ "slack": { "channel": "#team-payments" } }
```
*Caveat (NIT):* `discoverRuntimeConfig` shallow-merges **per top-level key** (`discover.ts:57`:
`{...global, ...perProject}`), so a per-project `slack` block **replaces** the global one wholesale
(same caveat the code already notes for the `agent` block). Fine while `slack` has one field; if
`slack.*` ever grows, a per-project override must repeat every field it wants to keep.

**Config schema additions** (`src/config/runtime-config.ts:9-22`, alongside `issueTracker`/`forge`):
- `notifier: z.enum(["none","slack"]).default("none")`
- `notify: z.enum(["escalations","transitions","everything"]).default("escalations")`
- `slack: z.object({ channel: z.string() }).optional()`

**Misconfiguration is never silent** (operator "no silent scope deferral" stance). **Critical: the
fail-loud MUST be an eager startup check in `run.ts`, not a lazy token read inside the adapter.** A
lazy read inside `notify()` would surface a missing token as a *transport throw* → retried →
`markFailed` → **no escalate** (§2 asymmetry #1) → the notification is **silently dropped** — the
exact failure this rule forbids. So `run.ts` (item 11) is the authority and validates before the drive
starts:
- If `notifier: "slack"` but `SLACK_BOT_TOKEN` is **absent** → **fail loudly at startup**; do not run
  with notifications silently disabled.
- If `notifier: "slack"` but `slack.channel` is absent → same fail-loud.
- On successful wire-up, a startup log line confirms what's active:
  `notifier: slack → #styre (policy: escalations)`.
- **Optional nicety (flagged, not committed):** `styre notify --test` posts one "hello from Styre"
  message so a user can verify the connection without waiting for a real event.

---

## §5 — Components (files)

**New:**
1. `src/integrations/notifier.ts` — `NotifierPort`, `NotificationMessage`, `NotifiableEvent`,
   `selectNotifier(rc)`, and a `NoopNotifier`.
2. `src/integrations/notifier-slack.ts` — the Slack adapter (`chat.postMessage`, Block Kit render,
   `SLACK_BOT_TOKEN`).
3. `src/daemon/notify.ts` — the sweep: `notifyNewEvents(db, rc, ports, ticketId)` (watermark event
   sweep → policy filter → neutral-message build → outbox enqueue) and
   `notifyTerminal(db, rc, ports, ticketId, outcome)` (silent-terminal enqueue). One home for the
   `kind`/outcome → severity/tier mapping. **No escalation-site edits; no `rc`-threading through
   `appendEvent`.**

**Edited:**
4. `src/db/schema.sql` **and** `docs/architecture/schema.sql` — add `'notify'` to the
   **`projection_outbox`** `target` CHECK (`:475`). *(Both copies — lockstep. Leave the identical
   `projection_state` CHECK at `:460` untouched — unreferenced by code; notify never touches it.)*
5. `src/db/repos/projection-outbox.ts` — `OutboxTarget` union gains `"notify"` (`:4`).
6. `src/daemon/projector.ts` — `applyRow` `case "notify"` (`~:98`); drain-path branch so a
   `notify` failure **does not** call `escalateProjection` (`~:168`).
7. `src/daemon/ports.ts` — construct `notifier` in `makeProjectorPorts` (`:12-33`); add to the ports
   type.
8. `src/config/runtime-config.ts` — `notifier` / `notify` / `slack` fields (`:9-22`).
9. `src/daemon/run-ticket.ts` — call `notifyNewEvents` beside `flushNew` (`:58`, per-tick event
   sweep); call `notifyTerminal` beside `emitSummary` (`:45-49`, silent terminals); and **add the
   post-loop `drainOutbox(db, ports)`** after `driveToTerminal` returns (BLOCKER-1 fix, §2). *(No
   `advance.ts` / escalation-site edits — the sweep replaces the withdrawn `appendEvent` hook.)*
10. `src/cli/run.ts` — eager startup validation (fail-loud, the authority per §4) + the confirmation
    log line.
11. Docs: update `CLAUDE.md` / `build-operations.md` config-layering + the `brainstorm.md` §10 Open
    Decisions Register / §11 changelog to record the reopened D3 (Slack-notify → OSS-outbound).

---

## §6 — Edge cases & decisions

- **`notifier: "none"` (default)** — `selectNotifier` returns `NoopNotifier`; the sweep
  short-circuits before enqueue (no `notify` rows ever written). Happy path byte-identical; zero cost
  when off.
- **Notification transport failure** — retried within `OUTBOX_RETRY_BUDGET`, then `markFailed` + log,
  **no escalation** (§2 asymmetry #1). The ticket's control flow is unaffected by Slack being down.
- **Crash / resume double-post** — prevented by the `seq`-scoped idempotency key (§2 asymmetry #2):
  a resumed run re-sweeping the same event `seq` re-enqueues the same key → `INSERT OR IGNORE` no-op.
- **Delivery is post-commit best-effort, not same-txn (corrected from v1).** Notifications are
  enqueued by the driver-level sweep *after* the state txn commits (§2). This is deliberate for a
  lossy-tolerable sink and is the price of needing no escalation-site edits + having `rc` in scope.
  Worst case: the process dies between a committed event and the sweep that would enqueue its notify →
  that ping is lost. Acceptable — a notification is advisory; the SoT, exit code, and (event-backed
  cases) the durable `event_log` row remain authoritative. **No notifiable moment is same-txn
  "durable"; all are best-effort.** pr-ready specifically is a post-commit enqueue — its
  merge-approval signal was written in a prior, already-committed tick (`engine/signals.ts:8-20`), so
  there is no current txn to attach to (this corrects v1's contradictory "pr-ready is in-txn" claim).
- **pr-ready is a *success*, not a needs-you** — severity `success` (🟢), not the alarm
  (🔴) of an escalation. Same tier (baseline), different rendering. "Your PR is ready to merge" must
  read as good news.
- **`released`/`done` is unreachable in the OSS runner** — reaching it needs a `human_merge_approval`
  the runner never delivers (Table 1 note); the OSS success terminal is **pr-ready**. So the baseline
  policy's "done" case is pr-ready. A daemon that delivers merge-approval would additionally hit the
  `done` terminal (already covered by the same enqueue arch if/when reached).
- **Per-project channel** (not per-severity) — one channel per run (v1), but different projects route
  to different channels via per-project `config.json`. Per-*severity* channel routing (escalations →
  #urgent, progress → #activity) is a deferrable later addition (§8), cheap on top of this.
- **Message snapshot vs live links** — the PR/issue URLs are those known at enqueue time. For
  escalations the PR may not exist yet (`links.pr` omitted); the issue link is always present. Fine.
- **Ordering** — FIFO drain means notifications land in event order per ticket. Cross-ticket ordering
  is best-effort (single-ticket `styre run` makes this moot; the K=2 daemon interleaves, acceptable).

---

## §7 — Testing

- **`selectNotifier` (unit):** `rc.notifier="slack"` → Slack adapter; absent/`"none"` → `NoopNotifier`.
- **Slack adapter render (unit, fake HTTP):** a `NotificationMessage` with each severity → asserts the
  `chat.postMessage` body has the right `channel`, emoji, ticket ident, reason, and link buttons.
  Token read from `SLACK_BOT_TOKEN`.
- **Outbox `notify` target (unit, real DB):** enqueue a `notify` row → `listPending` returns it →
  `applyRow` dispatches to `ports.notifier.notify` (a `FakeNotifier` capturing the message) →
  `markSent` with the ref. Assert the neutral message content.
- **Non-escalating failure (unit — the §2 asymmetry, the important one):** a `FakeNotifier` that
  always throws → drain retries to budget → row `failed`, **and assert NO `escalated` event / ticket
  status unchanged**. Contrast an `issue_tracker` failure in the same harness → DOES escalate. Proves
  the branch.
- **Idempotency (unit):** enqueue the same event twice (same key) → exactly one row / one send.
- **Policy dial (unit):** feed a synthetic sequence of `event_log` rows (escalated, transition,
  loopback) + terminal outcomes (pr-ready, no-progress) through `notifyNewEvents`/`notifyTerminal` at
  each `notify` level → assert exactly the expected subset is enqueued: `escalations` admits
  escalated+pr-ready+parked+no-progress but NOT transition/loopback; `transitions` adds transition;
  `everything` adds loopback.
- **Post-loop drain (unit — the BLOCKER-1 guard):** enqueue a terminal `notify` row *after* the drive
  loop, then assert the post-loop `drainOutbox` actually sends it (`FakeNotifier` received it, row
  `sent`). Without the fix the row stays `pending` — this test fails, which is the point.
- **Silent-terminal coverage (e2e, the crux):** drive a ticket to **pr-ready** with `notifier=slack`
  (FakeNotifier) + `notify=escalations` → assert a pr-ready notification was **sent** (post-loop drain)
  **even though no `event_log` row exists for it**. Drive one to **no-progress** → assert the
  best-effort gave-up notification. Drive one to an **escalation** → assert the 🔴 escalation
  notification with the reason string. (This is the test that would have caught v1's "only ever bad
  news, silent on success" bug.)
- **Fail-loud (unit):** `notifier=slack` + no `SLACK_BOT_TOKEN` → startup throws with a clear message;
  `notifier=none` → no requirement, no throw.
- **Regression:** full suite green with `notifier` unset (default `none`) — no `notify` rows, no
  behavior change anywhere. lint + typecheck clean.

---

## §8 — What this is NOT (deferred, with the seam preserved)

- **NOT two-way / interactive (Piece C).** No Slack buttons, no inbound decisions, no `styre resolve`
  verb in this scope. Two-way needs a persistent listener = commercial plane (§0). The OSS seam is
  preserved and untouched: the `signal` table already has the `human_*` vocabulary; when Piece C
  lands, the plane's listener delivers a signal through a thin OSS verb — **no rework of Piece A.**
- **NOT durable-by-default SoT (Piece B).** Making `styre run`'s ephemeral tempfile DB
  (`run.ts:121-124`) durable at the XDG state path was motivated by *resuming* escalations for the
  inbound loop. With two-way deferred, Piece B is deferred too. It remains a clean, separable
  follow-up (durable DB + `run`/`--resume`/`--fresh` collision rule + cleanup-on-clean-terminal +
  resume-consumes-signal); it changes a documented property ("ephemeral per-run SQLite") and is
  independently useful for resume generally. Outbound (Piece A) works fully on today's ephemeral model.
- **NOT a new outward *control* path** — a notification is a projection, never read back for control
  flow. The one-way-projection invariant (move 2) is upheld: Slack is a third projection target beside
  Linear/GitHub, nothing more.
- **NOT per-severity channel routing** — one channel per run (v1); per-project override yes,
  per-severity split no. Cheap later addition on top of §2's `payload_json`.
- **NOT part of `styre setup` / the profile** — notification config is operator policy in
  `config.json`, not probed product shape.
- **NOT a `styre config`/`inbox`/`status` command** — those are commercial management-CLI surface;
  OSS config is hand-edited `config.json` + env var.

---

## §9 — Appendix: the termination / escalation / HITM map (authoritative, code-grounded)

The complete surface Piece A must cover. "Emits event?" = writes an `event_log` row = seen by the
§3 per-tick event sweep; the silent ones need the explicit `notifyTerminal` enqueue.

### Table 1 — Termination
| Outcome | Meaning | Exit | Emits event? | Notify tier |
|---|---|---|---|---|
| **pr-ready** | merge gate reached; PR open, awaiting human merge. **OSS success terminal.** (`run-ticket.ts:68-69`) | 0 | ❌ silent | baseline (🟢) |
| **blocked** (escalation) | an escalation fired (Table 2). (`run-ticket.ts:66-67`) | ≠0 | ✅ `escalated` | baseline (🔴) |
| **blocked** (dead-end) | resolver has no actionable unit, can't finish. (`run-ticket.ts:72`) | ≠0 | ❌ silent | baseline (best-effort) |
| **no-progress** | idle-cap (3 ticks) or iter-cap (200). (`run-ticket.ts:74-76,81`) | ≠0 | ❌ silent | baseline (best-effort) |
| **parked** | quota/session death; state dumped for `--resume`. (`advance.ts:151-176,161`) | 75 | ✅ `parked` | baseline |
| **done** (released) | fully released. **Unreachable in OSS** (needs undelivered `human_merge_approval`). | 0 | ❌ silent | baseline (daemon-only) |

### Table 2 — Escalation (17 logical reasons across ~11 `appendEvent(kind:'escalated')` call sites)
The 17 are distinct *reasons*; they funnel through ~11 call sites (many behind the shared
`escalate`/`escalateOnce`/`escalateProjection` helpers) — and **all** route through the single
`appendEvent` writer (verified: zero inline `event_log` inserts), so the §3 event sweep catches every
one with no site edits. Four families; the notifier surfaces the `reason` string uniformly (no
per-family branching):
- **Tried enough, still failing** — attempt-budget exhausted (`failure-policy.ts:70-86`); provision
  fail, escalate-immediately (`:91-107`).
- **Stuck, no progress** — identical failure twice: unit-verify (`:147-158`), completeness
  (`:229-240`); review no-progress plan/code (`review-verdict.ts:179,193`); AC re-author cap
  (`checks-verdict.ts:93-108`); gate-round cap (`checks-gate-verdict.ts:111-130`,
  `arbiter-verdict.ts:49-65,146-165`); stuck-at-HEAD liveness (`advance.ts:90-95`).
- **Needs a human judgment call** — blocking plan-defect w/ escalate policy (`review-verdict.ts:205-211`);
  deferrable major finding needs a defer decision (`:219-225`).
- **Infra / external broken** — checks-gate infra fault (`failure-policy.ts:113-129`); projector down
  past retry budget (`projector.ts:140-146`); CI reported checks failing (`poll-checks.ts:16-22`).

### Table 3 — HITM (human waits)
| Signal | Human action | Status in OSS |
|---|---|---|
| `human_resume` | fix root cause, resume | raised by all 17 escalations; **no deliverer** → effectively terminal today (Piece B would make it resumable) |
| `human_merge_approval` | approve/merge PR | *is* the pr-ready terminal; by design never delivered by `styre run` (`run-ticket.ts:28-30`) |
| `human_plan_approval` | approve large-ticket plan | **not wired** — schema vocab only (`schema.sql:206`), fully deferred |

Non-human machine awaits (block the same way, not HITM): `external_checks` (delivered by `pollChecks`,
`poll-checks.ts:31-55`); `external_pr_result` (data carrier, recorded already-delivered,
`projector.ts:115-122`).

---

## §10 — Changelog

- **2026-07-11 (v2)** — Folded the independent adversarial review (code-verified). Two blockers fixed:
  **(B1)** v1's post-loop terminal enqueues (pr-ready/gave-up) would **never drain** — `drainOutbox`
  runs only inside `tick()` (`loop.ts:49`) — so the notifier would go silent on exactly the success
  terminal it exists for; added an explicit **post-loop `drainOutbox`** (§2). **(B2)** v1's "one
  `appendEvent` hook, zero site edits" was self-defeating — `appendEvent` carries no `rc` and ~11
  escalation callers can't thread it; **replaced with a driver-level sweep** mirroring the telemetry
  emitter (`notifyNewEvents` per-tick + `notifyTerminal` at drive-end), which needs no site edits and
  has `rc` in scope (§2/§3). Consequently **dropped the "same-txn / durable" framing** — notifications
  are honestly post-commit best-effort (fine for a lossy sink; §2/§6), which also resolves v1's
  contradictory "pr-ready is in-txn" claim. **Idempotency key → event `seq`** (v1's `reason`-based key
  over-collapsed signature-less/shared-reason escalations into one lifetime ping; §2). **Fail-loud
  moved to an eager `run.ts` startup check** (a lazy adapter read would surface as a swallowed
  transport error; §4). Engaged the sharper open-core conflict head-on (D3 `brainstorm.md:406` +
  "escalation routing" changelog) and noted the double-notify overlap (§0). Nits: leave the
  `projection_state` CHECK at `schema.sql:460` untouched; per-project `slack` block merges wholesale;
  "17 sites" → 17 reasons / ~11 call sites. Verdict from review: salvageable without re-architecting —
  done. Awaiting operator sign-off.
- **2026-07-11 (v1)** — Initial design. Split settled: outbound notifier + policy → OSS core (Piece
  A, this doc); two-way listener → commercial (Piece C, deferred, meets at the `signal` table via a
  future `styre resolve` verb); durable SoT → Piece B, deferred with two-way. Delivery = **durable
  projection** (Slack = third `projection_outbox` target `notify`), with two deliberate asymmetries:
  notify failures never escalate, and idempotency is event-scoped. Policy = **ordered dial**
  (escalations ⊂ transitions ⊂ everything; baseline includes pr-ready + park + gave-up). Enqueue arch
  = one `appendEvent` hook (covers all 17 escalations + park + transitions) + three explicit enqueues
  for the silent terminals (pr-ready in-txn; no-progress/dead-end best-effort) — the map (§9) exists to
  guarantee those silent terminals aren't dropped. Setup = **bot-token app**, secret in
  `SLACK_BOT_TOKEN`, policy+channel in `config.json` (per-project channel override), fail-loud on
  misconfig. Reopens frozen decision D3 (`brainstorm.md:423`, `minimal-loop.md:181`) for the outbound
  half only. Awaiting independent review + operator sign-off.
