# Configuration

Styre reads two disjoint JSON artifacts. Keep them straight:

- **`config.json`** — operator *policy*: which adapters, which agent, notification and telemetry
  dials. Lives in `$XDG_CONFIG_HOME/styre/`, outside the target repo. Schema:
  `src/config/runtime-config.ts`.
- **`profile.json`** — the probed *project shape*: the repo's components, commands, and runtime
  context, produced by `styre setup`. Lives at `$XDG_CONFIG_HOME/styre/<slug>/profile.json`. Schema:
  `src/dispatch/profile.ts` (`ProfileSchema`).

They never merge into one another. The profile does **not** contribute any runtime-config value, and
config does not contribute any profile value.

---

## Runtime config (`config.json`)

Every top-level key, from `RuntimeConfigSchema` (`src/config/runtime-config.ts`). The schema is
**non-strict**: unknown keys are silently stripped, not rejected — a typo'd key fails silently, so
check spelling against this table.

| Key | Type | Default | Effect |
|---|---|---|---|
| `onPlanDefect` | `"escalate" \| "redesign"` | `"escalate"` | When code review finds a blocking *plan-level* defect: escalate to a human, or loop back to redesign (`src/daemon/review-verdict.ts`). |
| `complexityGrading` | boolean | `false` | Opt-in cold complexity grader for track sizing. Off = deterministic sprawl-only sizing (`src/dispatch/handlers.ts`). |
| `issueTracker` | string | `"linear"` | Which issue-tracker adapter projects ticket state outward. Registered: `linear`, `jira`. An unregistered value throws at startup. Credentials via env. |
| `jira` | object | absent | Jira adapter policy (non-secret). Absent → built-in defaults. |
| `jira.statusMap` | `Record<string, {status, resolution?}>` | built-in map | Maps each neutral `IssueState` to a target Jira status (+ optional resolution). |
| `jira.bugTypeNames` | `string[]` | `["Bug"]` | Issue-type names treated as Bug (case-insensitive); decides `fix/` vs `feat/` branch prefix. |
| `forge` | string | `"github"` | Which forge (code host) adapter handles push/PR. Only `github` is registered. Credentials via env. |
| `telemetry` | boolean | `true` | PostHog adoption analytics. On by default; also honored: `DO_NOT_TRACK` / `STYRE_TELEMETRY` env (a one-way veto). |
| `pricing` | object | built-in price table | Price table + long-context tiers feeding the telemetry `cost_usd_estimated` estimate (see below). Deliberately a **separate top-level key**, not nested under the boolean `telemetry` above. |
| `notifier` | `"none" \| "slack"` | `"none"` | Outbound notifier. `slack` requires `slack.channel` and `SLACK_BOT_TOKEN`; `assertSlackConfigured` fails loud at startup otherwise. |
| `notify` | `"escalations" \| "transitions" \| "everything"` | `"escalations"` | Notification verbosity. `escalations` = escalated/parked only; `transitions` also sends stage transitions; `everything` also sends loopbacks (`src/daemon/notify.ts`). |
| `slack.channel` | string | absent | Target Slack channel; required when `notifier: "slack"`. |
| `agent` | object | absent → Claude preset | The agent provider + per-tier models (see below). |
| `implementDisposition` | `"reject" \| "discard"` | `"reject"` | How `implement` handles undeclared new files. `reject` is today's proven behavior; `discard` opts into the checks-style discard path. The escape hatch, not the norm. |

### The `agent` block

`AgentConfigSchema` (`src/config/agent-config.ts`). When present it is validated in full — there is
no partial inheritance from the binary default (see precedence below).

```jsonc
{
  "agent": {
    "provider": "claude",          // required; "claude" or "codex" are registered
    "command": "claude",           // optional; the CLI binary name
    "models": {                    // all three tiers required when `agent` is present
      "deep": "claude-opus-4-8",
      "standard": "claude-sonnet-4-6",
      "cheap": "claude-haiku-4-5-20251001"
    }
  }
}
```

Absent `agent` → the built-in **Claude preset** (`DEFAULT_AGENT_CONFIG`) shown above. A built-in
**Codex preset** (`CODEX_PRESET`: `gpt-5.4` / `gpt-5.4-codex` / `gpt-5.4-codex-mini`) exists as a
copy-paste template but is **not** auto-selected — you must write the block to use it.

Models are chosen per **tier**, never hardcoded per step. The step→tier map is `src/agent/tiers.ts`:

- **deep** — `design:dispatch`, `design:review`, `review`, `checks:arbitrate`.
- **standard** — `implement:dispatch`, `checks:dispatch`, `checks:classify` (and `implement:dispatch`
  escalates to **deep** on a loopback re-attempt).
- **cheap** — `design:extract`, `design:size`, `docs:revise`, `merge:pr-ensure`.

The provider's auth env var is gated at `styre setup`: `claude → ANTHROPIC_API_KEY`,
`codex → OPENAI_API_KEY` (`requiredEnvFor`). The gate runs in `setup`, not `run`.

### The `pricing` block

`PricingConfigSchema` (`src/telemetry/pricing.ts`). Feeds only the telemetry `cost_usd_estimated`
estimate (`docs/architecture/telemetry-export.md` §4) — it has **no effect on reported `cost_usd`**,
which always comes straight from the provider and is never overwritten by an estimate. It is a
**new top-level key**, deliberately *not* nested under the boolean `telemetry` key above (that key
is the PostHog adoption-analytics toggle; this one is pricing data).

```jsonc
{
  "pricing": {
    "version": "builtin@2026-07-22",   // provenance stamp; surfaced verbatim as `pricing_version`
                                        // on the telemetry summary event
    "rates": {                         // per-model USD per 1M tokens
      "claude-sonnet-4-6": { "input": 3.0, "cacheRead": 0.3, "cacheWrite": 3.75, "output": 15.0 }
      // ... one entry per priced model id
    },
    "tiers": {                         // per-provider long-context multiplier rule
      "codex": { "threshold": 272000, "inputMultiplier": 2, "outputMultiplier": 1.5 }
    }
  }
}
```

- `version` — a free-text provenance stamp for the table in use; defaults to a built-in
  `builtin@<date>` string. Set it when you override `rates`/`tiers` so the telemetry stream records
  that a non-default table produced the estimate.
- `rates` — `Record<model_id, {input, cacheRead, cacheWrite, output}>`, all USD per 1,000,000
  tokens. A model id absent from `rates` yields a `null` estimate for dispatches on that model —
  unpriced, not zero.
- `tiers` — `Record<provider, {threshold, inputMultiplier, outputMultiplier}>`. Above `threshold`
  input tokens, input/output rates (and cache rates, which ride the input multiplier) are scaled for
  that dispatch. Built-in: `codex` at a 272K-token threshold, 2× input / 1.5× output.
- **Because config resolution is a shallow per-top-level-key spread (see Precedence, below),
  `pricing` as a whole — and `pricing.rates` in particular — is replaced wholesale, not deep-merged.**
  An override that sets `pricing.rates` replaces the *entire* built-in rates map; any model id you
  don't restate becomes unpriced (`cost_usd_estimated: null` for it) even though the built-in table
  used to price it. To retune one model's price, copy the full built-in map and change the one entry
  — you cannot patch a single rate in isolation.
- **The token-accounting convention is not configurable.** Which token fields feed the formula, and
  how they're combined per provider (codex's partition-subtract vs. claude's disjoint buckets), is a
  verified structural fact that lives in code (`src/telemetry/pricing.ts`), not in this config block.

---

## Precedence — how config resolves

The real order (`discoverRuntimeConfig`, `src/config/discover.ts`) — not a profile/per-ticket chain:

1. **`--config <path>` is hermetic.** When passed, that file is the *sole* source. The global and
   per-project `config.json` are not read and not merged.
2. **Otherwise, a shallow per-top-level-key spread:** per-project
   `$XDG_CONFIG_HOME/styre/<slug>/config.json` is spread over global
   `$XDG_CONFIG_HOME/styre/config.json`. This is **not** a deep merge — nested objects (`agent`,
   `jira`, `slack`) are replaced **wholesale**. A per-project `agent` block that omits
   `models.cheap` fails zod validation; it does not inherit the global tier.
3. **Zod defaults fill the rest** — the binary-defaults floor (`DEFAULT_RUNTIME_CONFIG`).

Two facts that surprise people:

- **There is no per-ticket config layer and no profile-derived layer.** Nothing reads a
  `styre_config` block from a ticket. A per-ticket layer was scoped to the commercial plane and is
  not built in the OSS core. (`ticket-template.md` says the same.)
- **`DO_NOT_TRACK` / `STYRE_TELEMETRY` override `telemetry: true`** — the one place an env var beats
  a config value. All other env vars are credentials, not config, and never enter `RuntimeConfig`.

Error surfaces differ by path: the merge path wraps a malformed file as
`styre: malformed config at <path>: …`; the `--config` path lets the raw parse/zod error escape.

---

## Project profile (`profile.json`)

`ProfileSchema` (`src/dispatch/profile.ts`), produced by `styre setup`, consumed by `styre run`.
`schemaVersion` is pinned to `3`; a v1 (`commands`) or v2 profile is rejected with a "re-run
`styre setup`" error.

| Key | Type | Notes |
|---|---|---|
| `schemaVersion` | literal `3` | Bumped on breaking profile changes; older versions are rejected, not migrated. |
| `slug` | string | Project slug; drives the profile/config path and the park dir. |
| `targetRepo` | string | Absolute repo path. Overwritten in memory by `--in-place` to the discovered git root. |
| `defaultBranch` | string (`"main"`) | Detected from `origin/HEAD` → current branch → `"main"`. PR base. |
| `analyticsId` | string? | Stable random PostHog `project_id`; never encodes the slug/name. Generated at setup, preserved across `--force`/`--reprobe`. |
| `checksSystem` | `"github" \| "external" \| "none"` | How CI checks are read. Overridable with `styre setup --checks`. |
| `components` | `Component[]` | Detected stack components (see below). Drives verify routing, tool allowlists, provision. |
| `repoCommands` | `Record<string,string>` | Agent-authored repo-level commands; the deterministic scan always emits `{}`. |
| `promptVars` | `Record<string,string>` | Hand-authored only (never written by setup). Spread **last** into every prompt-variable bag, so it can override any computed variable. |
| `runtimeContext` | object | Topology / data / caching / observability / config-secrets / documentation / release-packaging, each a `{presence, detail}` (or enum) tri-state. Probed, then agent-enriched. |

### `Component`

| Field | Type | Notes |
|---|---|---|
| `name` | string (min 1) | Component identifier. |
| `kind` | string (min 1) | Free text (e.g. `backend`, `frontend`, `data`) — not a CHECK enum. |
| `paths` | `string[]` (≥1) | Path globs the component owns. |
| `commands` | `Record<string, string \| {unavailable:true}>` | Build/test/check commands; `{unavailable:true}` marks a deliberately-absent one. |
| `testFilePattern` | string? | Glob for the component's test files. |
| `extensions` | `string[]` | File extensions, for file-identity verify routing (schemaVersion 3). |
| `prepare` | string? | Install command **executed** by the runner-owned `provision` step before the first verify. |
| `dir` | string? | Module root relative to repo root; refined by `isSafeDir` (rejects empty/absolute/`..`). |

At run time, `assertResolved` throws if any component lacks a resolved `build`/`test`/`check`
command — a profile must be command-complete before a run proceeds.
