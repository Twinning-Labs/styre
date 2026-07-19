# Toolchain Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `styre run` fail fast — before any dispatch or spend — when a program the repo's component commands need is not installed on this machine, and move `provision` ahead of the design dispatches so real-install faults also fail before design spend.

**Architecture:** A new pure module (`src/cli/preflight.ts`) enumerates every component command (`prepare`/`build`/`test`/`check`) and probes its leading program via the **existing** `probeCommandExists`. `styre run` calls it in the fresh-run branch only (after the `--resume`/`--inspect` early-return, before ticket ingestion); a miss prints an aggregated message and exits `69` with no SoT dump. Separately, the `provision` step is hoisted to the top of `case "design"` in the resolver. No profile-schema, detector, or `styre setup` change.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, zod profiles, `bun test`, biome (`bun run lint`).

## Global Constraints

- **Never commit to `main`.** Work stays on the `feat/toolchain-preflight-eng-332` branch; merge via PR only.
- **Human/diagnostic output → stderr.** stdout carries only NDJSON telemetry. Use `console.error` / `process.stderr.write`.
- **No new dependencies.** Reuse `probeCommandExists` (`src/setup/discover-schema.ts`), `commandFor` (`src/dispatch/components.ts`).
- **Faithful probe.** Probe exactly the program each command will run; do NOT normalize (never probe `python3` when the command says `pip`).
- **No profile-schema change, no detector change, no `styre setup` change.**
- **Exit codes** already in use: `0` success · `1` crash (thrown) · `2` notifier-config · `65` resume-refused · `75` parked. This plan adds **`69`** (toolchain missing, `EX_UNAVAILABLE`), non-retry. Final cross-command reconciliation is ENG-338's job.
- Run `bun run lint` && `bun test` green before each commit.

---

## File Structure

- **Create** `src/cli/preflight.ts` — the preflight module: `collectToolProbes`, `missingHint`, `preflightToolchain`, `formatMissingTools`. Pure except `preflightToolchain`'s default probe; the probe is injectable for tests.
- **Create** `test/cli/preflight.test.ts` — unit tests (injected fake probe) + one real-probe smoke test.
- **Modify** `src/cli/run.ts` — add the `EX_TOOLCHAIN_MISSING` constant; call the preflight in the fresh-run branch.
- **Create** `test/cli/run-preflight.test.ts` — integration test that a missing tool exits `69` before any dispatch.
- **Modify** `src/daemon/resolver.ts` — hoist the `provision` block above `design:dispatch` in `case "design"`.
- **Modify** `test/daemon/resolver.test.ts` — update the four design-stage ordering tests the hoist changes; add one provision-reuse test.
- **Modify** `test/daemon/advance.test.ts` — four tests seed `design:dispatch` (not `provision`) then drive; provision-first makes them run/throw on `provision`. Seed provision-done first.
- **Modify** `test/daemon/loop.test.ts` — register a `provision` no-op in the `registry()` helper; one test's assertion moves from `design:dispatch` to `provision`.
- **Modify** `test/dispatch/real-dispatch-e2e.test.ts` — the first test drives the real registry from design; provision now runs first (a no-op — no components). Drive twice.

> **Why these three extra files (found by review):** `provision` becomes the **first** `case "design"` step, so any test that seeds `design:dispatch` succeeded (but not `provision`) and then calls `advanceOneStep`/`tick` now hits `provision` first — as a **thrown** `no handler registered for 'provision'` when the test's hand-built registry omits it, or as a shifted step/count when it doesn't. The behavior is still correct (provision no-ops with no components; terminal outcomes are unchanged) — this is pure test maintenance, but it spans more than `resolver.test.ts`.

---

## Task 1: Preflight module

**Files:**
- Create: `src/cli/preflight.ts`
- Test: `test/cli/preflight.test.ts`

**Interfaces:**
- Consumes: `probeCommandExists(repoDir: string, command: string): boolean` (`src/setup/discover-schema.ts`); `commandFor(c: Component, checkType: string): string | undefined` (`src/dispatch/components.ts`); `Profile` (`src/dispatch/profile.ts`).
- Produces:
  - `collectToolProbes(profile: Profile): ToolProbe[]` where `ToolProbe = { component: string; label: "prepare"|"build"|"test"|"check"; command: string; cwd: string }`
  - `missingHint(command: string): string`
  - `preflightToolchain(profile: Profile, probe?: (repoDir: string, command: string) => boolean): MissingCommand[]` where `MissingCommand = { component: string; label: string; command: string; missing: string }`
  - `formatMissingTools(missing: MissingCommand[]): string`

- [ ] **Step 1: Write the failing tests**

Create `test/cli/preflight.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectToolProbes,
  formatMissingTools,
  type MissingCommand,
  missingHint,
  preflightToolchain,
} from "../../src/cli/preflight.ts";
import type { Profile } from "../../src/dispatch/profile.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

function makeProfile(components: Profile["components"], targetRepo = "/repo"): Profile {
  return parseProfile({ slug: "test", targetRepo, components });
}

// A fake probe: the leading token of `command` is "present" iff it's in the allow-list.
function fakeProbe(present: string[]): (repoDir: string, command: string) => boolean {
  const set = new Set(present);
  return (_repoDir, command) => set.has(command.trim().split(/\s+/)[0]);
}

test("collectToolProbes: prepare + build/test/check, honors dir, skips unavailable", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["api/**"],
      dir: "api",
      commands: { build: "composer build", test: "phpunit", check: { unavailable: true } },
      prepare: "composer install",
    },
  ]);
  expect(collectToolProbes(profile)).toEqual([
    { component: "api", label: "prepare", command: "composer install", cwd: "/repo/api" },
    { component: "api", label: "build", command: "composer build", cwd: "/repo/api" },
    { component: "api", label: "test", command: "phpunit", cwd: "/repo/api" },
  ]);
});

test("preflightToolchain: all tools present → no missing", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["**"],
      commands: { build: "composer build", test: "phpunit", check: "phpstan" },
      prepare: "composer install",
    },
  ]);
  expect(preflightToolchain(profile, fakeProbe(["composer", "phpunit", "phpstan"]))).toEqual([]);
});

test("preflightToolchain: a missing program is reported with component/label/command", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["**"],
      commands: { build: "true", test: "true", check: "true" },
      prepare: "composer install",
    },
  ]);
  expect(preflightToolchain(profile, fakeProbe(["true"]))).toEqual([
    { component: "api", label: "prepare", command: "composer install", missing: "composer" },
  ]);
});

test("preflightToolchain: aggregates every missing tool across components (incl. go/jvm, no prepare)", () => {
  const profile = makeProfile([
    {
      name: "go",
      kind: "go",
      paths: ["**"],
      commands: { build: "go build ./...", test: "go test ./...", check: { unavailable: true } },
    },
    {
      name: "web",
      kind: "node",
      paths: ["web/**"],
      dir: "web",
      commands: { build: "npm run build", test: "npm run test", check: { unavailable: true } },
      prepare: "pnpm install",
    },
  ]);
  const missing = preflightToolchain(profile, fakeProbe([])); // nothing present
  expect(missing.map((m) => `${m.component}/${m.label}:${m.missing}`)).toEqual([
    "go/build:go",
    "go/test:go",
    "web/prepare:pnpm",
    'web/build:npm script "build"',
    'web/test:npm script "test"',
  ]);
});

test("missingHint: npm run → the script; otherwise the leading program", () => {
  expect(missingHint("npm run build")).toBe('npm script "build"');
  expect(missingHint("  composer install ")).toBe("composer");
  expect(missingHint("go build ./...")).toBe("go");
});

test("formatMissingTools: names command, component/label, and missing program", () => {
  const missing: MissingCommand[] = [
    { component: "api", label: "prepare", command: "composer install", missing: "composer" },
  ];
  const msg = formatMissingTools(missing);
  expect(msg).toContain("cannot start");
  expect(msg).toContain("[api / prepare]");
  expect(msg).toContain("composer install");
  expect(msg).toContain("(missing: composer)");
  expect(msg).toContain("Install the missing tool(s) and re-run.");
});

test("preflightToolchain (real probe): catches an absent binary, passes a present one", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-preflight-repo-"));
  const profile = makeProfile(
    [
      {
        name: "x",
        kind: "custom",
        paths: ["**"],
        commands: {
          build: "styre-definitely-absent-xyz build",
          test: "sh -c true",
          check: { unavailable: true },
        },
      },
    ],
    repo,
  );
  const missing = preflightToolchain(profile); // real probeCommandExists
  rmSync(repo, { recursive: true, force: true });
  const labels = missing.map((m) => `${m.label}:${m.missing}`);
  expect(labels).toContain("build:styre-definitely-absent-xyz");
  expect(labels).not.toContain("test:sh"); // `sh` is present
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/cli/preflight.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/preflight.ts'`.

- [ ] **Step 3: Write the module**

Create `src/cli/preflight.ts`:

```ts
import { join } from "node:path";
import { commandFor } from "../dispatch/components.ts";
import type { Profile } from "../dispatch/profile.ts";
import { probeCommandExists } from "../setup/discover-schema.ts";

/** One command the run will execute, tagged with the component + slot it came from. */
export interface ToolProbe {
  component: string;
  label: "prepare" | "build" | "test" | "check";
  command: string;
  cwd: string;
}

/** Enumerate every command whose leading program the run must be able to invoke: each
 *  component's `prepare` (if any) plus its resolved `build`/`test`/`check`. `cwd` is the
 *  component's module root (`targetRepo` + `dir`) so an `npm run <script>` probe reads the
 *  right `package.json`. Pure — no filesystem or probe side effects. */
export function collectToolProbes(profile: Profile): ToolProbe[] {
  const probes: ToolProbe[] = [];
  for (const c of profile.components) {
    const cwd = join(profile.targetRepo, c.dir ?? "");
    if (c.prepare) {
      probes.push({ component: c.name, label: "prepare", command: c.prepare, cwd });
    }
    for (const label of ["build", "test", "check"] as const) {
      const command = commandFor(c, label);
      if (command) probes.push({ component: c.name, label, command, cwd });
    }
  }
  return probes;
}

/** A command whose leading program is not runnable on this machine. */
export interface MissingCommand {
  component: string;
  label: string;
  command: string;
  /** The program (or npm script) the operator must install/fix. */
  missing: string;
}

/** The human-facing "what's missing" hint for a command: the npm script for an `npm run X`,
 *  else the leading whitespace token (the program `command -v` looks up). */
export function missingHint(command: string): string {
  const npmRun = command.trim().match(/^npm run ([\w:-]+)/);
  if (npmRun) return `npm script "${npmRun[1]}"`;
  return command.trim().split(/\s+/)[0];
}

/** Probe every component command's leading program (faithful — exactly what the run will
 *  execute; no interpreter normalization). Returns the commands that are not runnable (an
 *  empty array means all present). The `probe` seam defaults to the real `probeCommandExists`
 *  and is injected in tests. */
export function preflightToolchain(
  profile: Profile,
  probe: (repoDir: string, command: string) => boolean = probeCommandExists,
): MissingCommand[] {
  const missing: MissingCommand[] = [];
  for (const p of collectToolProbes(profile)) {
    if (!probe(p.cwd, p.command)) {
      missing.push({
        component: p.component,
        label: p.label,
        command: p.command,
        missing: missingHint(p.command),
      });
    }
  }
  return missing;
}

/** The stderr message for a non-empty missing set. Names each command + the component/slot it
 *  belongs to + the missing program, so the operator can install everything in one pass. */
export function formatMissingTools(missing: MissingCommand[]): string {
  const lines = missing.map(
    (m) => `  - [${m.component} / ${m.label}] \`${m.command}\`  (missing: ${m.missing})`,
  );
  return [
    "styre run: cannot start — required commands are not runnable on this machine:",
    ...lines,
    "Install the missing tool(s) and re-run.",
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli/preflight.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add src/cli/preflight.ts test/cli/preflight.test.ts
git commit -m "feat(run): toolchain preflight module (probe component command tools)"
```

---

## Task 2: Wire the preflight into `styre run`

**Files:**
- Modify: `src/cli/run.ts` (add constant near top; insert call after the ticket-arg check at `:125-127`, before `const dbPath` at `:129`)
- Test: `test/cli/run-preflight.test.ts`

**Interfaces:**
- Consumes: `preflightToolchain`, `formatMissingTools` (Task 1); `runCommand` (`src/cli/run.ts`).
- Produces: `styre run` sets `process.exitCode = 69` and returns before any DB/dispatch when a tool is missing. No new exported symbol.

- [ ] **Step 1: Write the failing integration test**

Create `test/cli/run-preflight.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/cli/run.ts";

// Invoke the real `run` command with telemetry off and isolated XDG dirs. `state` is where a park
// dump WOULD land (parkDir uses XDG_STATE_HOME) — the test asserts nothing gets written there.
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
    await runCommand.run?.({ rawArgs: [], cmd: runCommand, args: { _: [], ...args } as never });
  } finally {
    if (prev.t === undefined) delete process.env.STYRE_TELEMETRY;
    else process.env.STYRE_TELEMETRY = prev.t;
    if (prev.c === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.c;
    if (prev.s === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.s;
  }
}

// Write a profile.json whose must-have commands are resolved (assertResolved passes) but whose
// `build` invokes a program guaranteed absent on any machine.
function writeProfile(build: string): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-preflight-prof-"));
  const path = join(dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      slug: "preflight-test",
      targetRepo: dir,
      components: [
        {
          name: "api",
          kind: "custom",
          paths: ["**"],
          commands: { build, test: "sh -c true", check: { unavailable: true } },
        },
      ],
    }),
  );
  return path;
}

test("run: a missing toolchain program exits 69 before any dispatch, and writes no dump", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const state = mkdtempSync(join(tmpdir(), "styre-state-"));
  const profile = writeProfile("styre-definitely-absent-xyz build");
  // Resolves: the preflight prints + `return`s (it does not throw). Reaching exit 69 proves the
  // early return — dbPath/migrate/runTicket at run.ts:129+ were never reached.
  await invokeRun({ ticket: "ENG-1", profile }, xdg, state);
  expect(process.exitCode).toBe(69);
  // AC2: no SoT dump — parkDir would write under <XDG_STATE_HOME>/styre/…; nothing was created.
  expect(existsSync(join(state, "styre"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-preflight.test.ts`
Expected: FAIL — `process.exitCode` is not `69` (the run proceeds past the missing tool into DB/tracker wiring and throws/hangs instead).

- [ ] **Step 3: Add the exit-code constant**

In `src/cli/run.ts`, add after the imports (just above `const MUST_HAVE` at line 24):

```ts
/** Exit code when a required repo toolchain program is not installed on this machine
 *  (sysexits `EX_UNAVAILABLE`). Non-retry, distinct from the other run exit codes:
 *  0 success · 1 crash · 2 notifier-config · 65 resume-refused · 75 parked. Final
 *  cross-command reconciliation of the code space is ENG-338's job. */
const EX_TOOLCHAIN_MISSING = 69;
```

- [ ] **Step 4: Import the preflight**

In `src/cli/run.ts`, add to the imports (next to the existing `./park.ts` import at line 22):

```ts
import { formatMissingTools, preflightToolchain } from "./preflight.ts";
```

- [ ] **Step 5: Call the preflight in the fresh-run branch**

In `src/cli/run.ts`, the current code reads:

```ts
      if (!args.ticket || args.ticket.length === 0) {
        throw new Error("run: --ticket is required when not using --resume");
      }

      const dbPath =
```

Insert the preflight between the ticket check and `const dbPath` (i.e. after the `--resume`/`--inspect` early-return at `:115-123`, so neither of those modes is gated):

```ts
      if (!args.ticket || args.ticket.length === 0) {
        throw new Error("run: --ticket is required when not using --resume");
      }

      // Fail fast before any spend if a program the components' commands need isn't installed on
      // this machine. Fresh-run path only — `--resume`/`--inspect` returned above (their re-running
      // ground-truth steps are the check, and `--inspect` must stay exit-0 on a tool-less machine).
      const missingTools = preflightToolchain(profile);
      if (missingTools.length > 0) {
        console.error(formatMissingTools(missingTools)); // human/diagnostic output → stderr
        process.exitCode = EX_TOOLCHAIN_MISSING;
        return;
      }

      const dbPath =
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/cli/run-preflight.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm `--inspect`/`--resume` are ungated**

Run: `bun test test/cli/park.test.ts test/cli/park-resume-e2e.test.ts`
Expected: PASS unchanged — the preflight sits after the resume/inspect early-return, so those paths never reach it (`--inspect` still exits 0 on a tool-less machine).

- [ ] **Step 8: Lint + commit**

```bash
bun run lint
git add src/cli/run.ts test/cli/run-preflight.test.ts
git commit -m "feat(run): fail fast (exit 69) when a repo toolchain program is missing"
```

---

## Task 3: Provision-first reorder

**Files:**
- Modify: `src/daemon/resolver.ts` (`case "design"`, currently lines `:97-122`)
- Modify: `test/daemon/resolver.test.ts` (four design-stage tests updated + one reuse test added)
- Modify: `test/daemon/advance.test.ts` (four tests: seed provision-done first)
- Modify: `test/daemon/loop.test.ts` (`registry()` helper + one assertion)
- Modify: `test/dispatch/real-dispatch-e2e.test.ts` (first test: drive twice)
- Then a full-suite check for any remaining design-order stragglers

**Interfaces:**
- Consumes: nothing new.
- Produces: for a `design`-stage ticket, `nextStepKey` returns `provision` before `design:dispatch`. All other stages unchanged.

- [ ] **Step 1: Update the four affected resolver tests (write the new expectations first)**

In `test/daemon/resolver.test.ts`, replace these four tests.

Replace the test at line 18 (`"design: first asks for design:dispatch"`) with:

```ts
test("design: first asks for provision (hoisted before the design dispatches)", async () => {
  const { db, ticketId } = makeTestDb();
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
  await succeed(db, ticketId, "provision");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "design:dispatch",
    stepType: "dispatch",
    handlerKey: "design:dispatch",
    workUnitId: null,
  });
});
```

Replace the test at line 31 (`"design: after dispatch with no work units, asks for design:extract"`) with:

```ts
test("design: after provision + dispatch with no work units, asks for design:extract", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "design:dispatch");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:extract");
});
```

Replace the test at line 39 (`"design: units present + track unset → routes to design:size"`) with:

```ts
test("design: provision + units present + track unset → routes to design:size", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "design:dispatch");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({
    kind: "step",
    stepKey: "design:size",
    stepType: "dispatch",
    handlerKey: "design:size",
    workUnitId: null,
  });
});
```

Replace the test at line 86 (`"design full-track: with units + track=full, asks for design:review before advancing"`) with:

```ts
test("design full-track: provision + units + track=full, asks for design:review before advancing", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision");
  await succeed(db, ticketId, "design:dispatch");
  setTicketTrack(db, ticketId, "full");
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind === "step" && d.handlerKey).toBe("design:review");
});
```

(The two full-drive tests at lines 55 and 70 already succeed `design:dispatch` before reaching `provision`, so they pass unchanged.)

Also **add** this reuse test (AC5 — provision runs once at design-HEAD and the implement gate finds it done) anywhere in the file, e.g. next to the existing `"provision runs once before the first unit verify"` test:

```ts
test("provision succeeded in design is reused in implement (gate finds it done, no re-provision)", async () => {
  const { db, ticketId } = makeTestDb();
  await succeed(db, ticketId, "provision"); // as if provision ran at design-HEAD
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verifying",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  // provision is already done → the implement gate skips it and asks completeness next
  expect(d).toMatchObject({ stepKey: "completeness:wu1" });
});
```

(`setTicketStage` is already imported in this file.)

- [ ] **Step 2: Run resolver tests to verify the expected pre-hoist state**

Run: `bun test test/daemon/resolver.test.ts`
Expected: exactly **one** FAIL — the updated `"design: first asks for provision"` test (against the current resolver a fresh ticket still yields `design:dispatch` first). The other three updated tests seed `provision` succeeded and assert `design:extract`/`design:size`/`design:review`, which the current resolver *already* returns, so they pass; the reuse test passes too (it is stage-`implement`, unaffected by the hoist).

- [ ] **Step 3: Hoist the provision block in the resolver**

In `src/daemon/resolver.ts`, `case "design"` currently opens at line 97 and has the provision block at lines 110-114. Make two edits.

**(a)** Insert the provision block at the very top of the case. Replace:

```ts
    case "design": {
      if (!done(db, ticketId, "design:dispatch")) {
        return step("design:dispatch", "dispatch", "design:dispatch", null);
      }
```

with:

```ts
    case "design": {
      // Provision runs FIRST — before the design dispatches — so a missing-tool / broken-install
      // environment fault fails before any design spend. It depends on nothing design produces:
      // design commits only under docs/plans/ (planScope), so it cannot touch a dependency
      // manifest. Reused by implement (whose provision gates find it done and skip;
      // resetProvisionIfManifestTouched still re-arms it, §2).
      if (!done(db, ticketId, "provision")) {
        return step("provision", "provision", "provision", null);
      }
      if (!done(db, ticketId, "design:dispatch")) {
        return step("design:dispatch", "dispatch", "design:dispatch", null);
      }
```

**(b)** Remove the now-duplicate old block. Delete these lines (the former `:110-114`):

```ts
      // Hoist: provision runs ONCE at design-HEAD (reused by implement — whose provision gates stay,
      // finding it done and skipping; resetProvisionIfManifestTouched still re-arms it, §2).
      if (!done(db, ticketId, "provision")) {
        return step("provision", "provision", "provision", null);
      }
```

so the tail of the case reads:

```ts
      if (ticket.track === "full" && !done(db, ticketId, "design:review")) {
        return step("design:review", "dispatch", "design:review", null);
      }
      if (!done(db, ticketId, "checks:dispatch")) {
        return step("checks:dispatch", "dispatch", "checks:dispatch", null);
      }
```

- [ ] **Step 4: Run resolver tests to verify they pass**

Run: `bun test test/daemon/resolver.test.ts`
Expected: PASS (all tests, including the four updated ones).

- [ ] **Step 5: Fix `test/daemon/advance.test.ts` (four tests)**

These tests seed `design:dispatch` (not `provision`) and drive; provision-first now makes `advanceOneStep` return `provision` first, and their hand-built registries have no `provision` handler → a thrown `no handler registered for 'provision'`. Add a seed helper after the imports (the file already imports `insertPending` + `markSucceeded`):

```ts
// A fresh design ticket now resolves `provision` first (hoisted). Tests that drive design steps
// with a hand-built registry must seed provision as already-done, or the resolver returns it and
// advanceOneStep throws `no handler registered for 'provision'`.
function seedProvisionDone(db: Parameters<typeof advanceOneStep>[0], ticketId: number): void {
  const s = insertPending(db, { ticketId, stepKey: "provision", stepType: "provision" });
  markSucceeded(db, s.id, {});
}
```

Then add `seedProvisionDone(db, ticketId);` immediately after the `const { db, ticketId } = makeTestDb();` line in each of these four tests:
- `"a step descriptor runs the registered handler and journals success"` (≈L18)
- `"a failing handler routes through failure-policy (retry)"` (≈L147)
- `"a running step propagates StepInFlightError instead of routing through failure-policy"` (≈L160)
- `"design:review step with blocking plan finding → outcome loopback and stage design"` (≈L224)

Do **not** touch `"an advance descriptor sets the stage and writes a transition event"` (≈L79) — it already registers a `provision` no-op and its only assertions are terminal, so it passes (its inline step-by-step comments merely go stale). Do not touch the stage-`implement`/`merge`/`released` tests.

Run: `bun test test/daemon/advance.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix `test/daemon/loop.test.ts` (helper + one assertion)**

Register a `provision` no-op in the shared `registry()` helper so `tick` doesn't throw on the now-first provision step:

```ts
function registry(): StepRegistry {
  const r = new StepRegistry();
  r.register("provision", () => ({}));
  r.register("design:dispatch", () => ({}));
  return r;
}
```

Then in `"tick advances a ready ticket by one step"` (≈L16), the first `tick` now advances `provision` (not `design:dispatch`), so assert on that step:

```ts
test("tick advances a ready ticket by one step", async () => {
  const { db, ticketId } = makeTestDb();
  const summary = await tick(db, registry());
  const step = getByKey(db, ticketId, "provision");
  db.close();
  expect(summary.advanced).toBe(1);
  expect(step?.status).toBe("succeeded");
});
```

The K-cap test `"tick respects the maxConcurrent (K) cap"` (≈L34) needs no further change — with `provision` registered, each ticket's first step runs and the `advanced === 2` count holds. The parked/blocked tests (≈L25/L44/L52) are unaffected (no design step runs).

Run: `bun test test/daemon/loop.test.ts`
Expected: PASS.

- [ ] **Step 7: Fix `test/dispatch/real-dispatch-e2e.test.ts` (first test — drive twice)**

The first test uses the **real** `buildDispatchRegistry` (provision IS registered) with a component-less profile, so provision-first runs the real provision handler as a no-op, then `design:dispatch`. Replace the final drive+assert:

```ts
  // provision is hoisted to the top of case "design" — it runs first (a no-op here: the profile
  // has no components, so planProvision installs nothing). design:dispatch runs next.
  const provisionOutcome = await advanceOneStep(db, ticketId, registry);
  expect(provisionOutcome).toEqual({ kind: "stepped", stepKey: "provision" });
  const outcome = await advanceOneStep(db, ticketId, registry);
  db.close();
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
```

Run: `bun test test/dispatch/real-dispatch-e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Full-suite check for stragglers**

Run: `bun test`
Expected: green. Any *remaining* failure will be another design-stage test that seeds `design:dispatch` (not `provision`) then drives. Fix it the same way: seed `provision` done first (hand-built registry → `markSucceeded` a `provision` step, or register a `provision` no-op and drive one extra step). The hoist adds no new step and changes no drive-to-terminal *outcome* — provision was already a `case "design"` step and no design-driving e2e uses a `prepare`-bearing profile (so provision no-ops, no real install) — so only design-stage *ordering/first-step* assertions can shift. Do not alter any non-design-stage test.

- [ ] **Step 9: Lint + commit**

```bash
bun run lint
git add src/daemon/resolver.ts test/daemon/resolver.test.ts test/daemon/advance.test.ts test/daemon/loop.test.ts test/dispatch/real-dispatch-e2e.test.ts
git commit -m "feat(resolver): run provision before the design dispatches (fail env faults before design spend)"
```

---

## Self-Review

**Spec coverage** (against `docs/brainstorms/2026-07-19-toolchain-preflight-design.md` §8 AC):
- AC1 — preflight probes `prepare`/`build`/`test`/`check` via `probeCommandExists`, after the resume/inspect return, before ingestion → Tasks 1 + 2.
- AC2 — aggregated message, exit 69, zero dispatch rows, **no dump** → Task 2 (early `return` before `dbPath`/`runTicket`; positively asserted via the empty `<XDG_STATE_HOME>/styre` check).
- AC3 — go/jvm (no `prepare`) covered via build/test → Task 1 aggregation test.
- AC4 — exit 69 documented (constant + sibling-code comment), no collision → Task 2 Step 3.
- AC5 — `provision` before `design:dispatch`; reuse unregressed → Task 3 (resolver edit + the added reuse test; existing manifest-re-arm tests stay green via the full-suite check).
- AC6 — no schema/setup/detector change → nothing in the plan touches `profile.ts`, `src/setup/lang/*`, or `setup.ts`.
- AC7 — `--inspect`/`--resume` unchanged. Guaranteed **by construction**: the preflight call lives only in `run.ts`'s fresh-run branch; `resumeRun` (which handles both `--resume` and `--inspect`) contains no preflight call, so a tool-less machine can still `--inspect`. Verified indirectly by Task 2 Step 7 (existing park/inspect tests stay green). No dedicated tool-less-dump `--inspect` test is added (the park harness has no tool-bearing profile to make one cheap) — accepted as a structural guarantee.

**Plan-review resolutions** (two independent reviewers ran against the first draft of this plan):
- *No code blocker* was found — the module, the run wiring, the exit-69 path (telemetry no-ops under `STYRE_TELEMETRY=0`, default notifier `none`, empty XDG config doesn't throw), and the real-probe smoke all check out.
- *Major — Task 3 understated test churn.* The first draft listed only `resolver.test.ts`. The hoist also breaks **7 tests across `advance.test.ts` (4), `loop.test.ts` (2), `real-dispatch-e2e.test.ts` (1)** — several as thrown `no handler registered for 'provision'`. Now enumerated with exact fixes (Steps 5-7); the "same pattern" hand-wave is replaced by the specific registry/seed/extra-drive fixes.
- *Minor — Step 2 milestone was wrong* (claimed 4 pre-hoist failures; only 1). Corrected.
- *Minor — AC2 "no dump" was only inferred.* Now positively asserted.

**Placeholder scan:** none — every step has complete code and exact commands.

**Type consistency:** `ToolProbe` / `MissingCommand` shapes are defined in Task 1 and consumed unchanged in Task 2 (`preflightToolchain(profile): MissingCommand[]`, `.length`, `formatMissingTools`). `label` is the literal union `"prepare"|"build"|"test"|"check"` in `ToolProbe` and widened to `string` in `MissingCommand` (intentional — the message is display-only).

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute here with checkpoints.
