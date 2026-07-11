# JIRA Issue-Tracker Adapter — Design

**Date:** 2026-07-11
**Status:** Approved design (revised after independent code-grounded review) → feeds implementation plan(s)
**Topic:** Add Atlassian JIRA Cloud as a first-class, config-selected alternative to Linear for issue ingestion and outward projection.

> **Revision note (2026-07-11):** revised after a three-lens independent adversarial review (JIRA-API correctness, Styre-invariants, gap/ambiguity), each grounded in the actual code. The architecture held; adapter-level details were corrected. See "Review dispositions" at the end for the finding-by-finding record.

## Goal

Ship a real, first-class JIRA **Cloud** adapter for the OSS core, at functional parity with the existing Linear adapter — both **inbound** (fetch a ticket to seed the SoT at trigger) and **outbound** (project state / labels back through the projector). JIRA becomes a peer of Linear selected by config (`issueTracker: "jira"`), not a fork or a special case.

## Why this is small: the seam already exists

The issue tracker is already a vendor-neutral abstraction, structurally identical to the `AgentRunner` provider pattern:

- `src/integrations/issue-tracker.ts` — the neutral `IssueTrackerPort` interface (`fetchTicket`, `setState`, `setLabels`, `addComment`), the `IssueTrackerFactory` type, and `selectIssueTracker(config, adapters)` which looks the adapter up **by config name**. Its docstring: *"Mirrors the AgentRunner pattern (src/agent/runner.ts + selectAgentRunner)."*
- `src/integrations/adapters/` — where tracker adapters live (`linear.ts` is the sole vendor-coupled file today; parallels `src/agent/providers/`).
- `src/integrations/ticket-source.ts` — the neutral `IngestedTicket` contract that every adapter's `fetchTicket` maps onto once, at trigger.
- `src/daemon/projector.ts` — drains `projection_outbox` and dispatches by **neutral role** (`issue_tracker` / `forge`), never a vendor name.
- `src/config/runtime-config.ts` — `issueTracker: z.string().default("linear")`; already accepts `"jira"` as a value.

Adding JIRA therefore requires **no change** to the port interface, the projector, the outbox, or the selection logic. It is: write one adapter, register it, make the residual Linear-named env-checks/fields tracker-neutral.

### What the projector actually writes (scope-limiter)

`enqueueStageProjection` (projector.ts:51,58) enqueues exactly two outbox rows on a stage transition: **`set_state`** and **`set_labels`** (the stage-label swap). **`add_comment` is plumbed but never enqueued** — nothing in the codebase produces an `add_comment` row; it exists in the port interface and both adapters (Linear + fake) for parity only, and Linear's `addComment` is implemented-but-dead (a docstring smoke example is its only caller). Consequence: JIRA implements `addComment` for interface parity but it is **not** gold-plated (see §addComment).

## Non-goals

- **JIRA Server / Data Center.** Cloud only (REST v3, Atlassian-hosted `*.atlassian.net`). Server/DC is a possible later adapter, out of scope here.
- **OAuth 2.0 (3LO).** Requires an interactive browser consent flow the headless OSS runner cannot perform. Basic auth via env is the model.
- **The rich plane-owned ticket "contract"** (`styre_config` block, structured AC fields, context-files, "Ready for Agent" trigger). These remain commercial-plane-owned and unbuilt in OSS; the OSS input is title + description + type, with AC checklist parsed from the (ADF-rendered) description string exactly as today.
- **`jira.js` or any 3P JIRA SDK dependency.** jira.js is a REST client only (no ADF conversion) and single-maintainer 3P — same reason we hand-roll the fetch client.
- **A comment-quality push** (markdown→ADF, entity-property idempotency, comment pagination). The `add_comment` path is dead for both trackers; if it is ever wired into the loop, it is solved then, for Linear and JIRA together.
- **A persistent-DB upgrade path for the column rename** — there is no incremental-migration framework (see §Migration reality); the rename is safe for OSS's ephemeral per-run SQLite and out-of-scope for persistent (commercial plane) DBs.

## Decisions

| Area | Decision |
|---|---|
| Target | JIRA **Cloud** only, REST API **v3** (`https://<site>/rest/api/3`). |
| Auth | Basic auth from three env vars: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Missing any → setup error. 401 → a clear "token invalid/expired — regenerate" error (Cloud API tokens now expire). |
| Client | **Hand-rolled `fetch`** — no `jira.js`. A thin `request()` helper: Basic auth header, `Accept`/`Content-Type: application/json`, `Retry-After` honored on 429, JIRA error body (`{errorMessages, errors}`) parsed into the typed error. |
| ADF rendering | **Hand-rolled minimal ADF→markdown** module (one direction, descriptions only). No 3P dep (jira.js doesn't convert; `adf-to-md` drops the task-list node we need). |
| Inbound type | `issuetype.name === "Bug"` → `Bug` (`fix/`); everything else → `Feature` (`feat/`). Match is a small pure helper; optionally overridable (locale/renamed types). `Improvement` is not emitted for JIRA (breaks nothing downstream — verified). |
| setState | **Full model**: probe current status (idempotent) → transitions-with-fields → match → resolution-aware POST → soft-fail + observable signal. See §setState. |
| setLabels | Atomic `update.labels` add/remove verb (no read-merge-PUT); label-safe by construction. |
| addComment | Minimal ADF-paragraph body + best-effort marker dedup. Not gold-plated (dead path). |
| Config | Optional `jira` block in `RuntimeConfigSchema`: `statusMap` (neutral state → `{ status, resolution? }`) and optional `bugTypeNames`. Non-secret. |
| Neutralize | Rename **all five** `linear_*` identifiers to neutral names, in one pass. See §Neutralizing. |
| Touch-ups | Tracker-aware readiness check in `setup.ts`; add `JIRA_API_TOKEN` to `AGENT_ENV_DENYLIST` (one edit covers verify too). |

## Adapter design — `src/integrations/adapters/jira.ts`

Exports `jiraIssueTracker(opts?)` returning an `IssueTrackerPort`. A structural twin of `linear.ts`, registered in `src/daemon/ports.ts` alongside Linear:

```ts
const itAdapters = deps?.issueTracker ?? {
  linear: () => linearIssueTracker(),
  jira: () => jiraIssueTracker(),
};
```

### Connection & auth
Factory reads `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (or `opts` overrides, for tests). Auth header: `Basic base64(email:token)`. A single private `request(method, path, body?)` helper wraps `fetch`: sets the auth header, `Accept: application/json` (and `Content-Type: application/json` on write bodies), honors `Retry-After` on 429, and on non-2xx parses the JIRA error body (`{errorMessages:[], errors:{}}`) into a typed error — with 401 mapped to a clear "token invalid/expired" message. All port methods go through it.

### `fetchTicket(ref)` — inbound
- `ref` is a JIRA issue **key** (e.g. `PROJ-123`); `styre run PROJ-123`. (Verified safe as an `ident` everywhere: `ticket.ident` has no format CHECK, `branch = feat/PROJ-123` is a valid git ref, outbox keys pass it through opaquely. Edge caveat: a project-key rename changes the key mid-flight — rare, out of scope.)
- `GET /issue/{key}?fields=summary,description,issuetype` → map to `IngestedTicket`:
  - `ident` = key; `title` = `summary`; `url` = `<JIRA_BASE_URL>/browse/{key}`.
  - `externalId` = the issue's numeric `id` (stable across project moves; the key is not).
  - `typeLabel` = `issuetype.name === "Bug" ? "Bug" : "Feature"` (pure helper; does **not** use `deriveTypeLabel`, which keys off labels). Bug-name set overridable via `jira.bugTypeNames`.
  - `description` = the ADF `description` document rendered to markdown via the ADF renderer below. In v3 the description is **always** an ADF `doc` or `null` — there is no plain-text branch.

### ADF→markdown renderer — `src/integrations/adapters/jira-adf.ts`
A small, self-contained, **one-direction** renderer (ADF `doc` → markdown string). Purpose: feed `parseAcChecklist`, which needs GFM `- [ ]` / `- [x]`. Node coverage (a documented table + tests):

| ADF node | Markdown |
|---|---|
| `taskList` / `taskItem` (`state: TODO/DONE`) | `- [ ]` / `- [x]` — **load-bearing for AC parsing** |
| `paragraph`, `text` (+ `strong`/`em`/`code`/`link` marks) | text, `**b**`, `*i*`, `` `c` ``, `[t](u)` |
| `bulletList` / `orderedList` / `listItem` | `-` / `1.` items (nested) |
| `heading` | `#`..`######` |
| `codeBlock` | fenced ```` ``` ```` |
| `blockquote`, `rule`, `hardBreak` | `>`, `---`, newline |
| unknown node | best-effort recurse into children / flattened text (never throws) |

Pure and unit-tested against ADF fixtures. Not exported from the adapter's public surface.

### `setState(ref, state)` — outbound, the full model
JIRA cannot set a status directly; it executes a **transition** valid from the issue's current status. The status map converts a neutral `IssueState` to a target `{ status, resolution? }` (defaults below, overridable via `jira.statusMap`).

1. **Probe (idempotent, crash-safe):** `GET /issue/{key}?fields=status`. If the current status name already equals the mapped target → **return** (mirrors linear.ts:99; prevents crash-resume double-moves — CL-3).
2. **List transitions with fields:** `GET /issue/{key}/transitions?expand=transitions.fields` (returns only transitions available from the current status).
3. **Match** the transition whose `to.name` equals the target status name (case-insensitive).
4. **Guard:** if no match, **or** the transition has a required field we cannot satisfy (after supplying the resolution, if any) → **emit a mismatch signal (telemetry / observable) and no-op.** A workflow mismatch must never wedge the loop (loop-not-halt), and the no-op must be diagnosable — not a bare `console.warn` swallowed in a headless run.
5. **Transition:** `POST /issue/{key}/transitions` with `{ transition: { id }, fields: { resolution: { name } } }` when the map entry specifies a resolution. Wrap **the POST** so a `400`/`422` (screen/field rejection) degrades to the same signal + no-op; **transport errors (5xx, 401, network) still throw** and are retried by the outbox drainer. The soft-fail is scoped strictly to the transition-mismatch / field-rejection branch.

Default neutral→target map (keys are the five `IssueState` values):

| Neutral `IssueState` | Default status | Default resolution |
|---|---|---|
| `in_progress` | `In Progress` | — |
| `in_review` | `In Review` | — |
| `done` | `Done` | `Done` |
| `canceled` | `Done` | `Won't Do` |
| `blocked` | `In Progress` | — |

Resolution is applied only if the matched transition's screen offers/requires the field; otherwise it is omitted. Overridable per-project via `jira.statusMap`.

### `setLabels(ref, change)` — outbound
JIRA labels are plain strings with no ids (verified). Use the **atomic** edit verb — no read, no clobber, no race:
`PUT /issue/{key}` with `{ "update": { "labels": [ ...add.map(a => ({add:a})), ...remove.map(r => ({remove:r})) ] } }`. (Edit-issue does not enforce screen config, so labels edit even if off-screen.) Note: JIRA labels cannot contain spaces — the fixed `feat`/`fix` stage labels are safe; any future text-derived label must be slugified.

### `addComment(ref, body, idempotencyKey)` — outbound (minimal, dead-path parity)
Implemented to satisfy the port, mirroring Linear's implemented-but-unused method. `POST /issue/{key}/comment` with `body` wrapped in a minimal ADF paragraph document, plus a visible `proj-key` marker node derived from `idempotencyKey`; dedup by `GET`-ing existing comments and scanning serialized ADF for the marker. **Deliberately not gold-plated** — no markdown→ADF, no entity-property idempotency, no comment-list pagination — because nothing enqueues `add_comment`. A code comment records that if comments are ever wired into the loop, this and Linear's are upgraded together.

## Config — `src/config/runtime-config.ts`

Add an optional, non-secret `jira` block to `RuntimeConfigSchema`:

```ts
jira: z
  .object({
    // neutral IssueState -> target JIRA status (+ optional resolution)
    statusMap: z
      .record(z.object({ status: z.string(), resolution: z.string().optional() }))
      .optional(),
    // issue-type names treated as bugs (default ["Bug"])
    bugTypeNames: z.array(z.string()).optional(),
  })
  .optional(),
```

Absent → built-in defaults. **Config split rationale (explicit):** the connection identity + secret (`JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`) travel together in env as the Basic-auth credential set; non-secret *policy* (`statusMap`, `bugTypeNames`) lives in the `jira` config block. `issueTracker` remains the free-string selection knob; document `"jira"` as supported.

## Neutralizing residual Linear assumptions (all five, one pass)

Per the standing rule to actively remove baked-in vendor assumptions. Rename every vendor-named identifier (all currently vestigial / unread by code except `linear_issue_uuid`, so low-risk):

| Current | Neutral | Where |
|---|---|---|
| `IngestedTicket.linearIssueUuid` | `externalId` | ticket-source.ts:11; **linear.ts:90** (returns it — would not compile otherwise); fake-issue-tracker.ts:14; run-ticket.ts |
| `linear_issue_uuid` column + `linearIssueUuid` param | `external_id` | db/repos/ticket.ts; schema.sql:86 (**both** copies) |
| `project.linear_team_key` | `external_project_key` (or drop) | schema.sql:67 (both copies) |
| `ticket.linear_state` | `external_state` (or drop) | schema.sql:116 (both copies) |
| `linear_id_cache` (table) | `external_id_cache` | schema.sql:445 (both copies) |
| `projection_state.projected_linear_state` | `projected_external_state` | schema.sql:464 (both copies) |

Callers to follow the interface-field rename (caught by `tsc`): **`linear.ts:90`**, `run-ticket.ts`, `fake-issue-tracker.ts`, and the test files `test/cli/park.test.ts`, `park-inplace.test.ts`, `run-e2e.test.ts`, `fetch-ticket.test.ts`, `db/ticket-description.test.ts`, `helpers/run-harness.ts`.

## Migration reality

There is **no incremental-migration framework.** `src/db/migrate.ts` is bootstrap-if-absent: a fresh DB gets the whole `schema.sql`; an existing DB (any `schema_meta` version) returns early and runs nothing. For OSS `styre run` the per-run SQLite is ephemeral, so a column rename is safe and purely mechanical:

1. Edit **both** `schema.sql` copies (`src/db/schema.sql` + `docs/architecture/schema.sql`).
2. Bump the `schema_meta` version and update the hard-coded assertion in `test/migrate.test.ts` (currently `version === 6`).
3. Test that the schema **loads clean** and invariant smoke-tests pass. (No row-preservation claim — there are no persistent OSS rows to preserve.)

Persistent (commercial plane) DBs receive no automatic rename — explicitly out of scope; a plane upgrade path is a separate concern the framework does not yet support.

## Cross-cutting touch-ups

- `src/cli/setup.ts` — readiness check hardcodes `LINEAR_API_KEY`; make it tracker-aware (require the `JIRA_*` trio when `issueTracker === "jira"`, else `LINEAR_API_KEY`).
- `src/agent/agent-env.ts` — add `JIRA_API_TOKEN` to `AGENT_ENV_DENYLIST`. `VERIFY_ENV_DENYLIST` derives from it, so **one edit** covers both spawn and verify scrubbing. Only the token is secret; `JIRA_EMAIL`/`JIRA_BASE_URL` are non-secret identifiers and need no scrubbing.

## Testing

- **Pure/unit:** ADF→markdown renderer against ADF fixtures (task-list mapping first-class); type mapping (`issuetype.name → typeLabel`, incl. `bugTypeNames`); status-map + resolution merge; `to.name` case-insensitive match.
- **API-coupled `setState` orchestration** (probe → transitions-with-fields → match → resolution POST → soft-fail branches): recorded-fixture tests over the `request()` helper (inject a fake fetch), covering the found / not-found / required-field-400 / already-in-target / transport-5xx paths. This is the branchiest surface — it gets explicit coverage, not just "manual smoke."
- **Loop-level:** existing in-memory `fake-issue-tracker` (needs only the `externalId` field rename, no JIRA behavior).
- **Migration:** schema loads clean in both copies; `schema_meta` version bump + `migrate.test.ts` assertion updated.
- **Live smoke** against a real JIRA Cloud scratch project is manual, same posture as Linear.

## Sequencing

Two milestones / PRs, landing in order:

1. **M-jira-1 — Neutralize the vendor fields.** Rename all five `linear_*` identifiers + interface field across type, `linear.ts:90`, repo, both schemas, run-ticket, fake, and the ~7 test files; bump `schema_meta` + fix `migrate.test.ts`. Pure refactor + schema edit; no behavior change. Lands first so the adapter builds on neutral ground.
2. **M-jira-2 — The JIRA adapter.** `jira.ts` (`request` helper + `fetchTicket` + `setState` full model + `setLabels` atomic + minimal `addComment`), the `jira-adf.ts` renderer, register in `ports.ts`, the `jira` config block, tracker-aware `setup.ts`, the denylist edit, and the tests above.

Each milestone is its own branch + PR (feat/ prefix), merged by the operator. No auto-merge.

## Review dispositions (independent review, 2026-07-11)

Three independent code-grounded reviewers (JIRA-API correctness, Styre-invariants, gap/ambiguity). Disposition of every material finding:

**Fixed in this revision**
- setState could wedge on a required-field 400, and had no crash-resume probe → **full model** (probe + transitions-with-fields + soft-fail POST scoped to field/mismatch). (§setState)
- No resolution handling (issues close "unresolved") → **resolution per status-map entry**. (§setState, §Config)
- "Render ADF→markdown" under-scoped; naive renderer silently guts AC parsing → **dedicated `jira-adf.ts` with a task-list-first node table + tests**; dead "plain-text passthrough" branch removed. (§ADF renderer, §fetchTicket)
- Rename list omitted `linear.ts:90`, ~7 test files, `migrate.test.ts` version assertion → **all enumerated**. (§Neutralizing)
- "Migration preserves rows" overstated (no ALTER framework) → **reframed to schema-edit + version bump + loads-clean**; persistent DBs explicitly out of scope. (§Migration reality)
- Soft-fail silently `markSent` → **observable mismatch signal + strict scoping to the mismatch branch**. (§setState)
- Neutralization skipped `linear_team_key` / `linear_state` → **all five renamed in one pass**. (§Neutralizing)
- setLabels read-merge-PUT race → **atomic `update.labels` verb**. (§setLabels)
- "both denylists" redundant → **one edit** (`VERIFY_ENV_DENYLIST` derives). (§Cross-cutting)
- Minor API: 401→"expired" error, `Retry-After`, `Content-Type`, error-body parse → **folded into `request()`**. (§Connection)
- Config split incoherence → **explicit rationale stated**. (§Config)
- Comment idempotency/ADF/pagination concerns → **de-scoped**: `add_comment` is a dead path for both trackers; minimal parity only. (§addComment)

**Verified safe — no action (recorded so it isn't re-litigated)**
- One-way projection holds: `fetchTicket` only at trigger; the probe GETs live inside the outbound write path, never feed a control decision.
- `PROJ-123` is safe as an `ident` everywhere (no format CHECK; valid branch ref; opaque outbox keys).
- Dropping `Improvement` for JIRA breaks nothing (only Linear's label path uses it; keep it in the CHECK enum).
- Dual-schema correctly identified (`linear_issue_uuid` at line 86 in both copies).
- Config selection + registration point (`ports.ts:21`) correct; `issueTracker` free-string already accepts `"jira"`.
