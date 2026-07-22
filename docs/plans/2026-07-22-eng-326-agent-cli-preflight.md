# Agent-CLI Preflight Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail fast with an actionable, non-retry error when the configured agent CLI (`claude`/`codex`) is missing or below its supported version, instead of letting a missing binary be mislabeled `cause:"transient"` and burn 3 dispatch retries.

**Architecture:** A standalone `preflightAgentCli(config)` probe (PATH check + `<command> --version` parse against a per-provider version floor) is wired into all three pre-dispatch windows — `styre setup`, `styre run` (fresh), and `resumeRun` — each throwing a dedicated `agentCliError` (`StyreError`, exit 69) before any agent is spawned. The provider `catch → transportFailure` classification is left untouched; AC #4 is met by pre-emption.

**Tech Stack:** Bun + TypeScript, `bun:test`, `zod`. No new dependencies (version compare is hand-rolled; no `semver`).

**Design doc:** `docs/brainstorms/2026-07-22-eng-326-agent-cli-preflight-design.md`

## Global Constraints

- Version floors (single source of truth; declared at the provider adapters): `CLAUDE_MIN_CLI_VERSION = "2.1.200"`, `CODEX_MIN_CLI_VERSION = "0.140.0"`.
- Version guard is **floor-only** (no ceiling) and **fail-open on unparseable** `--version` output (present binary + unreadable version ⇒ `ok`).
- Version parsing uses the **last** `N.N(.N)` match in the output (not the first), to avoid a false hard-fail when a line leads with an unrelated dotted number.
- All probe failures exit `EXIT.TOOLCHAIN_MISSING` (69). Never add a `FailureCause` value; never modify the provider `catch` at `claude.ts:152` / `codex.ts:214`.
- No new npm dependency.
- The unauth signal is **env-key inference only** — no extra CLI spawn beyond `--version`.
- `--inspect` (resume modifier) must stay probe-free (exit-0 on a tool-less machine).
- Each task ends green: `bun test` + `bun run lint`.

---

### Task 1: The `preflightAgentCli` probe module + provider version floors

**Files:**
- Create: `src/agent/preflight.ts`
- Modify: `src/agent/providers/claude.ts` (add `CLAUDE_MIN_CLI_VERSION` export, just above `export function claudeAgentRunner` at :87)
- Modify: `src/agent/providers/codex.ts` (add `CODEX_MIN_CLI_VERSION` export, just above `export function codexAgentRunner` at :128)
- Test: `test/agent/preflight.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `requiredEnvFor` from `src/config/agent-config.ts`.
- Produces:
  - `export type AgentCliPreflight = { ok: true; version: string | null; unauthHint?: string } | { ok: false; reason: "missing"; command: string } | { ok: false; reason: "unsupported-version"; command: string; found: string; required: string }`
  - `export function preflightAgentCli(config: AgentConfig, deps?: { onPath?: (command: string) => boolean; runVersion?: (command: string) => { ok: boolean; output: string }; env?: NodeJS.ProcessEnv }): AgentCliPreflight`
  - `export function parseCliVersion(text: string): [number, number, number] | null`
  - `export function compareVersions(a: [number, number, number], b: [number, number, number]): number`
  - `export const CLAUDE_MIN_CLI_VERSION: string` (from `claude.ts`), `export const CODEX_MIN_CLI_VERSION: string` (from `codex.ts`)

- [ ] **Step 1: Add the version-floor constant to the Claude adapter**

In `src/agent/providers/claude.ts`, add this export immediately above `export function claudeAgentRunner(command = "claude")` (currently line 87):

```ts
/** Minimum `claude` CLI version this adapter's flag surface is verified against (ENG-326).
 *  Single source of truth for the preflight probe. Bump when a newer floor is required. */
export const CLAUDE_MIN_CLI_VERSION = "2.1.200";
```

- [ ] **Step 2: Add the version-floor constant to the Codex adapter**

In `src/agent/providers/codex.ts`, add this export immediately above `export function codexAgentRunner(command = "codex")` (currently line 128):

```ts
/** Minimum `codex` CLI version this adapter's flag surface is verified against (ENG-326).
 *  codex is pre-1.0, so the minor component is the significant one. */
export const CODEX_MIN_CLI_VERSION = "0.140.0";
```

- [ ] **Step 3: Write the failing test**

Create `test/agent/preflight.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  compareVersions,
  parseCliVersion,
  preflightAgentCli,
} from "../../src/agent/preflight.ts";
import type { AgentConfig } from "../../src/config/agent-config.ts";

const claudeConfig: AgentConfig = {
  provider: "claude",
  command: "claude",
  models: { deep: "d", standard: "s", cheap: "c" },
};
const codexConfig: AgentConfig = {
  provider: "codex",
  command: "codex",
  models: { deep: "d", standard: "s", cheap: "c" },
};
const env = (e: Record<string, string>): NodeJS.ProcessEnv => e as NodeJS.ProcessEnv;

test("parseCliVersion takes the LAST dotted token (ignores a leading date)", () => {
  expect(parseCliVersion("2.1.216 (Claude Code)")).toEqual([2, 1, 216]);
  expect(parseCliVersion("codex-cli 0.144.6")).toEqual([0, 144, 6]);
  expect(parseCliVersion("2026.07.22 build; claude 2.1.216")).toEqual([2, 1, 216]);
  expect(parseCliVersion("no version here")).toBeNull();
});

test("compareVersions orders by major, then minor, then patch", () => {
  expect(compareVersions([2, 1, 216], [2, 1, 200])).toBe(1);
  expect(compareVersions([2, 1, 200], [2, 1, 200])).toBe(0);
  expect(compareVersions([2, 0, 9], [2, 1, 200])).toBe(-1);
});

test("missing binary → { ok:false, reason:'missing' }", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => false,
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: false, reason: "missing", command: "claude" });
});

test("present + supported version → ok", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.216 (Claude Code)" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: true, version: "2.1.216" });
});

test("present + below floor → unsupported-version with found/required", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "claude 2.0.9" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "unsupported-version",
    command: "claude",
    found: "2.0.9",
    required: "2.1.200",
  });
});

test("codex below its own floor → unsupported-version", () => {
  const r = preflightAgentCli(codexConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "codex-cli 0.139.0" }),
    env: env({ OPENAI_API_KEY: "x" }),
  });
  expect(r).toEqual({
    ok: false,
    reason: "unsupported-version",
    command: "codex",
    found: "0.139.0",
    required: "0.140.0",
  });
});

test("unparseable --version → fail-open (ok, version null)", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "a future format with no dotted number" }),
    env: env({ ANTHROPIC_API_KEY: "x" }),
  });
  expect(r).toEqual({ ok: true, version: null });
});

test("present + required env key unset → ok with unauthHint", () => {
  const r = preflightAgentCli(claudeConfig, {
    onPath: () => true,
    runVersion: () => ({ ok: true, output: "2.1.216" }),
    env: env({}),
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.unauthHint).toMatch(/ANTHROPIC_API_KEY/);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test test/agent/preflight.test.ts`
Expected: FAIL — `Cannot find module '../../src/agent/preflight.ts'`.

- [ ] **Step 5: Write the implementation**

Create `src/agent/preflight.ts`:

```ts
import { type AgentConfig, requiredEnvFor } from "../config/agent-config.ts";
import { CLAUDE_MIN_CLI_VERSION } from "./providers/claude.ts";
import { CODEX_MIN_CLI_VERSION } from "./providers/codex.ts";

/** Result of probing the configured agent CLI before dispatch (ENG-326). `version: null` on the
 *  `ok` branch means the binary is present but its `--version` output was unparseable — fail-open. */
export type AgentCliPreflight =
  | { ok: true; version: string | null; unauthHint?: string }
  | { ok: false; reason: "missing"; command: string }
  | { ok: false; reason: "unsupported-version"; command: string; found: string; required: string };

/** Per-provider minimum CLI version. Single source of truth = the adapter constants. */
const PROVIDER_MIN_VERSION: Record<string, string> = {
  claude: CLAUDE_MIN_CLI_VERSION,
  codex: CODEX_MIN_CLI_VERSION,
};

type Version = [number, number, number];

/** Parse the LAST `N.N(.N)` token in `text`. Last-match (not first) avoids a false hard-fail when
 *  a line leads with an unrelated dotted number (a build date, a runtime version). Missing patch → 0. */
export function parseCliVersion(text: string): Version | null {
  const matches = [...text.matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

/** -1 if a<b, 0 if equal, 1 if a>b (major, then minor, then patch). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

interface PreflightDeps {
  onPath?: (command: string) => boolean;
  runVersion?: (command: string) => { ok: boolean; output: string };
  env?: NodeJS.ProcessEnv;
}

/** PATH-existence check via `command -v` (mirrors probeCommandExists; `sh` always exists, so a
 *  missing binary returns false rather than throwing — we never spawn the missing binary directly). */
function defaultOnPath(command: string): boolean {
  return Bun.spawnSync(["sh", "-c", 'command -v "$1"', "sh", command]).success;
}

function defaultRunVersion(command: string): { ok: boolean; output: string } {
  const r = Bun.spawnSync([command, "--version"], { timeout: 5_000 });
  const dec = new TextDecoder();
  return { ok: r.success, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

function unauthHintFor(provider: string, command: string, env: NodeJS.ProcessEnv): string | undefined {
  const key = requiredEnvFor(provider);
  return key && !env[key]
    ? `${command} is installed but ${key} is unset; it may not be authenticated`
    : undefined;
}

export function preflightAgentCli(config: AgentConfig, deps: PreflightDeps = {}): AgentCliPreflight {
  const onPath = deps.onPath ?? defaultOnPath;
  const runVersion = deps.runVersion ?? defaultRunVersion;
  const env = deps.env ?? process.env;

  // The default command equals the provider name for both built-in adapters (claude.ts:87 /
  // codex.ts:128 factory defaults). config.command overrides it.
  const command = config.command ?? config.provider;

  if (!onPath(command)) return { ok: false, reason: "missing", command };

  const hint = unauthHintFor(config.provider, command, env);
  const withHint = (version: string | null): AgentCliPreflight =>
    hint ? { ok: true, version, unauthHint: hint } : { ok: true, version };

  const floor = PROVIDER_MIN_VERSION[config.provider];
  if (!floor) return withHint(null); // unknown provider: no declared floor, PATH existence is all we assert

  const found = parseCliVersion(runVersion(command).output);
  if (found === null) return withHint(null); // unparseable → fail-open

  const required = parseCliVersion(floor);
  if (required && compareVersions(found, required) < 0) {
    return {
      ok: false,
      reason: "unsupported-version",
      command,
      found: found.join("."),
      required: floor,
    };
  }
  return withHint(found.join("."));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test test/agent/preflight.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Lint, then commit**

Run: `bun run lint`
Expected: no errors.

```bash
git add src/agent/preflight.ts src/agent/providers/claude.ts src/agent/providers/codex.ts test/agent/preflight.test.ts
git commit -m "feat(agent): preflightAgentCli probe + per-provider version floors (ENG-326)"
```

---

### Task 2: The `agentCliError` factory

**Files:**
- Modify: `src/cli/errors.ts` (add `agentCliError` after `toolchainError` at :60)
- Test: `test/cli/errors.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: `StyreError`, `EXIT` (same file).
- Produces: `export function agentCliError(e: { reason: "missing"; command: string } | { reason: "unsupported-version"; command: string; found: string; required: string }): StyreError` — code `EXIT.TOOLCHAIN_MISSING` (69), distinct headline/recovery per reason. (The param shape is a structural subset of the `{ ok: false }` `AgentCliPreflight` variants, so callers pass the probe result directly; `errors.ts` stays free of any `agent/` import.)

- [ ] **Step 1: Write the failing test**

Create (or append to) `test/cli/errors.test.ts`:

```ts
import { expect, test } from "bun:test";
import { agentCliError, EXIT } from "../../src/cli/errors.ts";

test("agentCliError(missing) → exit 69, 'not installed' headline, install recovery", () => {
  const e = agentCliError({ reason: "missing", command: "claude" });
  expect(e.code).toBe(EXIT.TOOLCHAIN_MISSING);
  expect(e.headline).toMatch(/claude is not installed or not on PATH/);
  expect(e.recovery).toMatch(/Install the 'claude' CLI/);
});

test("agentCliError(unsupported-version) → exit 69, upgrade headline naming found+required", () => {
  const e = agentCliError({
    reason: "unsupported-version",
    command: "claude",
    found: "2.0.9",
    required: "2.1.200",
  });
  expect(e.code).toBe(EXIT.TOOLCHAIN_MISSING);
  expect(e.headline).toMatch(/claude 2\.0\.9 is below the supported minimum 2\.1\.200/);
  expect(e.recovery).toMatch(/Upgrade the 'claude' CLI to >= 2\.1\.200/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cli/errors.test.ts`
Expected: FAIL — `agentCliError` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/cli/errors.ts`, add immediately after `toolchainError` (ends at :60):

```ts
/** The configured agent CLI is missing or below its supported version (ENG-326). Distinct from
 *  toolchainError because an out-of-range binary IS runnable — the fix is to upgrade, not install.
 *  Both variants exit 69 (non-retry), so a missing/old CLI never reaches the transient-retry path. */
export function agentCliError(
  e:
    | { reason: "missing"; command: string }
    | { reason: "unsupported-version"; command: string; found: string; required: string },
): StyreError {
  if (e.reason === "missing") {
    return new StyreError({
      code: EXIT.TOOLCHAIN_MISSING,
      headline: `${e.command} is not installed or not on PATH`,
      detail: `Styre dispatches every agent run by shelling out to the '${e.command}' CLI.`,
      recovery: `Install the '${e.command}' CLI, or set agent.command in your profile, then re-run.`,
    });
  }
  return new StyreError({
    code: EXIT.TOOLCHAIN_MISSING,
    headline: `${e.command} ${e.found} is below the supported minimum ${e.required}`,
    detail: `Styre's '${e.command}' adapter is pinned to CLI flags that require ${e.required} or newer.`,
    recovery: `Upgrade the '${e.command}' CLI to >= ${e.required} and re-run.`,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/cli/errors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint, then commit**

Run: `bun run lint`

```bash
git add src/cli/errors.ts test/cli/errors.test.ts
git commit -m "feat(cli): agentCliError factory for missing/out-of-range agent CLI (ENG-326)"
```

---

### Task 3: Wire the probe into `styre run` (fresh path)

**Files:**
- Modify: `src/cli/run.ts` (imports at :6-29; the fresh-run window right after the `preflightToolchain` block at :178-181)
- Test: `test/cli/run-agent-preflight.test.ts`

**Interfaces:**
- Consumes: `preflightAgentCli` (Task 1), `agentCliError` (Task 2), `DEFAULT_AGENT_CONFIG` (already imported at run.ts:7).
- Produces: no new exports; behavioral — `runImpl` throws `agentCliError` (exit 69) before `resolveAgentRunner` (:202) when the agent CLI is missing/old on a fresh run.

- [ ] **Step 1: Write the failing test**

Create `test/cli/run-agent-preflight.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImpl } from "../../src/cli/run.ts";

// Mirrors test/cli/run-preflight.test.ts's harness: run the unwrapped runImpl (bypassing `guard`
// so the throw is observable) with telemetry off and isolated XDG dirs. `state` is where a park
// dump WOULD land — the test asserts nothing is written there.
async function invokeRun(args: Record<string, unknown>, xdg: string, state: string): Promise<void> {
  const prev = {
    t: process.env.STYRE_TELEMETRY,
    c: process.env.XDG_CONFIG_HOME,
    s: process.env.XDG_STATE_HOME,
  };
  process.env.STYRE_TELEMETRY = "0";
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.XDG_STATE_HOME = state;
  process.exitCode = 0;
  try {
    await runImpl({ args: { _: [], ...args } as never });
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.t === undefined) delete process.env.STYRE_TELEMETRY;
    else process.env.STYRE_TELEMETRY = prev.t;
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.c === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.c;
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.s === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.s;
  }
}

// A profile whose toolchain preflight PASSES (build/test run `sh`, which exists) — so the run
// reaches the agent-CLI probe rather than failing earlier on a missing build tool.
function writeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-agentpf-prof-"));
  const path = join(dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      slug: "agentpf-test",
      targetRepo: dir,
      components: [
        {
          name: "api",
          kind: "custom",
          paths: ["**"],
          commands: { build: "sh -c true", test: "sh -c true", check: { unavailable: true } },
        },
      ],
    }),
  );
  return path;
}

// A hermetic runtime config whose agent.command points at a guaranteed-absent binary.
function writeBadAgentConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-agentpf-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      agent: {
        provider: "claude",
        command: "styre-absent-agent-cli-xyz",
        models: { deep: "d", standard: "s", cheap: "c" },
      },
    }),
  );
  return path;
}

test("run: a missing agent CLI throws before dispatch (exit 69 error) and writes no dump", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const state = mkdtempSync(join(tmpdir(), "styre-state-"));
  const profile = writeProfile();
  const config = writeBadAgentConfig();
  await expect(invokeRun({ ticket: "ENG-1", profile, config }, xdg, state)).rejects.toThrow(
    /not installed or not on PATH/,
  );
  // No SoT dump: parkDir would write under <XDG_STATE_HOME>/styre/… — nothing was created.
  expect(existsSync(join(state, "styre"))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cli/run-agent-preflight.test.ts`
Expected: FAIL — the run proceeds past the (not-yet-wired) probe; it does NOT reject with `/not installed or not on PATH/` (it errors later or hangs on dispatch).

- [ ] **Step 3: Add imports**

In `src/cli/run.ts`, add the probe import after line 6 (`import { resolveAgentRunner } ...`):

```ts
import { preflightAgentCli } from "../agent/preflight.ts";
```

And add `agentCliError` to the existing `./errors.ts` import (currently line 26):

```ts
import { EXIT, StyreError, agentCliError, errorKindForExit, toolchainError, usageError } from "./errors.ts";
```

- [ ] **Step 4: Wire the probe (and hoist `agentConfig`)**

In `src/cli/run.ts`, the current toolchain block is:

```ts
    const missingTools = preflightToolchain(profile);
    if (missingTools.length > 0) {
      throw toolchainError(formatMissingTools(missingTools));
    }
```

Immediately after that block, insert the agent-CLI probe:

```ts
    // Fail fast (no retry burn) if the configured agent CLI is missing or below its supported
    // version — BEFORE any DB/dispatch, so a missing binary never reaches the provider spawn and
    // gets mislabeled cause:"transient" and retried 3x (ENG-326).
    const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
    const cliPreflight = preflightAgentCli(agentConfig);
    if (!cliPreflight.ok) throw agentCliError(cliPreflight);
    if (cliPreflight.unauthHint) process.stderr.write(`run: ${cliPreflight.unauthHint}\n`);
```

Then DELETE the now-duplicate declaration further down (currently `const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;`, the line just before `if (getRun(db) === null)` at :192) — `agentConfig` is now declared above and reused by `resolveAgentRunner(agentConfig)` (:202) and `buildDispatchRegistry`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/cli/run-agent-preflight.test.ts`
Expected: PASS. Also run the existing preflight test to confirm no regression:
Run: `bun test test/cli/run-preflight.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Lint, then commit**

Run: `bun run lint`

```bash
git add src/cli/run.ts test/cli/run-agent-preflight.test.ts
git commit -m "feat(run): preflight the agent CLI before first dispatch (ENG-326)"
```

---

### Task 4: Wire the probe into `resumeRun`

**Files:**
- Modify: `src/cli/park.ts` (add `agentCliError` to the `./errors.ts` import; insert the probe in `resumeRun` after the resume-refused block, before the in-place assertions / dispatch)
- Test: `test/cli/park-agent-preflight.test.ts`

**Interfaces:**
- Consumes: `preflightAgentCli` (Task 1), `agentCliError` (Task 2), `DEFAULT_AGENT_CONFIG` (already imported in park.ts).
- Produces: behavioral — `resumeRun` throws `agentCliError` (exit 69) before `buildDispatchRegistry`/`resolveAgentRunner` (:316) when the agent CLI is missing/old, but only after the parked-run existence check and the `--inspect`/resume-refused early returns.

- [ ] **Step 1: Write the failing test**

Create `test/cli/park-agent-preflight.test.ts` (reuses the parked-dump scaffolding pattern from `test/cli/park.test.ts`):

```ts
import { afterEach, expect, test } from "bun:test";

afterEach(() => {
  process.exitCode = 0;
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkDir, resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

/** Real temp git repo with one commit (resumeRun's branchHeadSha needs a repo to run against). */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-agentpf-resume-repo-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("resumeRun: a missing agent CLI throws (exit 69 error) before re-dispatch", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-agentpf-resume-state-"));
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  const repoPath = gitRepo();
  const slug = "agentpf-resume";
  const ident = "ENG-9";

  try {
    // Build the parked-run dump resumeRun reads: <XDG_STATE_HOME>/styre/<slug>/<ident>/run.db.
    const dir = parkDir(slug, ident);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const seedDb = openDb(dbPath);
    const projectId = insertProject(seedDb, { slug, targetRepo: repoPath });
    const ticketId = insertTicket(seedDb, { projectId, ident });
    setTicketStage(seedDb, ticketId, "implement");
    await runStep(seedDb, {
      ticketId,
      stepKey: "provision",
      stepType: "provision",
      effectful: true,
      execute: () => ({ ok: true }),
    });
    seedDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    seedDb.close();

    const profile = parseProfile({
      slug,
      targetRepo: repoPath,
      defaultBranch: "main",
      checksSystem: "none",
    });

    // Runtime config whose agent.command is a guaranteed-absent binary.
    const runtimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      agent: { ...DEFAULT_AGENT_CONFIG, command: "styre-absent-agent-cli-xyz" },
    };

    // buildRegistry sets a flag so we can prove the probe fired BEFORE dispatch.
    let dispatched = false;
    await expect(
      resumeRun({ resume: ident }, profile, runtimeConfig, {
        ports: {
          issueTracker: fakeIssueTracker({
            ticket: {
              ident,
              title: "t",
              description: "b",
              typeLabel: "Feature",
              externalId: "uuid",
              url: null,
            },
          }),
          forge: fakeForge(),
          checks: fakeChecks("passing"),
        },
        buildRegistry: () => {
          dispatched = true;
          throw new Error("should not reach dispatch");
        },
      }),
    ).rejects.toThrow(/not installed or not on PATH/);
    expect(dispatched).toBe(false);
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cli/park-agent-preflight.test.ts`
Expected: FAIL — the probe isn't wired, so `buildRegistry` runs (`dispatched` becomes true) and it rejects with `/should not reach dispatch/`, not `/not installed or not on PATH/`.

- [ ] **Step 3: Add the import**

In `src/cli/park.ts`, add `agentCliError` to the existing `./errors.ts` import (it currently imports `usageError`). For example, if the line is `import { usageError } from "./errors.ts";`, change it to:

```ts
import { agentCliError, usageError } from "./errors.ts";
```

And add the probe import alongside the other `../agent/` imports (park.ts already imports `resolveAgentRunner` from `../agent/resolve.ts`):

```ts
import { preflightAgentCli } from "../agent/preflight.ts";
```

- [ ] **Step 4: Insert the probe**

In `src/cli/park.ts` `resumeRun`, locate the resume-refused block (which ends with `process.exitCode = 65;` then `return;` then `}`), immediately followed by the comment `// Defense-in-depth (whole-branch review I-2 / Task 3 F1):`. Insert the probe between them — after the resume-refused block's closing `}`, before that comment:

```ts
  // Fail fast (no retry burn) if the configured agent CLI is missing or below its supported
  // version — resume dispatches the CLI too (resolveAgentRunner below), and a resume often runs
  // later / on another machine where the CLI may have changed since the park (ENG-326). Placed
  // after the --inspect and resume-refused early-returns so those stay tool-independent, and
  // before any repo mutation or dispatch.
  const cliPreflight = preflightAgentCli(runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG);
  if (!cliPreflight.ok) {
    db.close();
    throw agentCliError(cliPreflight);
  }
  if (cliPreflight.unauthHint) process.stderr.write(`resume: ${cliPreflight.unauthHint}\n`);
```

(The `db.close()` before the throw mirrors the resume-refused branch, which closes `db` before returning — the parked-run db is open at this point.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/cli/park-agent-preflight.test.ts`
Expected: PASS. Confirm the resume-path placement pins hold:
Run: `bun test test/cli/park.test.ts test/cli/park-inplace.test.ts test/cli/run-preflight.test.ts`
Expected: PASS (the `--resume` with no dump still throws `/no parked run/` before the probe, since the probe is after the dump-existence check; `--inspect` still returns before the probe).

- [ ] **Step 6: Lint, then commit**

Run: `bun run lint`

```bash
git add src/cli/park.ts test/cli/park-agent-preflight.test.ts
git commit -m "feat(resume): preflight the agent CLI before re-dispatch (ENG-326)"
```

---

### Task 5: Wire the probe into `styre setup`

**Files:**
- Modify: `src/cli/setup.ts` (add `agentCliError` + `preflightAgentCli` imports; insert the probe after the env-key gate at :262-266, before `resolveAgentRunner` at :267)
- Test: `test/cli/setup-agent-preflight.test.ts`

**Interfaces:**
- Consumes: `preflightAgentCli` (Task 1), `agentCliError` (Task 2); `agentConfig` already computed at setup.ts:260.
- Produces: behavioral — `setupImpl` throws `agentCliError` (exit 69) before invoking the enrichment agent when the agent CLI is missing/old.

- [ ] **Step 1: Write the failing test**

Create `test/cli/setup-agent-preflight.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";

afterEach(() => {
  process.exitCode = 0;
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupImpl } from "../../src/cli/setup.ts";

// A hermetic runtime config whose agent.command points at a guaranteed-absent binary.
function writeBadAgentConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-setup-agentpf-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      agent: {
        provider: "claude",
        command: "styre-absent-agent-cli-xyz",
        models: { deep: "d", standard: "s", cheap: "c" },
      },
    }),
  );
  return path;
}

test("setup: a missing agent CLI fails the gate (exit 69 error) before invoking the agent", async () => {
  // Set the required env key so the EXISTING env-key gate passes and we reach the new CLI probe.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const repo = mkdtempSync(join(tmpdir(), "styre-setup-agentpf-repo-"));
  const config = writeBadAgentConfig();
  try {
    await expect(
      // explicit `repo` arg skips the in-place marker gate; explicit `config` is hermetic.
      setupImpl({ args: { _: [], repo, config } as never }),
    ).rejects.toThrow(/not installed or not on PATH/);
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/cli/setup-agent-preflight.test.ts`
Expected: FAIL — without the probe, setup proceeds to `resolveAgentRunner`/`runSetup` and errors later (or hangs invoking the absent agent), not with `/not installed or not on PATH/`.

- [ ] **Step 3: Add imports**

In `src/cli/setup.ts`, add the probe import right after `import { resolveAgentRunner } from "../agent/resolve.ts";` (line 5):

```ts
import { preflightAgentCli } from "../agent/preflight.ts";
```

`setup.ts` does NOT currently import from `./errors.ts` (its env-key gate throws a plain `Error`), so add a new import line for the factory:

```ts
import { agentCliError } from "./errors.ts";
```

- [ ] **Step 4: Insert the probe**

In `src/cli/setup.ts` `setupImpl`, the current env-key gate is:

```ts
  const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
  const requiredKey = requiredEnvFor(agentConfig.provider);
  if (requiredKey && !process.env[requiredKey]) {
    throw new Error(
      `setup: ${requiredKey} is required for provider '${agentConfig.provider}' (runtime-context prose enrichment)`,
    );
  }
  const runner = resolveAgentRunner(agentConfig);
```

Insert the agent-CLI probe between the env-key gate's closing `}` and `const runner = resolveAgentRunner(agentConfig);`:

```ts
  // The env key alone doesn't prove the CLI is usable. Probe the binary before the write-capable
  // enrichment agent runs, so a missing/old CLI fails the setup gate with an actionable message
  // instead of surfacing later as an opaque transient agent failure (ENG-326).
  const cliPreflight = preflightAgentCli(agentConfig);
  if (!cliPreflight.ok) throw agentCliError(cliPreflight);
  if (cliPreflight.unauthHint) process.stderr.write(`setup: ${cliPreflight.unauthHint}\n`);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/cli/setup-agent-preflight.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + lint, then commit**

Run: `bun test`
Expected: all green (including the existing `test/agent/providers/claude.test.ts` spawn-failure-is-transient test, which is unchanged).
Run: `bun run lint`
Expected: no errors.

```bash
git add src/cli/setup.ts test/cli/setup-agent-preflight.test.ts
git commit -m "feat(setup): preflight the agent CLI in the setup gate (ENG-326)"
```

---

## Acceptance-criteria trace

| Acceptance criterion | Task |
| -- | -- |
| Typed probe result `{ok}｜{missing}｜{unsupportedVersion,…}` (+ unauth) | Task 1 (`AgentCliPreflight`) |
| `styre setup` fails with an actionable message naming binary + required version | Task 2 + Task 5 |
| `styre run` probes before first dispatch; missing/incompatible CLI fails fast, no retry burn | Task 3 (fresh) + Task 4 (resume) |
| Missing binary no longer classified transient on the dispatch path (pre-empted) | Tasks 3 & 4 (throw before `resolveAgentRunner`); provider `catch` untouched |
| Supported version range declared per provider, single source of truth | Task 1 (adapter constants → `PROVIDER_MIN_VERSION`) |
| Tests: present-supported (pass), missing (clear error, no retry burn), present-but-old (clear error); existing dispatch tests still pass | Tasks 1, 3, 4, 5 |
| `bun run lint` + `bun test` green | Every task ends green; Task 5 runs the full suite |
