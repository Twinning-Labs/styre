# CLI Output Layer + Run Outcome Content — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `styre` CLI one shared output layer + an error boundary (ENG-350) and rewrite `styre run`'s outcome content (ENG-338), so every message is consistent, specific, actionable, and each exit code is distinct and documented.

**Architecture:** Two new modules under `src/cli/` — `errors.ts` (a `StyreError` taxonomy with baked-in exit codes) and `output.ts` (the single formatter + a `guard` boundary that catches, renders once, sets `process.exitCode`, and returns without rethrowing, so citty's `runMain` never double-prints a stack trace). A third small module `outcome.ts` maps `RunOutcome` → user sentence + exit code. Existing throw sites at the CLI/config surface are converted to `StyreError`s; deep internal-invariant throws are left plain and render under a "please report" banner.

**Tech Stack:** TypeScript, Bun (`bun test`), `citty` CLI framework, `zod`, embedded SQLite (`bun:sqlite`). Biome for lint/format.

## Global Constraints

- **Never commit to `main`.** Work is on `feat/eng-338-350-cli-output` (already checked out in this worktree).
- **All human/diagnostic output → stderr.** stdout carries only machine payloads (NDJSON in `run`; the `--version` string in `index.ts`). No exceptions added.
- **House message shape:** `styre <cmd>: <headline>`, then optional indented detail lines (2 spaces), then an optional recovery line. One formatter; no site hand-rolls a prefix.
- **Exit-code scheme (sysexits, fine-grained):** `0` success · `1` operational stop (blocked/no-progress) · `64` usage · `65` resume-refused · `69` toolchain-missing · `70` internal bug · `75` parked (and, later, escalated) · `78` config/profile error. Retire the old `2`; `1` no longer means "any thrown error".
- **Outcome sentences (verbatim):** `pr-ready` → "Opened the PR — ready for your review. Waiting on CI + merge approval." · `done` → "Merged and released." · `parked` → "Paused — ran out of budget; resume anytime." · `blocked` → "Stopped — no actionable work remains." · `no-progress` → "Stopped — couldn't make progress." (`escalated` is deferred to ENG-353 — do NOT add it here.)
- **TDD, DRY, YAGNI, frequent commits.** Test command: `bun test <path>`; typecheck: `bun run typecheck`; lint: `bun run lint`.
- **Commit trailers** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5
  ```

---

## File map

- Create `src/cli/errors.ts` — `StyreError` + `EXIT` constants + factories (`usageError`, `configError`, `toolchainError`, `resumeRefusedError`).
- Create `src/cli/output.ts` — `formatMessage`, `renderError`, `renderInternal`, `note`, `guard`.
- Create `src/cli/outcome.ts` — `outcomeSentence`, `exitCodeForOutcome`.
- Modify `src/cli/run.ts` — wrap in `guard`, export unwrapped `runImpl`, convert usage throws, fix `cliError` code, wire exit codes, update stale comment.
- Modify `src/cli/park.ts` — de-throw `finishRunResult` + the inline resume tail; convert resume usage throws; use `exitCodeForOutcome`.
- Modify `src/cli/notify.ts`, `src/cli/setup.ts`, `src/cli/migrate.ts` — wrap in `guard`, export unwrapped impls, stderr rule, usage/config conversions.
- Modify `src/daemon/run-ticket.ts` — rewrite `formatRunSummary`.
- Modify `src/daemon/notify.ts` — align Slack `terminalDecision` wording.
- Modify `src/config/discover.ts`, `src/dispatch/profile.ts` — wrap zod `.parse()` in `configError`.
- Create `src/config/adapter-keys.ts` — exported key lists; modify `src/config/discover.ts` to validate.
- Modify `src/setup/enrich.ts` — thread agent stderr into the failure message.
- Modify tests: `test/cli/run-preflight.test.ts` (assert against `runImpl`).
- Create tests: `test/cli/errors.test.ts`, `test/cli/output.test.ts`, `test/cli/outcome.test.ts`, `test/cli/config-error.test.ts`, `test/cli/adapter-validation.test.ts`, `test/daemon/run-summary.test.ts`.

---

### Task 1: Error taxonomy (`src/cli/errors.ts`)

**Files:**
- Create: `src/cli/errors.ts`
- Test: `test/cli/errors.test.ts`

**Interfaces:**
- Produces: `class StyreError extends Error { readonly code: number; readonly headline: string; readonly detail?: string; readonly recovery?: string }`; `const EXIT` (object of number constants); `usageError(headline: string, recovery?: string): StyreError`; `configError(a: { file: string; field?: string; detail?: string; recovery?: string }): StyreError`; `toolchainError(detail: string): StyreError`; `resumeRefusedError(detail: string, recovery: string): StyreError`.

- [ ] **Step 1: Write the failing test** — `test/cli/errors.test.ts`:

```ts
import { expect, test } from "bun:test";
import { EXIT, StyreError, configError, toolchainError, usageError } from "../../src/cli/errors.ts";

test("StyreError carries code + headline + optional detail/recovery", () => {
  const e = new StyreError({ code: 78, headline: "bad", detail: "d", recovery: "fix it" });
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe(78);
  expect(e.headline).toBe("bad");
  expect(e.detail).toBe("d");
  expect(e.recovery).toBe("fix it");
  expect(e.message).toBe("bad"); // Error.message mirrors the headline
});

test("usageError uses EXIT.USAGE (64)", () => {
  const e = usageError("--ticket is required", "Pass a ticket ref.");
  expect(e.code).toBe(EXIT.USAGE);
  expect(EXIT.USAGE).toBe(64);
  expect(e.recovery).toBe("Pass a ticket ref.");
});

test("configError names the file and defaults a recovery line", () => {
  const e = configError({ file: "/x/config.json", field: "notifier", detail: "got 'slaack'" });
  expect(e.code).toBe(EXIT.CONFIG);
  expect(EXIT.CONFIG).toBe(78);
  expect(e.headline).toContain("/x/config.json");
  expect(e.headline).toContain("notifier");
  expect(e.recovery).toBeDefined();
});

test("toolchainError uses EXIT.TOOLCHAIN_MISSING (69)", () => {
  expect(toolchainError("  - pytest").code).toBe(69);
});
```

- [ ] **Step 2: Run the test to verify it fails** — `bun test test/cli/errors.test.ts` → FAIL ("Cannot find module '../../src/cli/errors.ts'").

- [ ] **Step 3: Write `src/cli/errors.ts`:**

```ts
/** Operator-facing CLI errors with a baked-in process exit code. The error boundary (output.ts
 *  `guard`) renders these once (headline + detail + recovery) and exits with `code`. Anything that
 *  is NOT a StyreError reaching the boundary is treated as an internal bug (EXIT.INTERNAL). */

/** The exit-code space, shared across all four subcommands (sysexits-aligned). */
export const EXIT = {
  OK: 0,
  OPERATIONAL: 1, // blocked / no-progress: ran fine, dead-end a human should look at
  USAGE: 64, // EX_USAGE: CLI misuse
  RESUME_REFUSED: 65, // EX_DATAERR: resume refused, HEAD moved
  TOOLCHAIN_MISSING: 69, // EX_UNAVAILABLE: a required program is not installed
  INTERNAL: 70, // EX_SOFTWARE: unexpected crash / internal invariant
  TEMPFAIL: 75, // EX_TEMPFAIL: parked (and, ENG-353, escalated) — resumable
  CONFIG: 78, // EX_CONFIG: bad config/profile value, unknown adapter, unresolved profile
} as const;

export class StyreError extends Error {
  readonly code: number;
  readonly headline: string;
  readonly detail?: string;
  readonly recovery?: string;
  constructor(args: { code: number; headline: string; detail?: string; recovery?: string }) {
    super(args.headline);
    this.name = "StyreError";
    this.code = args.code;
    this.headline = args.headline;
    this.detail = args.detail;
    this.recovery = args.recovery;
  }
}

export function usageError(headline: string, recovery?: string): StyreError {
  return new StyreError({ code: EXIT.USAGE, headline, recovery });
}

export function configError(a: {
  file: string;
  field?: string;
  detail?: string;
  recovery?: string;
}): StyreError {
  const headline = a.field ? `invalid config — ${a.field} (${a.file})` : `invalid config — ${a.file}`;
  return new StyreError({
    code: EXIT.CONFIG,
    headline,
    detail: a.detail,
    recovery: a.recovery ?? "Fix the value and re-run.",
  });
}

export function toolchainError(detail: string): StyreError {
  return new StyreError({
    code: EXIT.TOOLCHAIN_MISSING,
    headline: "cannot start — required commands are not runnable on this machine",
    detail,
    recovery: "Install the missing tool(s) and re-run.",
  });
}

export function resumeRefusedError(detail: string, recovery: string): StyreError {
  return new StyreError({
    code: EXIT.RESUME_REFUSED,
    headline: "resume refused: branch HEAD moved since the parked attempt",
    detail,
    recovery,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes** — `bun test test/cli/errors.test.ts` → PASS.

- [ ] **Step 5: Commit:**

```bash
git add src/cli/errors.ts test/cli/errors.test.ts
git commit -m "feat(cli): StyreError taxonomy + sysexits exit codes (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 2: Formatter + boundary (`src/cli/output.ts`)

**Files:**
- Create: `src/cli/output.ts`
- Test: `test/cli/output.test.ts`

**Interfaces:**
- Consumes (Task 1): `StyreError`, `EXIT`.
- Produces: `formatMessage(cmd: string, headline: string, detail?: string, recovery?: string): string`; `renderError(cmd: string, e: StyreError): string`; `renderInternal(cmd: string, err: unknown): string`; `note(cmd: string, msg: string): void`; `async guard(cmd: string, body: () => Promise<void>): Promise<void>`.
- Behaviour contract for `guard`: runs `body`; on a `StyreError` writes `renderError` to stderr and sets `process.exitCode = e.code`; on any other throw writes `renderInternal` and sets `process.exitCode = EXIT.INTERNAL`; **never rethrows**. A clean return leaves `process.exitCode` untouched.

- [ ] **Step 1: Write the failing test** — `test/cli/output.test.ts`:

```ts
import { expect, test } from "bun:test";
import { EXIT, StyreError, configError } from "../../src/cli/errors.ts";
import { formatMessage, guard, renderError, renderInternal } from "../../src/cli/output.ts";

test("formatMessage prefixes styre <cmd>: and indents detail", () => {
  const s = formatMessage("run", "boom", "line1\nline2", "do this");
  expect(s).toBe("styre run: boom\n  line1\n  line2\ndo this");
});

test("renderError renders a StyreError's headline/detail/recovery", () => {
  const s = renderError("run", configError({ file: "/c.json", field: "notifier", detail: "got 'x'" }));
  expect(s).toContain("styre run: invalid config");
  expect(s).toContain("/c.json");
  expect(s).toContain("got 'x'");
});

test("renderInternal shows a please-report banner, message as detail, no stack by default", () => {
  const s = renderInternal("run", new Error("kaboom"));
  expect(s).toContain("internal error");
  expect(s).toContain("kaboom");
  expect(s).not.toContain("at "); // no stack frames without DEBUG
});

test("guard: StyreError → renders once, sets its code, does not rethrow", async () => {
  process.exitCode = 0;
  await guard("run", async () => {
    throw new StyreError({ code: EXIT.CONFIG, headline: "bad config" });
  });
  expect(process.exitCode).toBe(EXIT.CONFIG);
  process.exitCode = 0; // reset for the suite
});

test("guard: non-StyreError → EXIT.INTERNAL, no rethrow", async () => {
  process.exitCode = 0;
  await guard("run", async () => {
    throw new Error("unexpected");
  });
  expect(process.exitCode).toBe(EXIT.INTERNAL);
  process.exitCode = 0;
});

test("guard: clean body leaves exitCode untouched", async () => {
  process.exitCode = 0;
  await guard("run", async () => {
    process.exitCode = 75; // e.g. parked
  });
  expect(process.exitCode).toBe(75);
  process.exitCode = 0;
});
```

- [ ] **Step 2: Run the test to verify it fails** — `bun test test/cli/output.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `src/cli/output.ts`:**

```ts
import { EXIT, StyreError } from "./errors.ts";

/** The one place operator text is shaped: `styre <cmd>: <headline>`, indented detail, recovery. */
export function formatMessage(
  cmd: string,
  headline: string,
  detail?: string,
  recovery?: string,
): string {
  const lines = [`styre ${cmd}: ${headline}`];
  if (detail) for (const l of detail.split("\n")) lines.push(`  ${l}`);
  if (recovery) lines.push(recovery);
  return lines.join("\n");
}

export function renderError(cmd: string, e: StyreError): string {
  return formatMessage(cmd, e.headline, e.detail, e.recovery);
}

const ISSUES_URL = "https://github.com/Twinning-Labs/styre/issues";

export function renderInternal(cmd: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = process.env.DEBUG && err instanceof Error && err.stack ? err.stack : msg;
  return formatMessage(cmd, `internal error — please report at ${ISSUES_URL}`, detail);
}

/** An informational line, house-styled, to stderr. */
export function note(cmd: string, msg: string): void {
  process.stderr.write(`${formatMessage(cmd, msg)}\n`);
}

/** The error boundary. Wrap each subcommand's body so citty's runMain never sees a throw (its
 *  catch is the only place it double-prints + exits 1). Renders once, sets the exit code, returns. */
export async function guard(cmd: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (err instanceof StyreError) {
      process.stderr.write(`${renderError(cmd, err)}\n`);
      process.exitCode = err.code;
    } else {
      process.stderr.write(`${renderInternal(cmd, err)}\n`);
      process.exitCode = EXIT.INTERNAL;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes** — `bun test test/cli/output.test.ts` → PASS.

- [ ] **Step 5: Commit:**

```bash
git add src/cli/output.ts test/cli/output.test.ts
git commit -m "feat(cli): shared output formatter + error boundary (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 3: Outcome vocabulary + exit codes (`src/cli/outcome.ts`)

**Files:**
- Create: `src/cli/outcome.ts`
- Test: `test/cli/outcome.test.ts`

**Interfaces:**
- Consumes (Task 1): `EXIT`. Consumes existing type `RunOutcome` from `src/daemon/run-ticket.ts` (`"pr-ready" | "done" | "blocked" | "no-progress" | "parked"`).
- Produces: `outcomeSentence(o: RunOutcome): string`; `exitCodeForOutcome(o: RunOutcome): number`.

- [ ] **Step 1: Write the failing test** — `test/cli/outcome.test.ts`:

```ts
import { expect, test } from "bun:test";
import { exitCodeForOutcome, outcomeSentence } from "../../src/cli/outcome.ts";

test("sentences match the approved vocabulary", () => {
  expect(outcomeSentence("pr-ready")).toBe(
    "Opened the PR — ready for your review. Waiting on CI + merge approval.",
  );
  expect(outcomeSentence("done")).toBe("Merged and released.");
  expect(outcomeSentence("parked")).toBe("Paused — ran out of budget; resume anytime.");
  expect(outcomeSentence("blocked")).toBe("Stopped — no actionable work remains.");
  expect(outcomeSentence("no-progress")).toBe("Stopped — couldn't make progress.");
});

test("exit codes: success 0, operational stop 1, parked 75", () => {
  expect(exitCodeForOutcome("pr-ready")).toBe(0);
  expect(exitCodeForOutcome("done")).toBe(0);
  expect(exitCodeForOutcome("blocked")).toBe(1);
  expect(exitCodeForOutcome("no-progress")).toBe(1);
  expect(exitCodeForOutcome("parked")).toBe(75);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/cli/outcome.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `src/cli/outcome.ts`:**

```ts
import type { RunOutcome } from "../daemon/run-ticket.ts";
import { EXIT } from "./errors.ts";

/** The user-facing sentence for a terminal outcome (presentation layer, NOT a state rename).
 *  `escalated` is intentionally absent — it is not a RunOutcome yet (ENG-353). */
export function outcomeSentence(o: RunOutcome): string {
  switch (o) {
    case "pr-ready":
      return "Opened the PR — ready for your review. Waiting on CI + merge approval.";
    case "done":
      return "Merged and released.";
    case "parked":
      return "Paused — ran out of budget; resume anytime.";
    case "blocked":
      return "Stopped — no actionable work remains.";
    case "no-progress":
      return "Stopped — couldn't make progress.";
  }
}

export function exitCodeForOutcome(o: RunOutcome): number {
  switch (o) {
    case "pr-ready":
    case "done":
      return EXIT.OK;
    case "parked":
      return EXIT.TEMPFAIL;
    case "blocked":
    case "no-progress":
      return EXIT.OPERATIONAL;
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test test/cli/outcome.test.ts` → PASS.

- [ ] **Step 5: Commit:**

```bash
git add src/cli/outcome.ts test/cli/outcome.test.ts
git commit -m "feat(cli): outcome sentences + per-outcome exit codes (ENG-338)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 4: Wrap `config.json` / `profile.json` zod parse in `configError`

**Files:**
- Modify: `src/config/discover.ts:51-57` (both `RuntimeConfigSchema.parse` calls), `src/dispatch/profile.ts:144` (`ProfileSchema.parse` in `parseProfile`)
- Test: `test/cli/config-error.test.ts`

**Interfaces:**
- Consumes (Task 1): `configError`, `StyreError`.
- Produces: a shared helper `parseConfigOrThrow<T>(schema, raw, file): T` in `src/config/discover.ts` (exported for reuse by profile). Signature: `parseConfigOrThrow<T>(schema: { parse(x: unknown): T }, raw: unknown, file: string): T`.

- [ ] **Step 1: Write the failing test** — `test/cli/config-error.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRuntimeConfig } from "../../src/config/discover.ts";
import { StyreError } from "../../src/cli/errors.ts";

test("a bad config value throws a StyreError naming the file + field, not a ZodError", () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ notifier: "slaack" }));
  try {
    discoverRuntimeConfig({ explicitPath: path });
    throw new Error("expected a throw");
  } catch (e) {
    expect(e).toBeInstanceOf(StyreError);
    const se = e as StyreError;
    expect(se.code).toBe(78);
    expect(se.headline).toContain(path);
    expect(se.headline.toLowerCase()).toContain("notifier");
  }
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/cli/config-error.test.ts` → FAIL (a raw `ZodError` is thrown, not a `StyreError`).

- [ ] **Step 3: Add the helper and use it.** In `src/config/discover.ts`, add imports at the top and the helper, and replace the two `RuntimeConfigSchema.parse(...)` calls:

```ts
// add near the other imports
import { ZodError } from "zod";
import { configError } from "../cli/errors.ts";

/** Parse `raw` with `schema`, converting a ZodError into a file-named ConfigError. */
export function parseConfigOrThrow<T>(
  schema: { parse(x: unknown): T },
  raw: unknown,
  file: string,
): T {
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first ? first.path.join(".") || "(root)" : "(root)";
      const detail = err.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw configError({ file, field, detail, recovery: "Fix the value and re-run." });
    }
    throw err;
  }
}
```

Then replace line 52:
```ts
    return parseConfigOrThrow(RuntimeConfigSchema, JSON.parse(readFileSync(opts.explicitPath, "utf8")), opts.explicitPath);
```
and the return at line 57 (compute the effective file path for the message — the per-project file if present else the global):
```ts
  const file = opts.slug ? join(home, opts.slug, "config.json") : join(home, "config.json");
  return parseConfigOrThrow(RuntimeConfigSchema, { ...global, ...perProject }, file);
```

- [ ] **Step 4: Wire `profile.ts`.** In `src/dispatch/profile.ts`, import the helper and replace the final `return ProfileSchema.parse(raw);` in `parseProfile`. Because `parseProfile` has no path, thread the file through `loadProfile`:

```ts
// import
import { parseConfigOrThrow } from "../config/discover.ts";

// change parseProfile signature to accept an optional file label:
export function parseProfile(raw: unknown, file = "profile.json"): Profile {
  // ... existing legacy-schema guards unchanged ...
  return parseConfigOrThrow(ProfileSchema, raw, file);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")), path);
}
```

(Existing callers of `parseProfile(raw)` in tests still compile — `file` defaults.)

- [ ] **Step 5: Run to verify + typecheck** — `bun test test/cli/config-error.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 6: Commit:**

```bash
git add src/config/discover.ts src/dispatch/profile.ts test/cli/config-error.test.ts
git commit -m "fix(config): file-named ConfigError instead of a raw ZodError dump (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 5: Validate adapter values against exported key lists

**Files:**
- Create: `src/config/adapter-keys.ts`
- Modify: `src/config/discover.ts` (add `validateAdapters`, call it at the end of `discoverRuntimeConfig`)
- Test: `test/cli/adapter-validation.test.ts`

**Interfaces:**
- Consumes (Task 1): `configError`.
- Produces: in `adapter-keys.ts` — `const ISSUE_TRACKER_KEYS = ["linear", "jira"] as const`, `const FORGE_KEYS = ["github"] as const`, `const PROVIDER_KEYS = ["claude", "codex"] as const`, `const NOTIFIER_KEYS = ["none", "slack"] as const`. In `discover.ts` — `validateAdapters(config: RuntimeConfig, file: string): void`.
- Note: these lists mirror the inline maps at `daemon/ports.ts:31-47` and `agent/resolve.ts:10-13`. `notifier` intentionally includes `"none"` (a non-adapter sentinel).

- [ ] **Step 1: Write the failing test** — `test/cli/adapter-validation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRuntimeConfig } from "../../src/config/discover.ts";
import { StyreError } from "../../src/cli/errors.ts";

function cfg(obj: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "styre-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  discoverRuntimeConfig({ explicitPath: path });
}

test("an unknown issueTracker throws a ConfigError listing valid values", () => {
  try {
    cfg({ issueTracker: "liner" });
    throw new Error("expected a throw");
  } catch (e) {
    expect(e).toBeInstanceOf(StyreError);
    expect((e as StyreError).code).toBe(78);
    expect((e as StyreError).detail ?? (e as StyreError).headline).toContain("linear");
  }
});

test("notifier 'none' is accepted (sentinel, not an adapter)", () => {
  expect(() => cfg({ notifier: "none" })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/cli/adapter-validation.test.ts` → the first test FAILS (today `issueTracker:"liner"` parses fine and only blows up later in `selectIssueTracker`).

- [ ] **Step 3: Create `src/config/adapter-keys.ts`:**

```ts
/** The valid adapter keys, mirrored from the wiring maps (daemon/ports.ts, agent/resolve.ts).
 *  Kept here so config validation can name the valid values without importing the adapters. */
export const ISSUE_TRACKER_KEYS = ["linear", "jira"] as const;
export const FORGE_KEYS = ["github"] as const;
export const PROVIDER_KEYS = ["claude", "codex"] as const;
export const NOTIFIER_KEYS = ["none", "slack"] as const; // "none" is a sentinel, not an adapter
```

- [ ] **Step 4: Add `validateAdapters` in `src/config/discover.ts` and call it.** Add the import and function, and call it before returning the parsed config in both branches of `discoverRuntimeConfig`:

```ts
import {
  FORGE_KEYS,
  ISSUE_TRACKER_KEYS,
  NOTIFIER_KEYS,
  PROVIDER_KEYS,
} from "./adapter-keys.ts";

function validateAdapters(config: RuntimeConfig, file: string): void {
  const checks: Array<[string, string, readonly string[]]> = [
    ["issueTracker", config.issueTracker, ISSUE_TRACKER_KEYS],
    ["forge", config.forge, FORGE_KEYS],
    ["notifier", config.notifier, NOTIFIER_KEYS],
  ];
  if (config.agent?.provider) checks.push(["agent.provider", config.agent.provider, PROVIDER_KEYS]);
  for (const [field, value, valid] of checks) {
    if (!valid.includes(value)) {
      throw configError({
        file,
        field,
        detail: `got '${value}'. Valid values: ${valid.join(", ")}.`,
      });
    }
  }
}
```

Then wrap each `return parseConfigOrThrow(...)` so the parsed config is validated before return, e.g.:

```ts
  if (opts.explicitPath && opts.explicitPath.length > 0) {
    const parsed = parseConfigOrThrow(RuntimeConfigSchema, JSON.parse(readFileSync(opts.explicitPath, "utf8")), opts.explicitPath);
    validateAdapters(parsed, opts.explicitPath);
    return parsed;
  }
  // ...
  const parsed = parseConfigOrThrow(RuntimeConfigSchema, { ...global, ...perProject }, file);
  validateAdapters(parsed, file);
  return parsed;
```

- [ ] **Step 5: Run to verify + typecheck** — `bun test test/cli/adapter-validation.test.ts` → PASS; `bun run typecheck` → clean. (Sanity: `RuntimeConfigSchema` must expose `issueTracker`/`forge`/`notifier` as strings and optional `agent.provider` — confirmed in `src/config/runtime-config.ts:15,28` and `src/config/agent-config.ts:8`.)

- [ ] **Step 6: Commit:**

```bash
git add src/config/adapter-keys.ts src/config/discover.ts test/cli/adapter-validation.test.ts
git commit -m "fix(config): validate adapter values early, naming valid options (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 6: Thread the agent CLI's real stderr into enrichment failures

**Files:**
- Modify: `src/setup/enrich.ts:80-87` (the failure-after-`MAX_ATTEMPTS` throw)
- Test: fold into an existing enrich test if one exists; else add `test/setup/enrich-error.test.ts`.

**Interfaces:**
- Consumes (Task 1): `configError`.

- [ ] **Step 1: Read the current failure path.** `bun run` the read: open `src/setup/enrich.ts`, locate the loop that retries `MAX_ATTEMPTS` times and the final `throw new Error(\`enrichRuntimeContext: agent enrichment failed after ${MAX_ATTEMPTS} attempts: ${lastReason}\`)`. Confirm the block captures `result.stderr` but drops it (only `exit N` / `timed out` survive in `lastReason`).

- [ ] **Step 2: Write the failing test** — `test/setup/enrich-error.test.ts` (inject a fake runner that returns a non-zero exit with stderr text; assert the thrown message contains that stderr). Use the module's existing injection seam (the `deps`/runner parameter `enrichRuntimeContext` already takes — mirror an existing enrich test's setup). Assert:

```ts
expect(String(err)).toContain("boom-from-cli"); // the agent CLI's real stderr survives
```

- [ ] **Step 3: Capture stderr into `lastReason`.** Where the loop sets `lastReason`, include a trimmed slice of `result.stderr` (e.g. `lastReason = \`exit ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}\``), and convert the final throw to a `configError` (it is an operator-fixable auth/credential problem, not a bug):

```ts
throw configError({
  file: "the agent CLI",
  detail: `enrichment failed after ${MAX_ATTEMPTS} attempts: ${lastReason}`,
  recovery: "Check the agent CLI is authenticated (e.g. ANTHROPIC_API_KEY) and re-run styre setup.",
});
```

- [ ] **Step 4: Run to verify it passes** — `bun test test/setup/enrich-error.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Commit:**

```bash
git add src/setup/enrich.ts test/setup/enrich-error.test.ts
git commit -m "fix(setup): surface the agent CLI's real error on enrichment failure (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 7: Wrap all four subcommands in `guard`; export unwrapped impls; stderr rule

**Files:**
- Modify: `src/cli/run.ts`, `src/cli/notify.ts`, `src/cli/setup.ts`, `src/cli/migrate.ts`
- Modify: `test/cli/run-preflight.test.ts` (call the unwrapped impl)
- Modify: `src/index.ts` — no code change needed (subcommands self-guard), but confirm.

**Interfaces:**
- Consumes (Task 2): `guard`, `note`. Consumes (Task 1): `usageError`.
- Produces: each subcommand exports its unwrapped body — `runImpl(ctx)`, `notifyImpl(ctx)`, `setupImpl(ctx)`, `migrateImpl(ctx)` — and its `defineCommand` `run` is `(ctx) => guard("<cmd>", () => <impl>(ctx))`.

- [ ] **Step 1: `run.ts` — extract + wrap + fix cliError code + convert usage throws.**
  - Move the current `async run({ args }) { ... }` body into `export async function runImpl({ args }: { args: ... }): Promise<void>` (keep the exact body). Change the command to:
    ```ts
    export const runCommand = defineCommand({
      meta: { ... },
      args: { ... },
      run: (ctx) => guard("run", () => runImpl(ctx as { args: RunArgs })),
    });
    ```
    (Define `type RunArgs = ...` or reuse citty's inferred arg type via `Parameters`.)
  - Convert the two usage throws to `usageError`:
    - line 86-88 → `throw usageError("no --profile given and the current directory is not a git repo", "cd into the target repo, or pass --profile / --slug.");`
    - line 133 → `throw usageError("--ticket is required when not using --resume", "Pass a ticket ref, e.g. styre run ENG-123.");`
  - Replace the toolchain branch (`console.error(formatMissingTools(...))` + `process.exitCode = 69`) with a throw so it renders through the boundary:
    ```ts
    if (missingTools.length > 0) throw toolchainError(formatMissingTools(missingTools));
    ```
    Import `toolchainError`. (`EX_TOOLCHAIN_MISSING` const + the manual `console.error` are removed; `formatMissingTools` now returns just the indented body — see Task 8 note below; for this task keep passing its existing string and let `toolchainError` wrap it.)
  - Fix the `cliError` exit code (independent-review finding): in the `catch (err)` block, compute the code from the error itself, not the unset `process.exitCode`:
    ```ts
    } catch (err) {
      const { StyreError } = await import("./errors.ts");
      const code = err instanceof StyreError ? err.code : 70;
      analytics.cliError({ command: "run", exitCode: code, errorClass: err instanceof Error ? err.constructor.name : "Unknown" });
      throw err; // rethrow → guard renders + sets process.exitCode
    } finally {
      await analytics.shutdown();
    }
    ```
    (Prefer a top-of-file `import { StyreError } from "./errors.ts";` over the dynamic import.)
  - Replace the two `console.error(...)` human lines (the notifier banner at 98-100 → keep as-is on stderr, or route through `note("run", ...)`) — at minimum leave them on stderr. The IN-PLACE `console.error` at 113 stays stderr (acceptable; wording cleanup optional).
  - Update the stale exit-code doc comment at `run.ts:25-28` to the new scheme.

- [ ] **Step 2: `run.ts` — update `finishRunResult` call to set exit codes for operational stops.** After Task 10 de-throws `finishRunResult`, the fresh-run tail (currently line 203) becomes:
    ```ts
    finishRunResult(db, dbPath, profile.slug, ident, out); // sets exitCode for parked/blocked/no-progress
    ```
    No further change here (Task 10 owns `finishRunResult`).

- [ ] **Step 3: `notify.ts` — wrap + convert usage + retire exit 2.** Move the body to `export async function notifyImpl(ctx)`; `run: (ctx) => guard("notify", () => notifyImpl(ctx))`. Replace the `!args.test` branch (`process.stderr.write(...); process.exitCode = 2`) with `throw usageError("notify requires --test", "Run: styre notify --test");`. Convert the `no notifier configured` throw to `configError`/`usageError` as fits.

- [ ] **Step 4: `migrate.ts` + `setup.ts` — wrap + stderr rule.** Each: move body to `export async function <cmd>Impl(ctx)`; `run: (ctx) => guard("<cmd>", () => <cmd>Impl(ctx))`. In `setup.ts`, change every operator `console.log(...)` (lines 147-161, 263, 266, 271, 272) to `process.stderr.write(... + "\n")` (or `note("setup", ...)` for the prefixed lines) — human output → stderr. Fix the double space at line 272 (`run with  styre` → `run with styre`). `migrate.ts:14` `console.log` → stderr.

- [ ] **Step 5: Update `test/cli/run-preflight.test.ts`.** Change the direct invocation from the wrapped command to the unwrapped impl so throws are observable:
    ```ts
    import { runImpl } from "../../src/cli/run.ts";
    // inside invokeRun:
    await runImpl({ args: { _: [], ...args } as never });
    ```
    The two `await expect(invokeRun(...)).rejects.toThrow(/no parked run/)` assertions now pass because `runImpl` still throws (the guard is bypassed in the test). Keep the `expect(process.exitCode).not.toBe(69)` assertions.

- [ ] **Step 6: Run the affected suites + typecheck.**
    Run: `bun test test/cli/run-preflight.test.ts test/cli/notify-test.test.ts test/cli/setup.test.ts test/cli.test.ts` → PASS. Run: `bun run typecheck` → clean. If `setup.test.ts` asserted on stdout content, switch those assertions to the captured stderr (the `--version` stdout test in `cli.test.ts` is unaffected — it stays on stdout via `index.ts:15`).

- [ ] **Step 7: Commit:**

```bash
git add src/cli/run.ts src/cli/notify.ts src/cli/setup.ts src/cli/migrate.ts test/cli/run-preflight.test.ts
git commit -m "feat(cli): route all four subcommands through the error boundary; stderr rule (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 8: Rewrite `formatRunSummary` (sentence + PR URL + pending signal + timeline)

**Files:**
- Modify: `src/daemon/run-ticket.ts:176-187` (`formatRunSummary`)
- Test: `test/daemon/run-summary.test.ts`

**Interfaces:**
- Consumes (Task 3): `outcomeSentence`. Consumes existing: `getDeliveredPayload`, `listPending` (`src/db/repos/signal.ts`), `listByTicket` (`src/db/repos/event-log.ts`, already imported), `EventLogRow` type.
- Produces: the rewritten `formatRunSummary(db, ticketId, result): string` (same signature) + a private `timelineLine(e: EventLogRow): string`.

- [ ] **Step 1: Write the failing test** — `test/daemon/run-summary.test.ts`. Build an in-memory SoT (mirror the setup used by existing `test/daemon` tests — `migrate` a temp DB, `insertProject`/`insertTicket`, append events, insert a delivered `external_pr_result` signal), then assert:

```ts
// pr-ready with a delivered PR url:
const s = formatRunSummary(db, ticketId, { outcome: "pr-ready", iterations: 7, stage: "merge", status: "waiting" });
expect(s).toContain("Opened the PR — ready for your review.");
expect(s).toContain("PR: https://github.com/x/y/pull/1");
expect(s).not.toContain("status=waiting"); // no bare internal status

// a loopback event surfaces loop/route/signature, not the bare word:
// (append a loopback event with loop="design", route_to="review", signature="a:1|b:2|c:3")
expect(s2).toContain("loopback design → review");
expect(s2).toContain("a:1 (+2 more)");

// blocked with a pending human_resume names it:
expect(s3).toContain("Stopped — no actionable work remains.");
expect(s3).toContain("Waiting on: human_resume");
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/daemon/run-summary.test.ts` → FAIL (current output is `run: pr-ready (stage=merge, status=waiting, 7 ticks)` etc.).

- [ ] **Step 3: Rewrite `formatRunSummary`.** Replace the function body (keep the `listByTicket` import; add `getDeliveredPayload, listPending` to the existing `signal.ts` import, and `EventLogRow` type from `event-log.ts`; import `outcomeSentence` from `../cli/outcome.ts`):

```ts
function firstSignature(sig: string): string {
  const parts = sig.split("|");
  return parts.length > 1 ? `${parts[0]} (+${parts.length - 1} more)` : (parts[0] ?? sig);
}

function timelineLine(e: EventLogRow): string {
  switch (e.kind) {
    case "transition":
      return `transition ${e.from_stage ?? "?"}→${e.to_stage ?? "?"}`;
    case "loopback": {
      const route = e.route_to ? ` → ${e.route_to}` : "";
      const sig = e.signature ? `: ${firstSignature(e.signature)}` : "";
      return `loopback ${e.loop ?? "?"}${route}${sig}`;
    }
    case "escalated":
      return `escalated${e.reason ? ` — ${e.reason}` : ""}`;
    default:
      return `${e.kind}${e.reason ? ` — ${e.reason}` : ""}`;
  }
}

export function formatRunSummary(db: Database, ticketId: number, result: RunResult): string {
  const events = listByTicket(db, ticketId);
  const pr = getDeliveredPayload(db, ticketId, "external_pr_result");
  const prUrl = typeof pr?.url === "string" ? pr.url : undefined;
  const pending = listPending(db, ticketId).map((s) => s.signal_type);
  const lines: string[] = [outcomeSentence(result.outcome)];
  if (prUrl) lines.push(`PR: ${prUrl}`);
  if (pending.length > 0 && result.outcome !== "pr-ready" && result.outcome !== "done") {
    lines.push(`Waiting on: ${pending.join(", ")}`);
  }
  lines.push(`Stage ${result.stage} · ${result.iterations} ticks · ${events.length} events`);
  for (const e of events) lines.push(`  #${e.seq} ${timelineLine(e)}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test test/daemon/run-summary.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Commit:**

```bash
git add src/daemon/run-ticket.ts test/daemon/run-summary.test.ts
git commit -m "feat(run): outcome sentence + PR URL + pending signal + legible timeline (ENG-338)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 9: De-throw `finishRunResult` + the inline resume tail; wire exit codes

**Files:**
- Modify: `src/cli/park.ts:47-63` (`finishRunResult`), `src/cli/park.ts:289-298` (resume tail), `src/cli/park.ts:168-177` (usage throws)
- Test: `test/cli/park.test.ts` (extend or add cases); `test/cli/park-resume-e2e.test.ts` already asserts `exitCode === 75` and must still pass.

**Interfaces:**
- Consumes (Task 3): `exitCodeForOutcome`. Consumes (Task 1): `usageError`, `resumeRefusedError`.
- Produces: `finishRunResult(db, dbPath, slug, ident, out: { outcome: RunOutcome; park?: ParkInfo }): void` — no longer throws; sets `process.exitCode` for parked (75, unchanged), blocked/no-progress (via `exitCodeForOutcome` → 1), leaves success at 0.

- [ ] **Step 1: Write/adjust the failing test** — in `test/cli/park.test.ts`, add:

```ts
test("finishRunResult does not throw for blocked; sets exit 1 and closes db", () => {
  // build a minimal in-memory run.db with one ticket (reuse the file's existing helpers)
  process.exitCode = 0;
  expect(() => finishRunResult(db, dbPath, "slug", "ENG-1", { outcome: "blocked" })).not.toThrow();
  expect(process.exitCode).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test test/cli/park.test.ts -t "does not throw for blocked"` → FAIL (currently throws).

- [ ] **Step 3: Rewrite `finishRunResult`** (import `RunOutcome` type + `exitCodeForOutcome`):

```ts
import type { RunOutcome } from "../daemon/run-ticket.ts";
import { exitCodeForOutcome } from "./outcome.ts";

export function finishRunResult(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  out: { outcome: RunOutcome; park?: ParkInfo },
): void {
  if (out.outcome === "parked" && out.park) {
    dumpPark(db, dbPath, slug, ident, out.park); // closes db
    process.exitCode = exitCodeForOutcome("parked"); // 75
    return;
  }
  db.close();
  process.exitCode = exitCodeForOutcome(out.outcome); // 0 for pr-ready/done, 1 for blocked/no-progress
}
```

(The `test/helpers/run-harness.ts:128` caller still reads `process.exitCode === 75` for the parked path — preserved, since parked still sets 75 inside `finishRunResult`.)

- [ ] **Step 4: De-throw the inline resume tail** (`park.ts:289-298`). Replace:

```ts
  if (result.outcome === "parked" && result.park) {
    dumpPark(db, dbPath, profile.slug, ticket.ident, result.park); // re-dump (closes db)
    process.stderr.write(`${formatMessage("run", `Parked again: ${result.park.cause}. Dump: ${dir}`)}\n`);
    process.exitCode = exitCodeForOutcome("parked"); // 75
    return;
  }
  db.close();
  process.exitCode = exitCodeForOutcome(result.outcome); // 1 for blocked/no-progress, 0 otherwise
```

(Import `formatMessage` from `./output.ts`; drop the `throw`. The summary was already printed at `park.ts:287`.)

- [ ] **Step 5: Convert resume usage throws.** `park.ts:169` `no parked run` → `throw usageError(\`no parked run at ${dbPath}\`, "Check the ticket ident, or start fresh: styre run <ticket>.");`. Convert the HEAD-moved refusal at `park.ts:198-204` to use `resumeRefusedError(...)` **only if** you also route it through the boundary — but resume currently writes to stderr + sets exit 65 directly and returns (not a throw). Keep it as a direct write for now (it is already a good message) OR convert to `throw resumeRefusedError(detail, recovery)` and delete the manual `process.exitCode = 65`. Choose the throw form for consistency:
    ```ts
    if (moved && !args.acceptHead) {
      db.close();
      throw resumeRefusedError(
        `recorded base: ${recorded}\ncurrent head:  ${current}\nwould re-dispatch: ${parkedStep?.step_key ?? "(none)"}`,
        `Re-run with --accept-head to resume against the new HEAD (drops stale transcript), or 'styre run ${ticket.ident}' to start fresh.`,
      );
    }
    ```
    (Because `resumeRun` runs inside `runImpl` under `guard`, the thrown `resumeRefusedError` renders once and exits 65. Verify `run-preflight.test.ts` still asserts against `runImpl` — Task 7 — so the throw is observable.)

- [ ] **Step 6: Run the affected suites** — `bun test test/cli/park.test.ts test/cli/park-resume-e2e.test.ts test/cli/head-guard-e2e.test.ts` → PASS. `bun run typecheck` → clean. If `head-guard-e2e.test.ts` asserted on the old `resume refused:` string via stderr capture, update it to assert the new rendered `styre run: resume refused` text and `exitCode === 65`.

- [ ] **Step 7: Commit:**

```bash
git add src/cli/park.ts test/cli/park.test.ts test/cli/head-guard-e2e.test.ts
git commit -m "fix(run): render operational stops instead of throwing a stack trace (ENG-338)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 10: Align Slack wording to the new vocabulary

**Files:**
- Modify: `src/daemon/notify.ts:37-48` (`terminalDecision`), and the `blocked` terminal ping at `:106-111`
- Test: `test/daemon/notify.test.ts` (or the existing notify test file) — assert no `gave up`.

**Interfaces:**
- Consumes (Task 3): `outcomeSentence` (optional — or inline consistent strings).

- [ ] **Step 1: Write the failing test** — assert `terminalDecision("no-progress")?.event` no longer contains "gave up" and reads consistently with the terminal (e.g. `"Stopped — couldn't make progress."`), and the `blocked` dead-end ping reads `"Stopped — no actionable work remains."` not `"gave up (blocked)"`.

```ts
import { expect, test } from "bun:test";
// terminalDecision is module-private; test via createNotifier's enqueued payload, or export it.
```

If `terminalDecision` is private, export it for the test (small, acceptable) or assert via the enqueued outbox payload as the existing notify test does.

- [ ] **Step 2: Run to verify it fails** — FAIL (current strings are `"gave up (no progress)"` / `"gave up (blocked)"`).

- [ ] **Step 3: Update the strings** in `terminalDecision` and the `blocked` ping to match the outcome vocabulary:
    - `no-progress` → `{ severity: "high", event: "Stopped — couldn't make progress." }`
    - the `blocked` dead-end ping (`:110`) → `buildMsg(db, ticketId, "Stopped — no actionable work remains.", "high")`.
    Leave `pr-ready`/`done`/`parked`/`escalated` event labels as-is (they read fine and `escalated` is ENG-353's).

- [ ] **Step 4: Run to verify + typecheck** — `bun test test/daemon/notify.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Commit:**

```bash
git add src/daemon/notify.ts test/daemon/notify.test.ts
git commit -m "fix(notify): align Slack wording with the run vocabulary; drop 'gave up' (ENG-338)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 11: `formatMissingTools` returns the body only (toolchainError owns the frame)

**Files:**
- Modify: `src/cli/preflight.ts:83-92` (`formatMissingTools`)
- Test: `test/cli/preflight.test.ts` (adjust the asserted string)

**Interfaces:**
- Produces: `formatMissingTools(missing): string` returning only the indented `- [comp / label] \`cmd\`  (missing: x)` lines (no headline/recovery — `toolchainError` in Task 7 supplies those).

- [ ] **Step 1: Adjust the test** — `test/cli/preflight.test.ts`: assert the output contains the per-command lines but NOT the old `"styre run: cannot start"` headline (that moves to `toolchainError`). Then combined, `renderError("run", toolchainError(formatMissingTools(m)))` contains both.

- [ ] **Step 2: Run to verify it fails** — FAIL (current function includes the headline + "Install…" line).

- [ ] **Step 3: Trim `formatMissingTools`** to the body:

```ts
export function formatMissingTools(missing: MissingCommand[]): string {
  return missing
    .map((m) => `- [${m.component} / ${m.label}] \`${m.command}\`  (missing: ${m.missing})`)
    .join("\n");
}
```

- [ ] **Step 4: Run to verify + typecheck** — `bun test test/cli/preflight.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Commit:**

```bash
git add src/cli/preflight.ts test/cli/preflight.test.ts
git commit -m "refactor(cli): formatMissingTools body-only; toolchainError frames it (ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

---

### Task 12: Full-suite green + transcript re-render sanity + open the draft PR

**Files:** none new — verification + delivery.

- [ ] **Step 1: Run the whole suite** — `bun test` → all PASS. Fix any test that asserted an old string/exit code (search: `bun test 2>&1 | grep -i fail`). Likely touch points already enumerated: `run-preflight`, `park`, `head-guard-e2e`, `notify`, `preflight`, `setup`, `run-analytics`.

- [ ] **Step 2: Lint + typecheck** — `bun run lint` and `bun run typecheck` → clean. Run `bun run format` if lint flags formatting.

- [ ] **Step 3: Sanity — the audit transcripts re-render correctly.** Add one integration assertion in `test/daemon/run-summary.test.ts` reproducing the STYRE-7 shape (escalation → `blocked` outcome, a delivered PR? no PR for STYRE-7; pending `human_resume`): assert the summary reads `"Stopped — no actionable work remains."` + `"Waiting on: human_resume"` and contains NO stack trace and NO `no-progress` literal. For a pr-ready shape with a delivered `external_pr_result`, assert the PR URL prints and the success sentence shows. (This is the ENG-338 acceptance check, mechanized.)

- [ ] **Step 4: Commit any final test fixups:**

```bash
git add -A
git commit -m "test(cli): reconcile suite with the new output vocabulary + exit codes (ENG-338, ENG-350)" -m "$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01P8D9cinMbdQqwcBGQYv8H5')"
```

- [ ] **Step 5: Push + open ONE draft PR closing both tickets.**

```bash
git push -u origin feat/eng-338-350-cli-output
gh pr create --draft --title "CLI output layer + run outcome content (ENG-338, ENG-350)" --body "$(cat <<'BODY'
Implements the shared CLI output layer (ENG-350) and the run outcome content (ENG-338) from docs/brainstorms/2026-07-21-cli-output-layer-design.md.

- StyreError taxonomy + single formatter + error boundary before citty (no more double-printed stack traces; internal bugs render as "please report", exit 70)
- sysexits fine-grained exit codes (0/1/64/65/69/70/75/78), documented
- ConfigError for bad config/profile (names the file + field) and unknown adapters (names valid values)
- run summary: outcome sentence + PR URL on every outcome + pending signal + legible loopback timeline; operational stops no longer throw
- Slack wording aligned; "gave up" gone
- all human output → stderr

escalated (ENG-353) intentionally out of scope.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Self-review

**Spec coverage:** ENG-350 substrate → Tasks 1,2,7; migrations → 4 (zod), 5 (adapters), 6 (enrich); internal-throws-left-plain → covered by guard (Task 2) + selective conversions (Task 7,9). ENG-338 → outcome vocab (Task 3), summary rewrite/PR URL/pending/timeline (Task 8), de-throw + exit codes (Task 9), Slack (Task 10), toolchain framing (Task 11). Stream rule → Task 7. Exit-code reconciliation → Tasks 1,3,7,9. Tests + transcript sanity → every task + Task 12. All spec sections map to a task.

**Placeholder scan:** no TBD/TODO; every code step shows real code; test steps show real assertions. Task 6 references the enrich injection seam by pattern (mirror an existing enrich test) rather than quoting it — the file wasn't read line-for-line; the implementer must open `src/setup/enrich.ts` to place the `result.stderr` capture exactly. Flagged there explicitly.

**Type consistency:** `StyreError`/`EXIT`/factory names are used identically across Tasks 1,2,4,5,7,9. `guard(cmd, body)` signature stable (Tasks 2,7). `finishRunResult` widened to `out.outcome: RunOutcome` (Task 9) matches `RunResult.outcome` passed by `run.ts`/`run-harness.ts`. `outcomeSentence`/`exitCodeForOutcome` take `RunOutcome` (Task 3) and receive `result.outcome: RunOutcome` (Tasks 8,9). `formatMissingTools` body-only (Task 11) consumed by `toolchainError` (Task 7) — ordering note: Task 7 references the trimmed form, so land Task 11 before/with Task 7 or keep the `toolchainError` wrap tolerant of the old string (it is — it just wraps whatever string it's given). No signature drift found.
