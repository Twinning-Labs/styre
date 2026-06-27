# PostHog Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add anonymized, opt-out product analytics to the `styre` OSS binary, sending a small curated set of events (`setup_completed`, `run_started`, `run_completed`, `cli_error`) to PostHog US Cloud.

**Architecture:** A self-contained `src/telemetry/analytics/` module fired from the CLI command layer (`setup.ts`, `run.ts`) — *not* the open-core NDJSON `TelemetrySink`. The engine/daemon never import it. A single allow-list chokepoint (`properties.ts`) builds every event's property bag, so no summary/profile field can leak. Identity is two auto-persisted random UUIDs: `distinct_id` in `~/.local/state/styre/telemetry.json`, `analyticsId` (sent as `project_id`) in `profile.json`. Disabled → a no-op object that touches neither disk nor network.

**Tech Stack:** Bun + TypeScript (strict), zod, citty, `posthog-node` (new dep), `bun test`, biome.

Design source of truth: `docs/brainstorms/2026-06-26-posthog-analytics-design.md`.

## Global Constraints

- **Runtime:** Bun. Tests: `bun test`. Lint: `biome check .`. Typecheck: `tsc --noEmit`.
- **Only one new dependency:** `posthog-node` (^4). No other deps added.
- **Telemetry must never affect the run.** Every analytics call is wrapped so it cannot throw, block, or change an exit code. Network/transport errors are swallowed. Only `shutdown()` is awaited, bounded to ~2s.
- **stdout is reserved for the NDJSON telemetry stream.** All human text — including the first-run notice — goes to **stderr** (`console.error` / `process.stderr.write`).
- **Opt-out resolution (off if ANY says off):** `DO_NOT_TRACK` env set to anything other than `""`/`"0"`/`"false"` → off; `STYRE_TELEMETRY` in {`"0"`,`"false"`} → off; runtime config `telemetry: false` → off; else on.
- **No PII / proprietary data on the wire.** Never send: raw ticket idents, repo paths, commands, branch SHAs, failure signatures, raw escalation text, cost, or tokens. Only the allow-listed coarse properties in `properties.ts`.
- **Host:** `https://us.i.posthog.com` (US Cloud).
- **PostHog project API key** is a write-only client key compiled into the binary (visible in OSS source — expected). It is the single operator-provided value (see Task 4); paste the real key there.
- **No fleet/CI identity provisioning.** No `STYRE_ANON_ID`. CI persistence is achieved by caching `~/.local/state/styre/` (a docs note, not code).
- All new code is TypeScript with explicit types; validate external JSON with zod where parsed.

## File Structure

| File | Responsibility |
|---|---|
| `src/telemetry/analytics/consent.ts` (create) | Resolve enabled/disabled from env + config |
| `src/telemetry/analytics/id.ts` (create) | Read-or-create `distinct_id` + notice flag in `~/.local/state/styre/telemetry.json` |
| `src/telemetry/analytics/properties.ts` (create) | **Allow-list chokepoint:** super-props, bucketers, failure-bucket map, summary→props |
| `src/telemetry/analytics/client.ts` (create) | `posthog-node` wrapper: `capture` + bounded `shutdown`, fail-silent |
| `src/telemetry/analytics/index.ts` (create) | `createAnalytics(config, deps?)` → reporter or no-op; owns first-run notice |
| `src/config/runtime-config.ts` (modify) | Add `telemetry: boolean` flag (default true) |
| `src/dispatch/profile.ts` (modify) | Add optional `analyticsId` UUID field |
| `src/cli/setup.ts` (modify) | Generate/preserve `analyticsId`; fire `setup_completed` |
| `src/cli/run.ts` (modify) | Fire `run_started` / `run_completed` / `cli_error`; bounded `shutdown` |
| `package.json` (modify) | Add `posthog-node` |
| `README.md` (modify) | Telemetry + opt-out section |
| `test/telemetry/analytics/*.test.ts` (create) | Unit tests per module |

---

### Task 1: Consent resolution + config flag

**Files:**
- Modify: `src/config/runtime-config.ts`
- Create: `src/telemetry/analytics/consent.ts`
- Test: `test/telemetry/analytics/consent.test.ts`

**Interfaces:**
- Produces: `telemetryEnabled(config: { telemetry: boolean }): boolean`
- Produces (config): `RuntimeConfig.telemetry: boolean` (default `true`)

- [ ] **Step 1: Add the config flag.** In `src/config/runtime-config.ts`, add to the `RuntimeConfigSchema` object (after `forge`):

```typescript
  // OSS adoption analytics (PostHog). On by default; honors DO_NOT_TRACK / STYRE_TELEMETRY too.
  telemetry: z.boolean().default(true),
```

- [ ] **Step 2: Write the failing test** `test/telemetry/analytics/consent.test.ts`:

```typescript
import { afterEach, expect, test } from "bun:test";
import { telemetryEnabled } from "../../../src/telemetry/analytics/consent.ts";

const ENV_KEYS = ["DO_NOT_TRACK", "STYRE_TELEMETRY"] as const;
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

test("enabled by default when config.telemetry is true and no env set", () => {
  expect(telemetryEnabled({ telemetry: true })).toBe(true);
});

test("config.telemetry=false disables", () => {
  expect(telemetryEnabled({ telemetry: false })).toBe(false);
});

test("DO_NOT_TRACK=1 disables; DO_NOT_TRACK=0 does not", () => {
  process.env.DO_NOT_TRACK = "1";
  expect(telemetryEnabled({ telemetry: true })).toBe(false);
  process.env.DO_NOT_TRACK = "0";
  expect(telemetryEnabled({ telemetry: true })).toBe(true);
});

test("STYRE_TELEMETRY=0 disables", () => {
  process.env.STYRE_TELEMETRY = "0";
  expect(telemetryEnabled({ telemetry: true })).toBe(false);
});
```

- [ ] **Step 3: Run it, expect FAIL** (`telemetryEnabled` not defined):

Run: `bun test test/telemetry/analytics/consent.test.ts`
Expected: FAIL — cannot find module / `telemetryEnabled is not a function`.

- [ ] **Step 4: Implement** `src/telemetry/analytics/consent.ts`:

```typescript
/** Resolve whether OSS analytics is on. Off if ANY opt-out source says off. Honors the
 *  DO_NOT_TRACK standard (any value other than ""/"0"/"false") and STYRE_TELEMETRY=0. */
export function telemetryEnabled(config: { telemetry: boolean }): boolean {
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt !== undefined && dnt !== "" && dnt !== "0" && dnt !== "false") return false;
  const styre = process.env.STYRE_TELEMETRY;
  if (styre === "0" || styre === "false") return false;
  return config.telemetry !== false;
}
```

- [ ] **Step 5: Run it, expect PASS.** `bun test test/telemetry/analytics/consent.test.ts`

- [ ] **Step 6: Commit.**

```bash
git add src/config/runtime-config.ts src/telemetry/analytics/consent.ts test/telemetry/analytics/consent.test.ts
git commit -m "feat(analytics): telemetry config flag + consent resolution"
```

---

### Task 2: Anonymous ID persistence

**Files:**
- Create: `src/telemetry/analytics/id.ts`
- Test: `test/telemetry/analytics/id.test.ts`

**Interfaces:**
- Consumes: `stateDir()` from `src/config/paths.ts`.
- Produces:
  - `interface TelemetryState { distinctId: string; noticeShown: boolean }`
  - `loadOrCreateState(): TelemetryState` — reads `~/.local/state/styre/telemetry.json`; creates+persists a random UUID on first use.
  - `markNoticeShown(state: TelemetryState): void` — persists `noticeShown: true`.

- [ ] **Step 1: Write the failing test** `test/telemetry/analytics/id.test.ts`. (Override `XDG_STATE_HOME` to a temp dir so the real home is untouched.)

```typescript
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  loadOrCreateState,
  markNoticeShown,
} from "../../../src/telemetry/analytics/id.ts";

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "styre-id-"));
});
afterEach(() => {
  if (prev === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prev;
});

test("first call creates a UUID and persists it; second call reuses it", () => {
  const a = loadOrCreateState();
  expect(a.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.noticeShown).toBe(false);
  const b = loadOrCreateState();
  expect(b.distinctId).toBe(a.distinctId);
});

test("markNoticeShown persists the flag", () => {
  const s = loadOrCreateState();
  markNoticeShown(s);
  const file = join(process.env.XDG_STATE_HOME as string, "styre", "telemetry.json");
  expect(JSON.parse(readFileSync(file, "utf8")).noticeShown).toBe(true);
  expect(loadOrCreateState().noticeShown).toBe(true);
});
```

- [ ] **Step 2: Run it, expect FAIL.** `bun test test/telemetry/analytics/id.test.ts`

- [ ] **Step 3: Implement** `src/telemetry/analytics/id.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../config/paths.ts";

export interface TelemetryState {
  distinctId: string;
  noticeShown: boolean;
}

function file(): string {
  return join(stateDir(), "telemetry.json");
}

function write(state: TelemetryState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(state, null, 2)}\n`);
}

/** Read the persisted anonymous identity, or mint + persist one on first use. The distinct_id is a
 *  random UUID — never derived from machine/user/repo/key. */
export function loadOrCreateState(): TelemetryState {
  const p = file();
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as Partial<TelemetryState>;
      if (typeof s.distinctId === "string" && s.distinctId.length > 0) {
        return { distinctId: s.distinctId, noticeShown: Boolean(s.noticeShown) };
      }
    } catch {
      // corrupt file — fall through and regenerate
    }
  }
  const fresh: TelemetryState = { distinctId: randomUUID(), noticeShown: false };
  write(fresh);
  return fresh;
}

export function markNoticeShown(state: TelemetryState): void {
  if (!state.noticeShown) write({ ...state, noticeShown: true });
}
```

- [ ] **Step 4: Run it, expect PASS.** `bun test test/telemetry/analytics/id.test.ts`

- [ ] **Step 5: Commit.**

```bash
git add src/telemetry/analytics/id.ts test/telemetry/analytics/id.test.ts
git commit -m "feat(analytics): persist anonymous distinct_id in XDG state"
```

---

### Task 3: Property builders (the allow-list chokepoint)

**Files:**
- Create: `src/telemetry/analytics/properties.ts`
- Test: `test/telemetry/analytics/properties.test.ts`

**Interfaces:**
- Consumes: `VERSION` from `src/version.ts`; the summary type `Extract<TelemetryEvent, { type: "summary" }>` from `src/telemetry/events.ts` (call it `SummaryEvent`).
- Produces (every return value is a plain object whose keys are a fixed, enumerated allow-list):
  - `superProperties(): Record<string, unknown>` — `{ styre_version, os, arch, ci }`
  - `bucket(n: number): string`
  - `durationBucket(ms: number): string`
  - `failureBucket(outcome: string, escalationReasons: string[]): string | null`
  - `setupProperties(p): Record<string, unknown>`
  - `runStartedProperties(p): Record<string, unknown>`
  - `runCompletedProperties(summary: SummaryEvent, durationMs: number, config): Record<string, unknown>`
  - `cliErrorProperties(p): Record<string, unknown>`
  - `ALLOWED_KEYS: ReadonlySet<string>` — the union of every property name any builder may emit (for the guard test and a runtime assertion).

- [ ] **Step 1: Write the failing test** `test/telemetry/analytics/properties.test.ts`:

```typescript
import { expect, test } from "bun:test";
import type { TelemetryEvent } from "../../../src/telemetry/events.ts";
import {
  ALLOWED_KEYS,
  bucket,
  cliErrorProperties,
  durationBucket,
  failureBucket,
  runCompletedProperties,
  runStartedProperties,
  setupProperties,
  superProperties,
} from "../../../src/telemetry/analytics/properties.ts";

type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;

function summary(partial: Partial<SummaryEvent>): SummaryEvent {
  return {
    schema_version: 1,
    type: "summary",
    ticket_id: 1,
    ident: "ENG-1",
    outcome: "pr-ready",
    stage: "merge",
    status: "waiting",
    ticks: 7,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_create: 0,
    dispatch_count: 3,
    dispatch_outcomes: { "clean-success": 3 },
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
    ...partial,
  };
}

test("bucket and durationBucket map to coarse strings", () => {
  expect(bucket(3)).toBe("1-5");
  expect(bucket(40)).toBe("21-50");
  expect(bucket(99)).toBe("50+");
  expect(durationBucket(2 * 60_000)).toBe("<5m");
  expect(durationBucket(90 * 60_000)).toBe(">60m");
});

test("failureBucket: success → null; parked → parked-credits; keyword maps blocked", () => {
  expect(failureBucket("pr-ready", [])).toBeNull();
  expect(failureBucket("parked", [])).toBe("parked-credits");
  expect(failureBucket("no-progress", [])).toBe("no-progress");
  expect(failureBucket("blocked", ["plan defect found in design"])).toBe("plan-defect");
  expect(failureBucket("blocked", ["something weird"])).toBe("unknown");
});

test("run_completed derives first_time_ci_pass and autonomous_fix from dispatch_outcomes", () => {
  const clean = runCompletedProperties(summary({}), 1000, { complexityGrading: false, onPlanDefect: "escalate" });
  expect(clean.first_time_ci_pass).toBe(true);
  expect(clean.autonomous_fix).toBe(false);
  expect(clean.terminal_stage).toBe("merge");

  const recovered = runCompletedProperties(
    summary({ dispatch_outcomes: { "build-red": 1, "clean-success": 2 } }),
    1000,
    { complexityGrading: false, onPlanDefect: "escalate" },
  );
  expect(recovered.first_time_ci_pass).toBe(false);
  expect(recovered.autonomous_fix).toBe(true);
});

test("ALLOW-LIST GUARD: every builder emits only allow-listed keys", () => {
  const bags: Record<string, unknown>[] = [
    superProperties(),
    setupProperties({ projectId: "p", checksSystem: "github", componentCount: 2, componentKinds: ["backend"], stackBucket: "node", topologyType: "web-service" }),
    runStartedProperties({ projectId: "p", resumed: false, tracker: "linear", forge: "github" }),
    runCompletedProperties(summary({ outcome: "blocked", escalation_reasons: ["budget exhausted"] }), 5000, { complexityGrading: true, onPlanDefect: "redesign" }),
    cliErrorProperties({ command: "run", exitCode: 1, errorClass: "TypeError" }),
  ];
  for (const bag of bags) {
    for (const key of Object.keys(bag)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  }
});

test("cli_error never carries a message field", () => {
  const bag = cliErrorProperties({ command: "run", exitCode: 1, errorClass: "Error" });
  expect("message" in bag).toBe(false);
});
```

- [ ] **Step 2: Run it, expect FAIL.** `bun test test/telemetry/analytics/properties.test.ts`

- [ ] **Step 3: Implement** `src/telemetry/analytics/properties.ts`:

```typescript
import type { TelemetryEvent } from "../events.ts";
import { VERSION } from "../../version.ts";

type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;

/** Dispatch outcomes that mean a unit went red and needed rework. */
const RED_OUTCOMES = ["build-red", "reviewer-blocking", "dispatch-failed"];

function isCi(): boolean {
  const ci = process.env.CI;
  return ci === "true" || ci === "1" || Boolean(process.env.GITHUB_ACTIONS);
}

/** Shared properties on every event. distinct_id is NOT here — it is the capture identity. */
export function superProperties(): Record<string, unknown> {
  return {
    styre_version: VERSION,
    os: process.platform, // 'darwin' | 'linux'
    arch: process.arch, // 'arm64' | 'x64'
    ci: isCi(),
  };
}

export function bucket(n: number): string {
  if (n <= 5) return "1-5";
  if (n <= 20) return "6-20";
  if (n <= 50) return "21-50";
  return "50+";
}

export function durationBucket(ms: number): string {
  const m = ms / 60_000;
  if (m < 5) return "<5m";
  if (m < 15) return "5-15m";
  if (m < 60) return "15-60m";
  return ">60m";
}

/** Map outcome + free-text escalation reasons to a FIXED enum. The raw text never leaves here. */
export function failureBucket(outcome: string, escalationReasons: string[]): string | null {
  if (outcome === "pr-ready" || outcome === "done") return null;
  if (outcome === "parked") return "parked-credits";
  if (outcome === "no-progress") return "no-progress";
  // outcome === "blocked": classify by keyword against the joined reasons (never sent raw).
  const hay = escalationReasons.join(" ").toLowerCase();
  if (/budget|token|limit|exhaust/.test(hay)) return "budget-exhausted";
  if (/plan/.test(hay)) return "plan-defect";
  if (/review|blocking/.test(hay)) return "reviewer-blocking";
  if (/build|test|\bci\b|red/.test(hay)) return "build-red-persistent";
  if (/scope/.test(hay)) return "scope-violation";
  if (/human|gate|approval|merge/.test(hay)) return "human-gate";
  if (/dispatch/.test(hay)) return "dispatch-failed";
  return "unknown";
}

export interface SetupInput {
  projectId: string;
  checksSystem: string;
  componentCount: number;
  componentKinds: string[];
  stackBucket: string;
  topologyType: string;
}
export function setupProperties(p: SetupInput): Record<string, unknown> {
  return {
    project_id: p.projectId,
    checks_system: p.checksSystem,
    component_count: p.componentCount,
    component_kinds: p.componentKinds,
    stack_bucket: p.stackBucket,
    topology_type: p.topologyType,
  };
}

export interface RunStartedInput {
  projectId: string;
  resumed: boolean;
  tracker: string;
  forge: string;
}
export function runStartedProperties(p: RunStartedInput): Record<string, unknown> {
  return {
    project_id: p.projectId,
    resumed: p.resumed,
    tracker: p.tracker,
    forge: p.forge,
  };
}

export function runCompletedProperties(
  summary: SummaryEvent,
  durationMs: number,
  config: { complexityGrading: boolean; onPlanDefect: string },
): Record<string, unknown> {
  const hadRed = RED_OUTCOMES.some((k) => (summary.dispatch_outcomes[k] ?? 0) > 0);
  const success = summary.outcome === "pr-ready";
  return {
    outcome: summary.outcome,
    terminal_stage: summary.stage,
    ticks_bucket: bucket(summary.ticks),
    dispatch_count_bucket: bucket(summary.dispatch_count),
    cycle_count_bucket: bucket(summary.cycle_count),
    duration_bucket: durationBucket(durationMs),
    first_time_ci_pass: success && !hadRed,
    autonomous_fix: success && hadRed && summary.escalation_count === 0,
    failure_bucket: failureBucket(summary.outcome, summary.escalation_reasons),
    complexity_grading: config.complexityGrading,
    on_plan_defect: config.onPlanDefect,
  };
}

export interface CliErrorInput {
  command: string;
  exitCode: number;
  errorClass: string;
}
export function cliErrorProperties(p: CliErrorInput): Record<string, unknown> {
  return {
    command: p.command,
    exit_code: p.exitCode,
    error_class: p.errorClass,
  };
}

/** The complete allow-list of property keys any builder may emit. Used by the guard test and the
 *  runtime assertion in index.ts. Adding a property REQUIRES adding it here. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // super properties
  "styre_version", "os", "arch", "ci",
  // setup_completed
  "project_id", "checks_system", "component_count", "component_kinds", "stack_bucket", "topology_type",
  // run_started
  "resumed", "tracker", "forge",
  // run_completed
  "outcome", "terminal_stage", "ticks_bucket", "dispatch_count_bucket", "cycle_count_bucket",
  "duration_bucket", "first_time_ci_pass", "autonomous_fix", "failure_bucket",
  "complexity_grading", "on_plan_defect",
  // cli_error
  "exit_code", "error_class", "command",
]);
```

- [ ] **Step 4: Run it, expect PASS.** `bun test test/telemetry/analytics/properties.test.ts`

- [ ] **Step 5: Commit.**

```bash
git add src/telemetry/analytics/properties.ts test/telemetry/analytics/properties.test.ts
git commit -m "feat(analytics): allow-listed property builders + buckets + failure map"
```

---

### Task 4: PostHog client wrapper

**Files:**
- Modify: `package.json` (add dep)
- Create: `src/telemetry/analytics/client.ts`
- Test: `test/telemetry/analytics/client.test.ts`

**Interfaces:**
- Produces:
  - `interface AnalyticsClient { capture(distinctId: string, event: string, properties: Record<string, unknown>): void; shutdown(): Promise<void> }`
  - `createPosthogClient(): AnalyticsClient`
  - `POSTHOG_HOST`, `POSTHOG_TOKEN` constants.

- [ ] **Step 1: Add the dependency.**

Run: `bun add posthog-node`
Expected: `package.json` gains `"posthog-node": "^4.x"` under dependencies; `bun.lock` updated.

- [ ] **Step 2: Write the failing test** `test/telemetry/analytics/client.test.ts`. (We do not hit the network; we assert the wrapper constructs and that `capture`/`shutdown` never throw, and that `shutdown` is bounded.)

```typescript
import { expect, test } from "bun:test";
import { createPosthogClient } from "../../../src/telemetry/analytics/client.ts";

test("client constructs; capture never throws; shutdown resolves within the bound", async () => {
  const client = createPosthogClient();
  expect(() => client.capture("anon-1", "test_event", { ok: true })).not.toThrow();
  const start = Date.now();
  await client.shutdown();
  expect(Date.now() - start).toBeLessThan(3000);
});
```

- [ ] **Step 3: Run it, expect FAIL.** `bun test test/telemetry/analytics/client.test.ts`

- [ ] **Step 4: Implement** `src/telemetry/analytics/client.ts`. **Paste the real PostHog project API key** into `POSTHOG_TOKEN` (write-only client key from your PostHog project settings — this is the one operator-provided value).

```typescript
import { PostHog } from "posthog-node";

/** PostHog US Cloud ingestion host. */
export const POSTHOG_HOST = "https://us.i.posthog.com";
/** Write-only project API key — safe to ship in the OSS binary. REPLACE with your project key. */
export const POSTHOG_TOKEN = "phc_REPLACE_WITH_PROJECT_KEY";

const FLUSH_TIMEOUT_MS = 2000;

export interface AnalyticsClient {
  capture(distinctId: string, event: string, properties: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

/** A fail-silent posthog-node wrapper tuned for a short-lived CLI. Errors never surface; only
 *  shutdown() is awaited, bounded so a slow network can never hang the process. */
export function createPosthogClient(): AnalyticsClient {
  const ph = new PostHog(POSTHOG_TOKEN, {
    host: POSTHOG_HOST,
    flushAt: 1, // short-lived process: send promptly
    flushInterval: 0, // no background timer
  });
  return {
    capture(distinctId, event, properties) {
      try {
        ph.capture({ distinctId, event, properties });
      } catch {
        // never let telemetry throw into the CLI
      }
    },
    async shutdown() {
      await Promise.race([
        ph.shutdown().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    },
  };
}
```

- [ ] **Step 5: Run it, expect PASS.** `bun test test/telemetry/analytics/client.test.ts`

(Note: with the placeholder token the event is rejected server-side, which is fine — the wrapper swallows it. The test asserts no throw + bounded shutdown, not delivery.)

- [ ] **Step 6: Commit.**

```bash
git add package.json bun.lock src/telemetry/analytics/client.ts test/telemetry/analytics/client.test.ts
git commit -m "feat(analytics): fail-silent posthog-node client wrapper"
```

---

### Task 5: Reporter assembly (`createAnalytics`) + first-run notice

**Files:**
- Create: `src/telemetry/analytics/index.ts`
- Test: `test/telemetry/analytics/index.test.ts`

**Interfaces:**
- Consumes: `telemetryEnabled` (Task 1), `loadOrCreateState`/`markNoticeShown` (Task 2), all builders + `ALLOWED_KEYS` (Task 3), `AnalyticsClient`/`createPosthogClient` (Task 4), `SetupInput`/`RunStartedInput`/`CliErrorInput`, and `SummaryEvent`.
- Produces:
  - `interface Analytics { setupCompleted(p: SetupInput): void; runStarted(p: RunStartedInput): void; runCompleted(summary: SummaryEvent, durationMs: number, config: {complexityGrading: boolean; onPlanDefect: string}): void; cliError(p: CliErrorInput): void; shutdown(): Promise<void> }`
  - `createAnalytics(config: { telemetry: boolean }, deps?: { client?: AnalyticsClient; now?: () => Date }): Analytics`

- [ ] **Step 1: Write the failing test** `test/telemetry/analytics/index.test.ts`:

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AnalyticsClient } from "../../../src/telemetry/analytics/client.ts";
import { ALLOWED_KEYS } from "../../../src/telemetry/analytics/properties.ts";
import { createAnalytics } from "../../../src/telemetry/analytics/index.ts";

interface Captured { distinctId: string; event: string; properties: Record<string, unknown> }
function fakeClient(): { client: AnalyticsClient; events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    client: {
      capture: (distinctId, event, properties) => events.push({ distinctId, event, properties }),
      shutdown: async () => {},
    },
  };
}

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "styre-an-"));
});
afterEach(() => {
  if (prev === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prev;
});

test("disabled config → no-op: no capture, no client needed", async () => {
  const { client, events } = fakeClient();
  const a = createAnalytics({ telemetry: false }, { client });
  a.runStarted({ projectId: "p", resumed: false, tracker: "linear", forge: "github" });
  await a.shutdown();
  expect(events.length).toBe(0);
});

test("enabled → events carry super-props + a distinct_id, all keys allow-listed", async () => {
  const { client, events } = fakeClient();
  const a = createAnalytics({ telemetry: true }, { client });
  a.runStarted({ projectId: "p", resumed: false, tracker: "linear", forge: "github" });
  await a.shutdown();
  expect(events.length).toBe(1);
  const e = events[0];
  expect(e.event).toBe("run_started");
  expect(e.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  expect(e.properties.styre_version).toBeDefined();
  expect(e.properties.project_id).toBe("p");
  for (const k of Object.keys(e.properties)) expect(ALLOWED_KEYS.has(k)).toBe(true);
});
```

- [ ] **Step 2: Run it, expect FAIL.** `bun test test/telemetry/analytics/index.test.ts`

- [ ] **Step 3: Implement** `src/telemetry/analytics/index.ts`:

```typescript
import type { TelemetryEvent } from "../events.ts";
import { type AnalyticsClient, createPosthogClient } from "./client.ts";
import { telemetryEnabled } from "./consent.ts";
import { loadOrCreateState, markNoticeShown } from "./id.ts";
import {
  ALLOWED_KEYS,
  type CliErrorInput,
  type RunStartedInput,
  type SetupInput,
  cliErrorProperties,
  runCompletedProperties,
  runStartedProperties,
  setupProperties,
  superProperties,
} from "./properties.ts";

type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;

const NOTICE =
  "styre collects anonymous usage analytics to improve the project. No code, repo names, " +
  "ticket IDs, or costs are sent. Opt out any time with STYRE_TELEMETRY=0 or DO_NOT_TRACK=1.";

export interface Analytics {
  setupCompleted(p: SetupInput): void;
  runStarted(p: RunStartedInput): void;
  runCompleted(
    summary: SummaryEvent,
    durationMs: number,
    config: { complexityGrading: boolean; onPlanDefect: string },
  ): void;
  cliError(p: CliErrorInput): void;
  shutdown(): Promise<void>;
}

const NOOP: Analytics = {
  setupCompleted() {},
  runStarted() {},
  runCompleted() {},
  cliError() {},
  async shutdown() {},
};

/** Defense-in-depth: drop any key not on the allow-list before it reaches the wire. */
function sanitize(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (ALLOWED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export function createAnalytics(
  config: { telemetry: boolean },
  deps?: { client?: AnalyticsClient },
): Analytics {
  if (!telemetryEnabled(config)) return NOOP;

  const state = loadOrCreateState();
  if (!state.noticeShown) {
    process.stderr.write(`${NOTICE}\n`);
    markNoticeShown(state);
  }
  const client = deps?.client ?? createPosthogClient();
  const send = (event: string, props: Record<string, unknown>) => {
    client.capture(state.distinctId, event, sanitize({ ...superProperties(), ...props }));
  };

  return {
    setupCompleted: (p) => send("setup_completed", setupProperties(p)),
    runStarted: (p) => send("run_started", runStartedProperties(p)),
    runCompleted: (summary, durationMs, cfg) =>
      send("run_completed", runCompletedProperties(summary, durationMs, cfg)),
    cliError: (p) => send("cli_error", cliErrorProperties(p)),
    shutdown: () => client.shutdown(),
  };
}
```

- [ ] **Step 4: Run it, expect PASS.** `bun test test/telemetry/analytics/index.test.ts`

- [ ] **Step 5: Commit.**

```bash
git add src/telemetry/analytics/index.ts test/telemetry/analytics/index.test.ts
git commit -m "feat(analytics): createAnalytics reporter + first-run notice + no-op path"
```

---

### Task 6: Profile `analyticsId` field

**Files:**
- Modify: `src/dispatch/profile.ts`
- Test: `test/dispatch/profile-analytics-id.test.ts` (create; `test/dispatch/` may be new — create the dir)

**Interfaces:**
- Produces: `Profile.analyticsId?: string` (optional UUID; absent in legacy profiles).

- [ ] **Step 1: Write the failing test** `test/dispatch/profile-analytics-id.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";

const base = {
  schemaVersion: 2,
  slug: "demo",
  targetRepo: "/repo",
  components: [],
  runtimeContext: {},
};

test("analyticsId is optional and preserved when present", () => {
  expect(parseProfile(base).analyticsId).toBeUndefined();
  const withId = parseProfile({ ...base, analyticsId: "abc-123" });
  expect(withId.analyticsId).toBe("abc-123");
});
```

- [ ] **Step 2: Run it, expect FAIL** (`analyticsId` stripped → `undefined` on the second assert).

Run: `bun test test/dispatch/profile-analytics-id.test.ts`

- [ ] **Step 3: Implement.** In `src/dispatch/profile.ts`, add to `ProfileSchema` (after `slug` line is fine; place after `defaultBranch`):

```typescript
  // Stable random analytics id for this project (sent to PostHog as project_id). Never encodes the
  // slug/name. Generated at `styre setup`; absent in legacy profiles (lazily added on next run).
  analyticsId: z.string().optional(),
```

- [ ] **Step 4: Run it, expect PASS.** `bun test test/dispatch/profile-analytics-id.test.ts`

- [ ] **Step 5: Commit.**

```bash
git add src/dispatch/profile.ts test/dispatch/profile-analytics-id.test.ts
git commit -m "feat(analytics): add optional analyticsId to the project profile"
```

---

### Task 7: Wire `setup_completed`

**Files:**
- Modify: `src/cli/setup.ts`
- Test: `test/setup/setup-analytics-id.test.ts` (create)

**Interfaces:**
- Consumes: `Profile.analyticsId` (Task 6), `createAnalytics` + `setupProperties` shape (Tasks 3/5).
- Produces: `runSetup` writes a profile that always has `analyticsId`; preserves an existing one on re-probe. A new exported helper `deriveSetupInput(profile): SetupInput`.

- [ ] **Step 1: Write the failing test** `test/setup/setup-analytics-id.test.ts`. (Tests the pure `deriveSetupInput` mapping + that `analyticsId` is stable across re-probe via a small unit on a helper; the full `runSetup` needs the agent and is covered by existing setup tests — here we test the mapping + a `ensureAnalyticsId` helper.)

```typescript
import { expect, test } from "bun:test";
import {
  deriveSetupInput,
  ensureAnalyticsId,
} from "../../src/cli/setup.ts";

const profile = {
  schemaVersion: 2 as const,
  slug: "demo",
  targetRepo: "/repo",
  defaultBranch: "main",
  checksSystem: "github" as const,
  components: [
    { name: "api", kind: "backend", paths: ["api/"], commands: {} },
    { name: "web", kind: "frontend", paths: ["web/"], commands: {} },
  ],
  repoCommands: {},
  promptVars: { TECHNOLOGY_STACK: "Node.js + Express" },
  runtimeContext: {
    topology: { type: "web-n-tier", detail: "" },
    data: { presence: "present", detail: "" },
    caching: { presence: "unknown", detail: "" },
    observability: { presence: "unknown", detail: "" },
    configSecrets: { presence: "unknown", detail: "" },
    documentation: { presence: "unknown", detail: "" },
    releasePackaging: { mechanism: "none", detail: "" },
  },
};

test("ensureAnalyticsId generates when absent, preserves when present", () => {
  const a = ensureAnalyticsId(profile);
  expect(a.analyticsId).toMatch(/^[0-9a-f-]{36}$/);
  const b = ensureAnalyticsId({ ...profile, analyticsId: "keep-me" });
  expect(b.analyticsId).toBe("keep-me");
});

test("deriveSetupInput maps to coarse, allow-listed inputs", () => {
  const input = deriveSetupInput({ ...profile, analyticsId: "pid" });
  expect(input.projectId).toBe("pid");
  expect(input.checksSystem).toBe("github");
  expect(input.componentCount).toBe(2);
  expect(input.componentKinds.sort()).toEqual(["backend", "frontend"]);
  expect(input.stackBucket).toBe("node");
  expect(input.topologyType).toBe("web-n-tier");
});
```

- [ ] **Step 2: Run it, expect FAIL** (`deriveSetupInput`/`ensureAnalyticsId` not exported).

Run: `bun test test/setup/setup-analytics-id.test.ts`

- [ ] **Step 3: Implement.** In `src/cli/setup.ts`:

(a) Add imports at the top:

```typescript
import { randomUUID } from "node:crypto";
import { createAnalytics } from "../telemetry/analytics/index.ts";
import type { SetupInput } from "../telemetry/analytics/properties.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../config/runtime-config.ts";
```

(b) Add the two pure helpers (above `runSetup`):

```typescript
/** Ensure the profile carries a stable analytics id (random UUID; never encodes the slug). */
export function ensureAnalyticsId(profile: Profile): Profile {
  return profile.analyticsId ? profile : { ...profile, analyticsId: randomUUID() };
}

const STACK_KEYWORDS: Array<[RegExp, string]> = [
  [/node|typescript|javascript|express|nest|bun|deno/i, "node"],
  [/python|django|flask|fastapi/i, "python"],
  [/\bgo\b|golang/i, "go"],
  [/rust|cargo/i, "rust"],
  [/java|kotlin|spring/i, "jvm"],
  [/ruby|rails/i, "ruby"],
  [/php|laravel/i, "php"],
  [/\.net|c#|dotnet/i, "dotnet"],
];

/** Coarse stack bucket from the probed TECHNOLOGY_STACK promptVar (never the raw string). */
function stackBucket(profile: Profile): string {
  const raw = profile.promptVars.TECHNOLOGY_STACK ?? "";
  for (const [re, label] of STACK_KEYWORDS) if (re.test(raw)) return label;
  return "other";
}

/** Map a profile to the allow-listed setup_completed inputs. */
export function deriveSetupInput(profile: Profile): SetupInput {
  return {
    projectId: profile.analyticsId ?? "",
    checksSystem: profile.checksSystem,
    componentCount: profile.components.length,
    componentKinds: [...new Set(profile.components.map((c) => c.kind))],
    stackBucket: stackBucket(profile),
    topologyType: profile.runtimeContext.topology.type,
  };
}
```

(c) In `runSetup`, ensure the id before writing. Replace the final assembly + write block:

```typescript
  profile = ensureAnalyticsId({ ...profile, components, repoCommands: discovered.repoCommands });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`);
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
```

Also preserve an existing id on the idempotent re-probe path — in the `if (existsSync(outPath) && !clean)` block where `existing` is loaded, carry it forward:

```typescript
    profile = {
      ...profile,
      analyticsId: existing.analyticsId ?? profile.analyticsId,
      runtimeContext: mergeRuntimeContext(existing.runtimeContext, profile.runtimeContext),
    };
```

(d) Fire the event in the `setupCommand.run` wrapper, after the success logs (edge only, never in the testable `runSetup` core):

```typescript
    const analytics = createAnalytics(DEFAULT_RUNTIME_CONFIG);
    analytics.setupCompleted(deriveSetupInput(profile));
    await analytics.shutdown();
```

- [ ] **Step 4: Run the new test + the existing setup suite, expect PASS.**

Run: `bun test test/setup/`
Expected: PASS (new test passes; existing setup tests still pass — `analyticsId` is additive).

- [ ] **Step 5: Commit.**

```bash
git add src/cli/setup.ts test/setup/setup-analytics-id.test.ts
git commit -m "feat(analytics): emit setup_completed + persist project analyticsId"
```

---

### Task 8: Wire `run_started` / `run_completed` / `cli_error`, docs, bundle smoke

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `README.md`
- Test: `test/cli/run-analytics.test.ts` (create)

**Interfaces:**
- Consumes: `createAnalytics` (Task 5), `buildSummary` from `src/telemetry/emitter.ts`, `Profile.analyticsId`, `RunResult` (`out`).
- Note: `run_completed` reuses `buildSummary(db, ticketId, result)` (already exported) to get the `SummaryEvent` it maps.

- [ ] **Step 1: Write the failing test** `test/cli/run-analytics.test.ts`. (We test the small pure seam — a `buildRunCompleted` helper that turns the run result into the reporter call args — rather than executing a full network run.)

```typescript
import { expect, test } from "bun:test";
import { runCompletedProperties } from "../../src/telemetry/analytics/properties.ts";
import type { TelemetryEvent } from "../../src/telemetry/events.ts";

// run_completed maps the exported buildSummary output; assert the mapping for a parked run.
type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;
const parked: SummaryEvent = {
  schema_version: 1, type: "summary", ticket_id: 1, ident: "ENG-1",
  outcome: "parked", stage: "implement", status: "running", ticks: 12,
  cost_usd: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_create: 0,
  dispatch_count: 4, dispatch_outcomes: { "clean-success": 3, "build-red": 1 },
  cycle_count: 2, escalation_count: 0, escalation_reasons: [],
};

test("parked run maps to failure_bucket=parked-credits and the right buckets", () => {
  const props = runCompletedProperties(parked, 7 * 60_000, { complexityGrading: false, onPlanDefect: "escalate" });
  expect(props.outcome).toBe("parked");
  expect(props.failure_bucket).toBe("parked-credits");
  expect(props.terminal_stage).toBe("implement");
  expect(props.duration_bucket).toBe("5-15m");
  expect(props.first_time_ci_pass).toBe(false);
});
```

- [ ] **Step 2: Run it, expect PASS already** (this exercises Task 3 code from the run-wiring perspective; it guards the contract run.ts depends on). If it passes, proceed; it documents the run mapping.

Run: `bun test test/cli/run-analytics.test.ts`

- [ ] **Step 3: Implement the wiring in `src/cli/run.ts`.**

(a) Add imports:

```typescript
import { createAnalytics } from "../telemetry/analytics/index.ts";
import { buildSummary } from "../telemetry/emitter.ts";
```

(b) At the very start of `run({ args })`, create the reporter and record start time. Wrap the whole body so any throw still reports `cli_error` and shuts down. Restructure the handler body as:

```typescript
  async run({ args }) {
    const profile = loadProfile(args.profile);
    assertResolved(profile);
    const runtimeConfig =
      args.config && args.config.length > 0
        ? RuntimeConfigSchema.parse(JSON.parse(readFileSync(args.config, "utf8")))
        : DEFAULT_RUNTIME_CONFIG;

    const analytics = createAnalytics(runtimeConfig);
    const startedAt = Date.now();
    try {
      // ---- resume path (unchanged) ----
      if (args.resume && args.resume.length > 0) {
        const { resumeRun } = await import("./park.ts");
        await resumeRun(
          { resume: args.resume, acceptHead: args["accept-head"], inspect: args.inspect },
          profile,
          runtimeConfig,
        );
        return;
      }

      if (!args.ticket || args.ticket.length === 0) {
        throw new Error("run: --ticket is required when not using --resume");
      }

      const dbPath =
        args.db && args.db.length > 0
          ? args.db
          : join(mkdtempSync(join(tmpdir(), "styre-run-")), "run.db");
      migrate(dbPath);
      const db = openDb(dbPath);
      recover(db, realRecoverDeps());

      const ports = makeProjectorPorts(runtimeConfig, profile);
      const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
      const registry = buildDispatchRegistry({
        runner,
        agentConfig: DEFAULT_AGENT_CONFIG,
        profile,
        worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
      });

      analytics.runStarted({
        projectId: profile.analyticsId ?? "",
        resumed: false,
        tracker: runtimeConfig.issueTracker,
        forge: runtimeConfig.forge,
      });

      const out = await runTicket({
        db,
        profile,
        runtimeConfig,
        ports,
        registry,
        ticketRef: args.ticket,
        emit: stdoutSink,
      });

      analytics.runCompleted(
        buildSummary(db, out.ticketId, out) as Extract<
          import("../telemetry/events.ts").TelemetryEvent,
          { type: "summary" }
        >,
        Date.now() - startedAt,
        { complexityGrading: runtimeConfig.complexityGrading, onPlanDefect: runtimeConfig.onPlanDefect },
      );

      console.error(out.summary);
      const ident = getTicket(db, out.ticketId)?.ident ?? args.ticket;
      if (out.outcome === "parked" && out.park) {
        const dir = parkDir(profile.slug, ident);
        console.error(
          `Parked: ${out.park.cause}${out.park.resetAt ? ` (resets ${out.park.resetAt})` : ""}.\n` +
            `Resume with: styre run --resume ${ident} --profile ${args.profile}\n` +
            `Dump: ${dir}`,
        );
      }
      finishRunResult(db, dbPath, profile.slug, ident, out);
    } catch (err) {
      analytics.cliError({
        command: "run",
        exitCode: typeof process.exitCode === "number" ? process.exitCode : 1,
        errorClass: err instanceof Error ? err.constructor.name : "Unknown",
      });
      throw err;
    } finally {
      await analytics.shutdown();
    }
  },
```

(Keep the `buildSummary(...) as ...` cast simple — `buildSummary` returns the summary `TelemetryEvent`; the cast narrows it to the summary variant for `runCompleted`.)

- [ ] **Step 4: Run the run-related tests + typecheck, expect PASS.**

Run: `bun test test/cli/ && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Add the README telemetry section.** In `README.md`, add a `## Telemetry` section:

```markdown
## Telemetry

`styre` collects anonymous usage analytics (via PostHog) to understand adoption and improve the
tool. It sends a small set of coarse events — `setup_completed`, `run_started`, `run_completed`,
`cli_error` — with an anonymous random ID. It **never** sends source code, repo names/paths,
ticket IDs, commands, branch SHAs, costs, or tokens.

**Opt out** at any time:

- `export STYRE_TELEMETRY=0`, or
- `export DO_NOT_TRACK=1`, or
- set `"telemetry": false` in your runtime `config.json`.

The anonymous ID lives at `~/.local/state/styre/telemetry.json`. In ephemeral CI, cache
`~/.local/state/styre/` to keep a stable ID across runs (otherwise each CI run is counted as new).
```

- [ ] **Step 6: Bundle smoke test.** Verify `posthog-node` compiles into the binary.

Run: `bun run build && ./dist/styre --version`
Expected: prints the version, exit 0 (the binary links `posthog-node` without a bundling error). If `dist/` path differs, use the path printed by `scripts/build.sh`.

- [ ] **Step 7: Full suite + lint.**

Run: `bun test && biome check . && bun run typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/cli/run.ts README.md test/cli/run-analytics.test.ts
git commit -m "feat(analytics): emit run_started/run_completed/cli_error + telemetry docs"
```

---

## Self-Review

**Spec coverage:**
- D1 binary phones home → Tasks 4/5/7/8. ✓
- D2 opt-out + DO_NOT_TRACK → Task 1 + README (Task 8). ✓
- D3 curated events (not stream) → Tasks 3/5 (4 events; NDJSON sink untouched). ✓
- D4 no cost/tokens → `properties.ts` omits them; `ALLOWED_KEYS` excludes them; guard test. ✓
- D5 excluded fields → allow-list + `sanitize()` + guard test; `failureBucket` never sends raw text; `cli_error` sends `error_class` not message (test). ✓
- D6 distinct_id in state → Task 2. ✓
- D7 project_id in profile → Tasks 6/7 (`analyticsId` → `project_id`). ✓
- D8 no fleet/STYRE_ANON_ID → not implemented; CI caching documented (Task 8). ✓
- D9 CLI-edge module → `src/telemetry/analytics/`; engine untouched. ✓
- D10 posthog-node → Task 4. ✓
- D11 US Cloud host → `POSTHOG_HOST` (Task 4). ✓
- Event catalog (setup_completed/run_started/run_completed/cli_error + all properties) → Task 3 builders, Tasks 7/8 wiring. ✓
- First-run notice to stderr → Task 5. ✓
- Fail-silent + bounded shutdown → Task 4. ✓

**Placeholder scan:** The only literal placeholder is `POSTHOG_TOKEN = "phc_REPLACE_WITH_PROJECT_KEY"` — an operator-provided secret, flagged in Global Constraints + Task 4 (not a logic gap).

**Type consistency:** `SetupInput`/`RunStartedInput`/`CliErrorInput` defined in `properties.ts` (Task 3), consumed unchanged in `index.ts` (Task 5) and `setup.ts` (Task 7). `Analytics` method names (`setupCompleted`/`runStarted`/`runCompleted`/`cliError`/`shutdown`) consistent across Tasks 5/7/8. `analyticsId` (profile field) → `project_id` (wire property) mapping consistent in Tasks 6/7. `buildSummary` return reused in Task 8.

**Open follow-up (non-blocking):** `first_time_ci_pass`/`autonomous_fix` are proxies derived from `dispatch_outcomes`; can be refined later against `ground_truth_signal` rows without changing the wire contract.
