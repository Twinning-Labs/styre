# ENG-354: Count early config/usage errors in `cliError` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `styre run`'s `cli_error` analytics event fire for *every* `StyreError` (and internal throw) reaching the error boundary — including config/usage/profile errors thrown before `createAnalytics(...)` runs — and add an `error_kind` discriminator derived from the exit code.

**Architecture:** Widen the `try` in `runImpl` to wrap the whole body, hoisting the `analytics` handle so the single `catch` can emit `cliError` regardless of where the throw happened. When the throw is early enough that no runtime config was ever resolved, the catch builds a fallback analytics client (`{ telemetry: true }`, still vetoed by `DO_NOT_TRACK`/`STYRE_TELEMETRY`; `cli_error` carries no PII). A new pure `errorKindForExit(code)` helper maps the exit code to a coarse kind emitted as `error_kind`. A test-only `deps.analyticsClient` seam on `runImpl` (mirroring the existing `createAnalytics` seam) lets integration tests capture emissions.

**Tech Stack:** TypeScript on Bun; `bun test` (bun:test); embedded analytics → PostHog client behind an `AnalyticsClient` interface.

## Global Constraints

- **Analytics-only change.** No exit codes change; no rendered operator messages change (`guard`, `renderError`, `renderInternal` untouched). Copied verbatim from the ticket: "Keep it analytics-only: no change to exit codes or rendered messages (those are correct)."
- **Never commit to `main`.** Work happens on the `fix/eng-354-*` branch (this is a bug fix → `fix/` prefix per CLAUDE.md). Merge via PR only; no auto-merge.
- **`cli_error` carries no PII** — only `command`, `exit_code`, `error_class`, and the new `error_kind`. Any new emitted property key MUST be added to `ALLOWED_KEYS` in `src/telemetry/analytics/properties.ts` (a guard test enforces this).
- **Consent policy for the fallback path:** when runtime config was never resolved, emit via `createAnalytics({ telemetry: true }, ...)`. The env vetoes (`DO_NOT_TRACK`, `STYRE_TELEMETRY`) still apply inside `createAnalytics`. When config *was* resolved with telemetry off, `createAnalytics` returns `NOOP` and the fallback must NOT resurrect emission.
- Run the full suite with `bun test` and lint with `bun run lint` before the final commit.

---

## File Structure

- `src/cli/errors.ts` — add pure `errorKindForExit(code: number): string` next to `EXIT`.
- `src/telemetry/analytics/properties.ts` — add `errorKind` to `CliErrorInput`, emit `error_kind`, add `"error_kind"` to `ALLOWED_KEYS`.
- `src/cli/run.ts` — restructure `runImpl`: hoist `analytics`, single wrapping `try`, fallback emit in `catch`, `error_kind` in the payload, and an optional `deps.analyticsClient` test seam.
- `test/cli/errors.test.ts` — unit tests for `errorKindForExit`.
- `test/telemetry/analytics/properties.test.ts` — extend for `error_kind`; fix the two existing `cliErrorProperties(...)` call sites for the new required field.
- `test/cli/run-clierror-coverage.test.ts` (new) — integration tests driving `runImpl` through the seam, asserting `cli_error` emission for early-error, fallback, and opt-out cases.

---

## Task 1: `errorKindForExit` helper

**Files:**
- Modify: `src/cli/errors.ts` (append after the `toolchainError` function, end of file)
- Test: `test/cli/errors.test.ts`

**Interfaces:**
- Consumes: the existing `EXIT` const object in `src/cli/errors.ts`.
- Produces: `export function errorKindForExit(code: number): string` — returns one of `"usage" | "config" | "toolchain" | "resume_refused" | "operational" | "tempfail" | "internal" | "other"`. Covers every *error* `EXIT` code; `EXIT.OK` (0) and any unknown code fall through to `"other"` (success is never an error kind).

- [ ] **Step 1: Write the failing test**

Append to `test/cli/errors.test.ts` (the import line already imports from `../../src/cli/errors.ts` — add `errorKindForExit` to it):

```ts
// add errorKindForExit to the existing import from "../../src/cli/errors.ts"
import { EXIT, StyreError, configError, errorKindForExit, toolchainError, usageError } from "../../src/cli/errors.ts";

test("errorKindForExit maps each EXIT code to its kind", () => {
  expect(errorKindForExit(EXIT.USAGE)).toBe("usage");
  expect(errorKindForExit(EXIT.CONFIG)).toBe("config");
  expect(errorKindForExit(EXIT.TOOLCHAIN_MISSING)).toBe("toolchain");
  expect(errorKindForExit(EXIT.RESUME_REFUSED)).toBe("resume_refused");
  expect(errorKindForExit(EXIT.OPERATIONAL)).toBe("operational");
  expect(errorKindForExit(EXIT.TEMPFAIL)).toBe("tempfail");
  expect(errorKindForExit(EXIT.INTERNAL)).toBe("internal");
});

test("errorKindForExit falls back to 'other' for an unknown code", () => {
  expect(errorKindForExit(0)).toBe("other");
  expect(errorKindForExit(255)).toBe("other");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/errors.test.ts`
Expected: FAIL — `errorKindForExit` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Append to `src/cli/errors.ts` (after `toolchainError`, at end of file):

```ts
/** Coarse operator-error kind derived from the shared exit-code scheme, emitted on `cli_error`
 *  so analytics can distinguish usage vs config vs toolchain vs internal — which `error_class`
 *  can't (every StyreError shares one class). Unknown codes collapse to "other". */
export function errorKindForExit(code: number): string {
  switch (code) {
    case EXIT.USAGE:
      return "usage";
    case EXIT.CONFIG:
      return "config";
    case EXIT.TOOLCHAIN_MISSING:
      return "toolchain";
    case EXIT.RESUME_REFUSED:
      return "resume_refused";
    case EXIT.OPERATIONAL:
      return "operational";
    case EXIT.TEMPFAIL:
      return "tempfail";
    case EXIT.INTERNAL:
      return "internal";
    default:
      return "other";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli/errors.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/cli/errors.ts test/cli/errors.test.ts
git commit -m "feat(cli): add errorKindForExit for cli_error discriminator (ENG-354)"
```

---

## Task 2: `error_kind` on the `cli_error` event

**Files:**
- Modify: `src/telemetry/analytics/properties.ts` (`CliErrorInput`, `cliErrorProperties`, `ALLOWED_KEYS`)
- Test: `test/telemetry/analytics/properties.test.ts`
- Test: `test/telemetry/analytics/index.test.ts` (one existing `.cliError(...)` call site at line 84 must gain `errorKind` to keep `tsc --noEmit` green)

**Interfaces:**
- Consumes: nothing new (the `errorKind` value is supplied by the caller; Task 3 supplies it via `errorKindForExit`).
- Produces:
  - `CliErrorInput` gains a required field `errorKind: string`.
  - `cliErrorProperties(p)` output gains `error_kind: string`.
  - `ALLOWED_KEYS` gains `"error_kind"`.

- [ ] **Step 1: Write the failing test**

In `test/telemetry/analytics/properties.test.ts`, first update the TWO existing `cliErrorProperties(...)` call sites to include the new required field, then add a new test:

Line ~98 (inside the "all keys allow-listed" test's `bags` array) — change:
```ts
    cliErrorProperties({ command: "run", exitCode: 1, errorClass: "TypeError" }),
```
to:
```ts
    cliErrorProperties({ command: "run", exitCode: 1, errorClass: "TypeError", errorKind: "operational" }),
```

Line ~127 (the "never carries a message field" test) — change:
```ts
  const bag = cliErrorProperties({ command: "run", exitCode: 1, errorClass: "Error" });
```
to:
```ts
  const bag = cliErrorProperties({ command: "run", exitCode: 1, errorClass: "Error", errorKind: "internal" });
```

**Also update the third call site** — `test/telemetry/analytics/index.test.ts:84` calls `.cliError(...)` and will fail `tsc --noEmit` (CI step `bun run typecheck`) once `errorKind` is required, even though `bun test` stays green (Bun strips types). Change:
```ts
    a?.cliError({ command: "run", exitCode: 1, errorClass: "Error" });
```
to:
```ts
    a?.cliError({ command: "run", exitCode: 1, errorClass: "Error", errorKind: "operational" });
```

Then append a new test:
```ts
test("cli_error carries an allow-listed error_kind", () => {
  const bag = cliErrorProperties({
    command: "run",
    exitCode: 78,
    errorClass: "StyreError",
    errorKind: "config",
  });
  expect(bag.error_kind).toBe("config");
  expect(ALLOWED_KEYS.has("error_kind")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/telemetry/analytics/properties.test.ts`
Expected: FAIL — TypeScript error (`errorKind` missing) resolves once call sites are updated, then the new test FAILS because `bag.error_kind` is `undefined` and `ALLOWED_KEYS` lacks `"error_kind"`.

- [ ] **Step 3: Write minimal implementation**

In `src/telemetry/analytics/properties.ts`:

Change the interface:
```ts
export interface CliErrorInput {
  command: string;
  exitCode: number;
  errorClass: string;
  errorKind: string;
}
```

Change the builder:
```ts
export function cliErrorProperties(p: CliErrorInput): Record<string, unknown> {
  return {
    command: p.command,
    exit_code: p.exitCode,
    error_class: p.errorClass,
    error_kind: p.errorKind,
  };
}
```

Add to `ALLOWED_KEYS` (in the `// cli_error` group):
```ts
  // cli_error
  "exit_code",
  "error_class",
  "command",
  "error_kind",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/telemetry/analytics/properties.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/analytics/properties.ts test/telemetry/analytics/properties.test.ts test/telemetry/analytics/index.test.ts
git commit -m "feat(telemetry): add error_kind to cli_error event (ENG-354)"
```

---

## Task 3: Restructure `runImpl` — widen the try, fallback emit, test seam

**Files:**
- Modify: `src/cli/run.ts` (imports + `runImpl`)
- Test: `test/cli/run-clierror-coverage.test.ts` (new)

**Interfaces:**
- Consumes:
  - `errorKindForExit(code: number): string` (Task 1) and `EXIT` from `src/cli/errors.ts`.
  - `CliErrorInput` now requires `errorKind` (Task 2).
  - `createAnalytics(config: { telemetry: boolean }, deps?: { client?: AnalyticsClient }): Analytics` from `src/telemetry/analytics/index.ts`.
  - `AnalyticsClient` (`{ capture(distinctId, event, properties): void; shutdown(): Promise<void> }`) from `src/telemetry/analytics/client.ts`.
- Produces:
  - `runImpl({ args }: { args: RunArgs }, deps?: { analyticsClient?: AnalyticsClient }): Promise<void>` — the second param is optional and defaults to undefined; `runCommand.run` continues to call `runImpl({ args })`.

- [ ] **Step 1: Write the failing test**

Create `test/cli/run-clierror-coverage.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImpl } from "../../src/cli/run.ts";
import type { AnalyticsClient } from "../../src/telemetry/analytics/client.ts";

interface Captured {
  event: string;
  properties: Record<string, unknown>;
}
function fakeClient(): { client: AnalyticsClient; events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    client: {
      capture: (_distinctId, event, properties) => events.push({ event, properties }),
      shutdown: async () => {},
    },
  };
}

/** Write a raw JSON object to a temp file and return its path. */
function tmpJson(prefix: string, obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, `${prefix}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

/** A minimal, valid profile (empty components → assertResolved passes). */
function validProfilePath(): string {
  return tmpJson("styre-prof-", {
    slug: "eng354",
    targetRepo: "/tmp/eng354-repo",
    defaultBranch: "main",
    checksSystem: "none",
  });
}

// Isolate telemetry state to a temp dir, and neutralize env opt-outs so the fallback path emits.
let prevXdg: string | undefined;
let prevDnt: string | undefined;
let prevStyre: string | undefined;
beforeEach(() => {
  prevXdg = process.env.XDG_STATE_HOME;
  prevDnt = process.env.DO_NOT_TRACK;
  prevStyre = process.env.STYRE_TELEMETRY;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "styre-clierr-state-"));
  Reflect.deleteProperty(process.env, "DO_NOT_TRACK");
  Reflect.deleteProperty(process.env, "STYRE_TELEMETRY");
});
afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? Reflect.deleteProperty(process.env, k) : (process.env[k] = v);
  restore("XDG_STATE_HOME", prevXdg);
  restore("DO_NOT_TRACK", prevDnt);
  restore("STYRE_TELEMETRY", prevStyre);
});

test("early config error (bad adapter) emits cli_error with exit_code 78 / error_kind config", async () => {
  const profile = validProfilePath();
  const config = tmpJson("styre-cfg-", { issueTracker: "liner" }); // unknown adapter → ConfigError (78)
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile, config, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  const cliErr = events.find((e) => e.event === "cli_error");
  expect(cliErr).toBeDefined();
  expect(cliErr?.properties.exit_code).toBe(78);
  expect(cliErr?.properties.error_kind).toBe("config");
});

test("earliest error (malformed --profile, before config) still emits cli_error via fallback", async () => {
  const badProfile = tmpJson("styre-prof-", { commands: {} }); // legacy shape → throws in parseProfile
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile: badProfile, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(true);
});

test("telemetry off in config → later error emits NO cli_error (opt-out preserved)", async () => {
  const profile = validProfilePath();
  const config = tmpJson("styre-cfg-", { telemetry: false }); // valid, telemetry disabled
  const { client, events } = fakeClient();

  // No ticket, no resume → usageError thrown AFTER analytics is built (as NOOP).
  await expect(
    runImpl({ args: { profile, config } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-clierror-coverage.test.ts`
Expected: FAIL — the first two tests fail because early errors currently bypass `cliError` (no `cli_error` captured); `runImpl` also does not yet accept the `deps` param.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/run.ts`:

**(a) Imports.** Change the analytics import and the errors import, and add the client type import:
```ts
import { EXIT, StyreError, errorKindForExit, toolchainError, usageError } from "./errors.ts";
```
```ts
import type { AnalyticsClient } from "../telemetry/analytics/client.ts";
import { type Analytics, createAnalytics } from "../telemetry/analytics/index.ts";
```
(Leave every other import line unchanged. The existing `import { createAnalytics } from "../telemetry/analytics/index.ts";` line is replaced by the `type Analytics` variant above; the existing `import { StyreError, toolchainError, usageError } from "./errors.ts";` line is replaced by the `EXIT, ... errorKindForExit ...` variant above.)

**(b) Replace the whole `runImpl` function** (currently lines 95–235) with:
```ts
export async function runImpl(
  { args }: { args: RunArgs },
  deps?: { analyticsClient?: AnalyticsClient },
): Promise<void> {
  // Hoisted so the single catch can emit `cliError` for throws that happen BEFORE analytics is
  // built (bad/absent profile, "not a git repo" usage error, config-discovery errors). When
  // config was never resolved, the catch builds a fallback client (env opt-outs still apply).
  let analytics: Analytics | undefined;
  try {
    let profile: Profile;
    let slug: string;
    if (args.profile && args.profile.length > 0) {
      profile = loadProfile(args.profile);
      slug = args.slug && args.slug.length > 0 ? args.slug : profile.slug;
    } else {
      const derived = args.slug && args.slug.length > 0 ? args.slug : slugForCwd();
      if (!derived) {
        throw usageError(
          "no --profile given and the current directory is not a git repo",
          "cd into the target repo, or pass --profile / --slug.",
        );
      }
      slug = derived;
      profile = loadProfileByConvention(slug);
    }
    assertResolved(profile);
    const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug });
    assertSlackConfigured(runtimeConfig);
    if (runtimeConfig.notifier !== "none") {
      // human-readable status → stderr (stdout carries only NDJSON telemetry)
      process.stderr.write(
        `notifier: ${runtimeConfig.notifier} → ${runtimeConfig.slack?.channel} (policy: ${runtimeConfig.notify})\n`,
      );
    }

    const a = createAnalytics(runtimeConfig, { client: deps?.analyticsClient });
    analytics = a;
    const startedAt = Date.now();

    if (args["in-place"] && !(args.resume && args.resume.length > 0)) {
      const { discoverRepoRoot, assertInPlaceSafe, assertInPlaceIdentity } = await import(
        "../dispatch/in-place.ts"
      );
      // cwd git-toplevel; THROWS (fail-closed) if not a repo — never falls through to the stale profile path
      const discovered = discoverRepoRoot();
      if (discovered !== profile.targetRepo) {
        console.error(
          `IN-PLACE: discovered repo root ${discovered} differs from the profile's targetRepo ${profile.targetRepo}; using the discovered root (components/commands still come from the profile).`,
        );
      }
      profile.targetRepo = discovered;
      assertInPlaceSafe(profile.targetRepo);
      await assertInPlaceIdentity(profile.targetRepo, profile);
    }

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
      throw usageError(
        "--ticket is required when not using --resume",
        "Pass a ticket ref, e.g. styre run ENG-123.",
      );
    }

    // Fail fast before any spend if a program the components' commands need isn't installed on
    // this machine. Fresh-run path only — `--resume`/`--inspect` returned above (their re-running
    // ground-truth steps are the check, and `--inspect` must stay exit-0 on a tool-less machine).
    const missingTools = preflightToolchain(profile);
    if (missingTools.length > 0) {
      throw toolchainError(formatMissingTools(missingTools));
    }

    const dbPath =
      args.db && args.db.length > 0
        ? args.db
        : join(mkdtempSync(join(tmpdir(), "styre-run-")), "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    recover(db, realRecoverDeps());

    const ports = makeProjectorPorts(runtimeConfig, profile);
    const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
    const runner = resolveAgentRunner(agentConfig);
    const registry = buildDispatchRegistry({
      runner,
      agentConfig,
      profile,
      worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
      inPlace: (args["in-place"] as boolean | undefined) ?? false,
    });

    a.runStarted({
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

    a.runCompleted(
      buildSummary(db, out.ticketId, out) as Extract<TelemetryEvent, { type: "summary" }>,
      Date.now() - startedAt,
      {
        complexityGrading: runtimeConfig.complexityGrading,
        onPlanDefect: runtimeConfig.onPlanDefect,
      },
    );

    console.error(out.summary); // human summary → stderr; stdout carries only NDJSON telemetry
    const ident = getTicket(db, out.ticketId)?.ident ?? args.ticket;
    if (out.outcome === "parked" && out.park) {
      // Print resume-hint before finishRunResult (which does dumpPark + sets exitCode).
      // parkDir gives the path without touching the DB.
      const dir = parkDir(profile.slug, ident);
      console.error(
        `Parked: ${out.park.cause}${out.park.resetAt ? ` (resets ${out.park.resetAt})` : ""}.\n` +
          `Resume with: styre run --resume ${ident} ${args.profile ? `--profile ${args.profile}` : `--slug ${slug}`}\n` +
          `Dump: ${dir}`,
      );
    }
    finishRunResult(db, dbPath, profile.slug, ident, out);
  } catch (err) {
    const code = err instanceof StyreError ? err.code : EXIT.INTERNAL;
    // If we threw before config was resolved, `analytics` is undefined — build a fallback so the
    // failure is still counted. `createAnalytics` honors DO_NOT_TRACK / STYRE_TELEMETRY, and
    // `cli_error` carries no PII. Assigning back to `analytics` lets the finally flush it.
    analytics ??= createAnalytics({ telemetry: true }, { client: deps?.analyticsClient });
    analytics.cliError({
      command: "run",
      exitCode: code,
      errorClass: err instanceof Error ? err.constructor.name : "Unknown",
      errorKind: errorKindForExit(code),
    });
    throw err; // rethrow → guard renders + sets process.exitCode
  } finally {
    await analytics?.shutdown();
  }
}
```

Notes for the implementer:
- The only behavioral changes vs. the original are: (1) the `try` now starts at the top of the body instead of after `createAnalytics`; (2) the `catch` builds a fallback client when `analytics` is undefined and includes `errorKind`; (3) `runImpl` accepts the optional `deps` seam and threads `deps?.analyticsClient` into both `createAnalytics` calls. Everything between is byte-for-byte the original body, using the local `const a` for `runStarted`/`runCompleted` (avoids relying on `let` narrowing across `await`).
- Do NOT touch `runCommand.run` — it stays `run: (ctx) => guard("run", () => runImpl({ args: ctx.args as unknown as RunArgs }))`.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `bun test test/cli/run-clierror-coverage.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Run the broader affected suites**

Run: `bun test test/cli/ test/telemetry/`
Expected: PASS. In particular `run-analytics.test.ts`, `run-guard.test.ts`, `config-error.test.ts`, `adapter-validation.test.ts`, and `index.test.ts` remain green (no behavior change to their assertions).

- [ ] **Step 6: Commit**

```bash
git add src/cli/run.ts test/cli/run-clierror-coverage.test.ts
git commit -m "fix(run): count early config/usage errors in cli_error (ENG-354)"
```

---

## Task 4: Full-suite + lint gate, and open the PR

**Files:** none (verification + delivery only).

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS (entire suite).

- [ ] **Step 2: Typecheck (CI gate — catches required-field breaks `bun test` misses)**

Run: `bun run typecheck`
Expected: clean. `tsc --noEmit` type-checks the test files too (tsconfig has no `include`/`exclude`), so a missed `errorKind` on any `.cliError(...)`/`cliErrorProperties(...)` call surfaces here even though `bun test` (Bun strips types) stayed green.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: clean. If Biome flags import ordering on the rewritten `run.ts` import block (`organizeImports` is enabled), run `bun run format` and re-commit.

- [ ] **Step 4: Build (smoke)**

Run: `bun run build`
Expected: builds the single binary with no type errors.

- [ ] **Step 5: Push the branch and open a draft PR**

```bash
# The worktree's local branch is auto-named; push to the CLAUDE.md-mandated fix/ name explicitly.
git push -u origin HEAD:fix/eng-354-clierror-early-coverage
gh pr create --draft --head fix/eng-354-clierror-early-coverage \
  --title "fix(run): count early config/usage errors in cli_error (ENG-354)" \
  --body "$(cat <<'EOF'
Closes ENG-354.

`styre run`'s `cli_error` analytics event only fired for throws after `createAnalytics(...)`. Errors thrown earlier — a bad-adapter `ConfigError`, the "no --profile / not a git repo" usage error, an unresolved profile, and (ENG-350's newly-early `validateAdapters`) unknown-adapter errors — bypassed it.

## Changes (analytics-only)
- Widen the `try` in `runImpl` to wrap the whole body; hoist the `analytics` handle so the single `catch` emits `cli_error` for early throws too. When config was never resolved, the catch builds a fallback client (env opt-outs `DO_NOT_TRACK`/`STYRE_TELEMETRY` still apply; `cli_error` carries no PII). When config resolved with telemetry off, the `NOOP` is preserved — no emission.
- Add `error_kind` to `cli_error`, derived from the exit code via `errorKindForExit` (usage/config/toolchain/…), so operator-error kinds are distinguishable beyond `error_class` (always `StyreError`).
- Test-only `deps.analyticsClient` seam on `runImpl` mirroring the existing `createAnalytics` seam.

No exit codes or rendered messages change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: draft PR opened into `main`. Do NOT merge (operator merges personally).

---

## Task 5: End-to-end DO_NOT_TRACK fallback guard test

**Context:** Post-merge follow-up from the final whole-branch review — the fallback's respect for `DO_NOT_TRACK` currently rests on `consent.ts`/`createAnalytics` unit tests; add one end-to-end assertion through `runImpl`. This is a regression-GUARD test (behavior is already correct), so it is GREEN-only — there is no RED phase. Its positive control is the sibling test "earliest error … emits cli_error via fallback" (same setup WITHOUT `DO_NOT_TRACK`, which DOES capture) — proving this test discriminates on `DO_NOT_TRACK` alone.

**Files:**
- Test: `test/cli/run-clierror-coverage.test.ts` (append one test)

- [ ] **Step 1: Add the test**

Append this test to `test/cli/run-clierror-coverage.test.ts` (the `beforeEach` deletes `DO_NOT_TRACK`; this test re-sets it, and `afterEach` restores the original):
```ts
test("fallback honors DO_NOT_TRACK — early error emits no cli_error even with a client available", async () => {
  // Early-throw path builds the fallback createAnalytics({ telemetry: true }); DO_NOT_TRACK must
  // still veto it. The guarantee lives in consent.ts; asserted here end-to-end through runImpl.
  // Positive control: the sibling "earliest error … via fallback" test (no DO_NOT_TRACK) DOES capture.
  process.env.DO_NOT_TRACK = "1";
  const badProfile = tmpJson("styre-prof-", { commands: {} }); // throws before config → fallback path
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile: badProfile, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(false);
});
```

- [ ] **Step 2: Run the file**

Run: `bun test test/cli/run-clierror-coverage.test.ts`
Expected: PASS (4/4 — the new test plus the three existing). Also confirm `bun run lint` and `bun run typecheck` stay clean.

- [ ] **Step 3: Commit**

```bash
git add test/cli/run-clierror-coverage.test.ts
git commit -m "test(run): assert fallback honors DO_NOT_TRACK end-to-end (ENG-354)"
```

---

## Task 6: Consent-doc note — first-run notice on an early failure

**Context:** Because early failures are now counted, the one-time telemetry consent NOTICE can print on a run that fails before config resolves (the fallback builds the analytics client there). Document this operator-facing nuance where telemetry/opt-out already lives. Keep docs consistent with code (this repo keeps `docs/architecture/` current).

**Files:**
- Modify: `README.md` (the `## Telemetry` section, after the "anonymous ID lives at …" paragraph, ~line 229)
- Modify: `docs/architecture/conventions.md` (the "Telemetry identity in CI" section, ~line 115, the first-run-notice-latch sentence)

- [ ] **Step 1: README note**

In `README.md`, immediately after the paragraph ending "…otherwise each CI run is counted as new).", insert:
```markdown

> **First-run notice on an early failure.** The one-time notice above prints on the first run that
> reaches telemetry. Because `styre run` now counts errors that happen early (e.g. run outside a git
> repo, or with an unreadable `config.json`), that first run can be one that fails before it gets
> going — the notice then prints once to **stderr** (never stdout, so machine output is unaffected),
> and the anonymous ID + notice latch are minted. It appears at most once. The `STYRE_TELEMETRY`/
> `DO_NOT_TRACK` env opt-outs suppress it on every path; a `"telemetry": false` in `config.json` is
> honored whenever that file is readable.
```

- [ ] **Step 2: conventions.md cross-reference**

In `docs/architecture/conventions.md`, the "Telemetry identity in CI" section currently ends with a sentence about the first-run-notice latch surviving across runs. Append one sentence to that section:
```markdown

Since `styre run` counts early failures too, the id + first-run-notice latch can be minted (and the notice printed once to stderr) on a run that fails before config resolves — not only on a fully successful run. Still at most once; the `STYRE_TELEMETRY`/`DO_NOT_TRACK` opt-outs suppress it.
```

- [ ] **Step 3: Verify + commit**

No code changed → no tests to run. Confirm the two edits render (Markdown) and are accurate against `src/telemetry/analytics/index.ts` (the NOTICE + `markNoticeShown`) and `consent.ts` (the opt-outs).
```bash
git add README.md docs/architecture/conventions.md
git commit -m "docs(telemetry): note first-run consent notice on early-failure path (ENG-354)"
```

---

## Task 7: Close the residual consent gap — honor a resolved config's telemetry on early-failure paths

**Context:** The Task-6 fact-check review surfaced that the early-failure fallback hardcodes `{ telemetry: true }` and never consults `runtimeConfig` — so a `config.json` `"telemetry": false` was ignored even when config had already been successfully resolved (e.g. `assertSlackConfigured` throws at `run.ts:123`, AFTER `discoverRuntimeConfig` resolved the config at line 122 but BEFORE `createAnalytics` at line 131). Close it by building analytics as soon as config is resolved, so throws in that window go through the real (config-honoring) client. The `??=` fallback then only handles throws where config was never resolved (unparseable `config.json`, or a failure before config discovery) — the irreducible window with no telemetry preference to honor.

**Files:**
- Modify: `src/cli/run.ts` (move the `createAnalytics` build up; adjust the fallback comment)
- Test: `test/cli/run-clierror-coverage.test.ts` (add SLACK_BOT_TOKEN to the env harness; add a negative + positive test)
- Docs: `README.md` (narrow the early-failure opt-out note), `docs/architecture/conventions.md` (keep accurate)

- [ ] **Step 1: Write the failing test (RED)**

First, extend the file's env harness so `SLACK_BOT_TOKEN` is deterministically unset (the new tests rely on `assertSlackConfigured` throwing on a missing token). In `test/cli/run-clierror-coverage.test.ts`, add a saved var and manage it in `beforeEach`/`afterEach` exactly like the existing env vars:
```ts
// add alongside prevXdg/prevDnt/prevStyre
let prevSlack: string | undefined;
```
In `beforeEach` (with the other captures + deletes):
```ts
  prevSlack = process.env.SLACK_BOT_TOKEN;
  Reflect.deleteProperty(process.env, "SLACK_BOT_TOKEN");
```
In `afterEach` (the existing `restore(...)` helper handles it):
```ts
  restore("SLACK_BOT_TOKEN", prevSlack);
```

Then append the negative test (this is the RED one — it FAILS before Step 2 because the current fallback hardcodes `telemetry: true` and emits):
```ts
test("early failure AFTER config resolves honors config telemetry:false (no cli_error)", async () => {
  // notifier:slack with SLACK_BOT_TOKEN unset throws in assertSlackConfigured — AFTER
  // discoverRuntimeConfig resolved the config, but still an early failure (before the run body).
  // Because that resolved config has telemetry:false, analytics is NOOP and nothing is emitted.
  const profile = validProfilePath();
  const config = tmpJson("styre-cfg-", { notifier: "slack", telemetry: false });
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile, config, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(false);
});

test("early failure AFTER config resolves still emits when telemetry is on (positive control)", async () => {
  // Same assertSlackConfigured trigger, telemetry left at its default (true) → cli_error IS emitted.
  // Pairs with the negative test above so the negative is gated on telemetry, not on the throw.
  const profile = validProfilePath();
  const config = tmpJson("styre-cfg-", { notifier: "slack" }); // telemetry defaults to true
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile, config, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(true);
});
```

- [ ] **Step 2: Run to confirm RED**

Run: `bun test test/cli/run-clierror-coverage.test.ts`
Expected: the NEGATIVE test FAILS (a `cli_error` is captured because the current fallback ignores `telemetry:false`); the positive test passes. This proves the gap exists.

- [ ] **Step 3: Implement the fix (GREEN)**

In `src/cli/run.ts`, move the analytics build to immediately after `discoverRuntimeConfig`, before `assertSlackConfigured`. Replace this block:
```ts
    const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug });
    assertSlackConfigured(runtimeConfig);
    if (runtimeConfig.notifier !== "none") {
      // human-readable status → stderr (stdout carries only NDJSON telemetry)
      process.stderr.write(
        `notifier: ${runtimeConfig.notifier} → ${runtimeConfig.slack?.channel} (policy: ${runtimeConfig.notify})\n`,
      );
    }

    const a = createAnalytics(runtimeConfig, { client: deps?.analyticsClient });
    analytics = a;
    const startedAt = Date.now();
```
with:
```ts
    const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug });
    // Build analytics the moment config is resolved — BEFORE the remaining fail-fast checks
    // (assertSlackConfigured) — so a throw in that window is counted through the real client and
    // honors the operator's config-level telemetry setting. The catch's fallback then only handles
    // throws from before config could be resolved at all.
    const a = createAnalytics(runtimeConfig, { client: deps?.analyticsClient });
    analytics = a;
    const startedAt = Date.now();

    assertSlackConfigured(runtimeConfig);
    if (runtimeConfig.notifier !== "none") {
      // human-readable status → stderr (stdout carries only NDJSON telemetry)
      process.stderr.write(
        `notifier: ${runtimeConfig.notifier} → ${runtimeConfig.slack?.channel} (policy: ${runtimeConfig.notify})\n`,
      );
    }
```

Then update the fallback comment in the `catch` so it reflects the narrowed role. Replace:
```ts
    // If we threw before config was resolved, `analytics` is undefined — build a fallback so the
    // failure is still counted. `createAnalytics` honors DO_NOT_TRACK / STYRE_TELEMETRY, and
    // `cli_error` carries no PII. Assigning back to `analytics` lets the finally flush it.
    analytics ??= createAnalytics({ telemetry: true }, { client: deps?.analyticsClient });
```
with:
```ts
    // Reached only when we threw before config could be resolved (unparseable config, or a failure
    // before config discovery) — so `analytics` is undefined and there is no config-level telemetry
    // preference to honor; default to enabled. `createAnalytics` still honors DO_NOT_TRACK /
    // STYRE_TELEMETRY, and `cli_error` carries no PII. Assigning back lets the finally flush it.
    analytics ??= createAnalytics({ telemetry: true }, { client: deps?.analyticsClient });
```

- [ ] **Step 4: Run to confirm GREEN + no regression**

Run: `bun test test/cli/run-clierror-coverage.test.ts` → all pass (negative now passes: analytics is the NOOP built from the resolved telemetry:false config, so nothing emits).
Run: `bun test test/cli/ test/telemetry/` → all pass.
Run: `bun run typecheck` and `bun run lint` → clean.

- [ ] **Step 5: Update the docs to the narrowed gap**

In `README.md`, the early-failure note's last two sentences currently say the `config.json` opt-out is "not consulted by the early-failure fallback". Replace that trailing text (from "The `STYRE_TELEMETRY`/" to the end of the blockquote) with:
```markdown
> `DO_NOT_TRACK` env opt-outs suppress it on every path, including these early failures. A
> `"telemetry": false` in `config.json` is also honored on the early-failure path once the config has
> been read; it can only be missed when the failure prevents the config from being read at all (an
> unparseable `config.json`, or a failure before the config is loaded — e.g. running outside a git
> repo), where the env opt-outs are the reliable suppressor.
```

In `docs/architecture/conventions.md`, the Task-6 sentence says the latch can be minted "on a run that fails before config resolves". Broaden it to stay accurate (minting now happens as soon as config resolves, so any early failure at/after that point mints too). Replace that sentence with:
```markdown
Since `styre run` counts early failures too, the id + first-run-notice latch can be minted (and the notice printed once to stderr) on a run that fails early — not only on a fully successful run. Still at most once; the `STYRE_TELEMETRY`/`DO_NOT_TRACK` opt-outs suppress it, as does a `"telemetry": false` config once the config has been read.
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/run.ts test/cli/run-clierror-coverage.test.ts README.md docs/architecture/conventions.md
git commit -m "fix(run): honor resolved config telemetry on early-failure paths (ENG-354)"
```
