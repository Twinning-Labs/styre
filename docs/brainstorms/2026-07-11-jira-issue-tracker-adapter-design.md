# JIRA Issue-Tracker Adapter — Design

**Date:** 2026-07-11
**Status:** Approved design → feeds implementation plan(s)
**Topic:** Add Atlassian JIRA Cloud as a first-class, config-selected alternative to Linear for issue ingestion and outward projection.

## Goal

Ship a real, first-class JIRA **Cloud** adapter for the OSS core, at functional parity with the existing Linear adapter — both **inbound** (fetch a ticket to seed the SoT at trigger) and **outbound** (project state / labels / comments back through the projector). JIRA becomes a peer of Linear selected by config (`issueTracker: "jira"`), not a fork or a special case.

## Why this is small: the seam already exists

The issue tracker is already a vendor-neutral abstraction, structurally identical to the `AgentRunner` provider pattern:

- `src/integrations/issue-tracker.ts` — the neutral `IssueTrackerPort` interface (`fetchTicket`, `setState`, `setLabels`, `addComment`), the `IssueTrackerFactory` type, and `selectIssueTracker(config, adapters)` which looks the adapter up **by config name**. Its docstring: *"Mirrors the AgentRunner pattern (src/agent/runner.ts + selectAgentRunner)."*
- `src/integrations/adapters/` — where tracker adapters live (`linear.ts` is the sole vendor-coupled file today; parallels `src/agent/providers/`).
- `src/integrations/ticket-source.ts` — the neutral `IngestedTicket` contract that every adapter's `fetchTicket` maps onto once, at trigger.
- `src/daemon/projector.ts` — drains `projection_outbox` and dispatches by **neutral role** (`issue_tracker` / `forge`), never a vendor name.
- `src/config/runtime-config.ts` — `issueTracker: z.string().default("linear")`; already accepts `"jira"` as a value.

Adding JIRA therefore requires **no change** to the port interface, the projector, the outbox, or the selection logic. It is: write one adapter, register it, make the residual Linear-named env-checks/fields tracker-neutral.

## Non-goals

- **JIRA Server / Data Center.** Cloud only (REST v3, Atlassian-hosted `*.atlassian.net`). Server/DC is a possible later adapter, out of scope here.
- **OAuth 2.0 (3LO).** Requires an interactive browser consent flow the headless OSS runner cannot perform. Basic auth via env is the model.
- **The rich plane-owned ticket "contract"** (`styre_config` block, structured AC fields, context-files, "Ready for Agent" trigger). These remain commercial-plane-owned and unbuilt in OSS; the OSS input is title + description + type, with AC checklist parsed from the description string exactly as today.
- **`jira.js` or any 3P JIRA SDK dependency.** See "Client" below.

## Decisions

| Area | Decision |
|---|---|
| Target | JIRA **Cloud** only, REST API **v3** (`https://<site>/rest/api/3`). |
| Auth | Basic auth from three env vars: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Missing any → setup error, mirroring Linear. |
| Client | **Hand-rolled `fetch`** — no `jira.js`. Cloud-only v3 + Basic auth is a thin request helper; avoids a single-maintainer 3P dependency in a repo that prizes being a clean plug-in target. |
| Inbound type | `Bug → Bug` (branch prefix `fix/`); every other issue type → `Feature` (`feat/`). The `Improvement` label is not emitted for JIRA. |
| setState | Transition-based (see below); default neutral→status-name map; **soft-fail** on unreachable target. |
| setLabels | Plain string `labels` field; label-safe delta (add/remove), no id resolution. |
| addComment | ADF body; dedup by a `proj-key` marker probed against existing comments. |
| Config | Optional `jira` block in `RuntimeConfigSchema` for non-secret status-map overrides. |
| Neutralize | Rename `IngestedTicket.linearIssueUuid → externalId` and the `linear_*` DB columns; in scope. |
| Touch-ups | Tracker-aware readiness check in `setup.ts`; add `JIRA_API_TOKEN` to both env denylists. |

## Adapter design — `src/integrations/adapters/jira.ts`

Exports `jiraIssueTracker(opts?)` returning an `IssueTrackerPort`. A structural twin of `linear.ts`, registered in `src/daemon/ports.ts` alongside Linear:

```ts
const itAdapters = deps?.issueTracker ?? {
  linear: () => linearIssueTracker(),
  jira: () => jiraIssueTracker(),
};
```

### Connection & auth
Factory reads `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (or `opts` overrides, for tests). Auth header: `Basic base64(email:token)`. A single private `request(method, path, body?)` helper wraps `fetch`, sets auth + `Accept: application/json`, and throws a typed error on non-2xx. All four port methods go through it.

### `fetchTicket(ref)` — inbound
- `ref` is a JIRA issue **key** (e.g. `PROJ-123`); `styre run PROJ-123`.
- `GET /issue/{key}?fields=summary,description,issuetype` → map to `IngestedTicket`:
  - `ident` = key
  - `title` = `summary`
  - `description` = the description field rendered to markdown (JIRA v3 descriptions are ADF; render ADF → markdown so the existing `parseAcChecklist` sees GFM task-list items). If the site returns plain text, pass through.
  - `typeLabel` = `issuetype.name === "Bug" ? "Bug" : "Feature"` (pure helper; does **not** use `deriveTypeLabel`, which keys off labels).
  - `externalId` = the issue's numeric `id`.
  - `url` = `<JIRA_BASE_URL>/browse/{key}`.

### `setState(ref, state)` — outbound, the hard one
JIRA cannot set a status directly; it must execute a **transition** valid from the issue's current status.

1. Map the neutral `IssueState` to a target JIRA **status name** via the status map (defaults below, overridable via config).
2. `GET /issue/{key}/transitions` → the transitions available from the current status.
3. Find the transition whose `to.name` matches the target status name (case-insensitive).
4. If found: `POST /issue/{key}/transitions` with `{ transition: { id } }`.
5. If **not** found (custom workflow, or target unreachable from current status): **log a warning and no-op.** A workflow mismatch must never wedge the loop (loop-not-halt).

Default neutral→status-name map (keys are the five `IssueState` values):

| Neutral `IssueState` | Default JIRA status |
|---|---|
| `in_progress` | `In Progress` |
| `in_review` | `In Review` |
| `done` | `Done` |
| `canceled` | `Done` |
| `blocked` | `In Progress` |

Overridable per-project via the `jira.statusMap` config block.

### `setLabels(ref, change)` — outbound
JIRA labels are plain strings on the `labels` array field (no ids, no colors — simpler than Linear). Label-safe delta: `GET` current labels, compute `(current ∪ add) \ remove`, `PUT /issue/{key}` with the merged set. Never clobbers labels outside the delta.

### `addComment(ref, body, idempotencyKey)` — outbound
- v3 comment bodies are **ADF** (JSON), not markdown. Wrap `body` in a minimal ADF document (paragraph nodes), plus a marker node/line carrying the `proj-key` derived from `idempotencyKey`.
- Idempotency: `GET /issue/{key}/comment`, scan existing comment bodies for the `proj-key` marker; if present, return its id without posting (mirrors Linear's hidden-tag dedup). Else `POST` and return the new id.

## Config — `src/config/runtime-config.ts`

Add an optional, non-secret `jira` block to `RuntimeConfigSchema`:

```ts
jira: z
  .object({
    statusMap: z.record(z.string()).optional(), // neutral IssueState -> JIRA status name
  })
  .optional(),
```

Absent → built-in defaults. Secrets (`JIRA_*`) stay in env, never in config. `issueTracker` remains the free-string selection knob; document `"jira"` as a supported value.

## Neutralizing residual Linear assumptions (in scope)

Per the standing rule to actively remove baked-in vendor assumptions, not just avoid new ones:

- `src/integrations/ticket-source.ts:11` — rename `linearIssueUuid → externalId` on `IngestedTicket`.
- `src/db/repos/ticket.ts` — rename the `linearIssueUuid` param / `linear_issue_uuid` column to `external_id`.
- `src/db/schema.sql` **and** `docs/architecture/schema.sql` (both copies — dual-schema rule) — rename `linear_issue_uuid` and related `linear_*` columns/table to neutral names; add a migration.
- `src/daemon/run-ticket.ts` and `src/integrations/adapters/fake-issue-tracker.ts` — follow the field rename.

Deliberately out of this pass (deferred optimizations, not read by code): the `linear_id_cache` table and `projection_state.projected_linear_state` are noted but only renamed opportunistically if the migration already touches them.

## Cross-cutting touch-ups

- `src/cli/setup.ts` — the readiness check currently hardcodes `LINEAR_API_KEY`. Make it tracker-aware: when `issueTracker === "jira"`, require the `JIRA_*` trio; else require `LINEAR_API_KEY`.
- `src/agent/agent-env.ts` (`AGENT_ENV_DENYLIST`) and `src/util/run-command.ts` (verifyEnv scrub) — add `JIRA_API_TOKEN` so the credential never leaks into the agent spawn. (Email/base URL are non-secret but may be scrubbed too for tidiness.)

## Testing

- **Pure helpers unit-tested** like Linear's: type mapping (`issuetype.name → typeLabel`), the neutral→status-name map + override merge, transition matching (`to.name` case-insensitive), the ADF wrapper, and `proj-key` comment tagging/probe.
- **Loop-level tests** use the existing in-memory `fake-issue-tracker`; no change needed.
- **Migration test**: the `external_id` rename loads clean and preserves existing rows (schema smoke test, both schema copies).
- **Live smoke** against a real JIRA Cloud scratch project is manual, same posture as Linear.

## Sequencing (for the plan step)

Likely two milestones / PRs, landing in order:

1. **M-jira-1 — Neutralize the field.** `linearIssueUuid → externalId` across type, repo, schema (both copies + migration), run-ticket, fake. Pure refactor + migration; no behavior change. Lands first so the adapter builds on neutral ground.
2. **M-jira-2 — The JIRA adapter.** `jira.ts` (all four methods + `request` helper + pure helpers), register in `ports.ts`, `jira` config block, tracker-aware `setup.ts`, denylist additions, tests.

Each milestone is its own branch + PR (feat/ prefix), merged by the operator. No auto-merge.
