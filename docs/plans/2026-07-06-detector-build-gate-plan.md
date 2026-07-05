# Detector / build gate (A+B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop styre from hard-gating a merge on a *packaging* build; gate a real *typecheck* instead, and run an opaque/packaging build only as an advisory (surfaced, never blocking).

**Architecture:** All the intelligence is at *detection* time. The node detector classifies the `build` script body (typecheck vs packaging), puts a confirmed typecheck (a `typecheck`/`check` script, a `tsc`-only build, or synthesized `tsc --noEmit`) into the gated `build` slot, and puts a packaging build into a new optional `advisoryBuild` field. `rust`→`cargo check`, gradle→compile-only. At `verify:integration`, `advisoryBuild` runs *after* the gated jobs and never throws — a failure emits a new advisory `advisory-build` signal surfaced in the PR body. This is the darkreader fix by construction.

**Tech Stack:** TypeScript, Bun (`bun test`), Zod. Runner: `bun test`; `bun run typecheck` + `bun run lint` stay green.

## Global Constraints

- Branch `feat/verify-gates` (continues PR #51); commit per task; **never `main`**; PR-only merge.
- **A build gate is defensible only as a check-only compile, never packaging** (design §2). A confirmed typecheck → hard gate; an opaque/packaging build → advisory only.
- Schema change is **additive** (`advisoryBuild` optional) — **no `schemaVersion` bump** (stays `3`); old profiles parse unchanged.
- Detector-emitted commands must remain metachar-free single commands (the `isCommandSafe` machine-channel invariant); `npx tsc --noEmit -p tsconfig.json` and `cargo check` are fixed strings with no repo-derived interpolation.
- Runner: `bun test`; also `bun run typecheck` + `bun run lint` green after each task.
- **Out of scope (separate plans/deferred):** the T-min test-pinning gate; pre-warm; CI-reading; native typecheckers for Python/Ruby/PHP (`mypy`/`phpstan`); the CL-BASELINE `inconclusive` verdict.

## File Structure

- `src/setup/lang/node.ts` — add `isTypecheckScript`; rewire `detect()` build/advisory logic. **Modify.**
- `src/setup/lang/rust.ts` — `cargo build` → `cargo check`. **Modify.**
- `src/setup/lang/jvm.ts` — gradle `build -x test` → compile-only. **Modify.**
- `src/setup/lang/types.ts` — add `advisoryBuild?: string` to `ComponentDraft`. **Modify.**
- `src/dispatch/profile.ts` — add `advisoryBuild: z.string().optional()` to `ComponentSchema`. **Modify.**
- `src/dispatch/handlers.ts` — `verify:integration` runs `advisoryBuild` non-throwing (+ `advisory-build` signal); `renderPrBody` surfaces it. **Modify.**
- Tests: `test/setup/lang/node.test.ts`, `test/setup/lang/{rust,jvm}.test.ts`, `test/dispatch/profile.test.ts`, `test/dispatch/handlers-advisory-build.test.ts`, `test/e2e/advisory-build.test.ts`.

---

### Task 1: Classify the node `build` script (typecheck vs packaging)

**Files:** Modify `src/setup/lang/node.ts`; Test `test/setup/lang/node.test.ts`.
**Interfaces:** Produces `export function isTypecheckScript(scriptBody: string): boolean` — true iff the script is a pure `tsc` typecheck (contains `tsc`, no bundler/packager token).

- [ ] **Step 1: Failing test** — add to `test/setup/lang/node.test.ts`:

```ts
import { isTypecheckScript } from "../../../src/setup/lang/node.ts";
describe("isTypecheckScript", () => {
  test("tsc --noEmit is a typecheck", () => { expect(isTypecheckScript("tsc --noEmit")).toBe(true); });
  test("tsc -p tsconfig.build.json is a typecheck", () => { expect(isTypecheckScript("tsc -p tsconfig.build.json")).toBe(true); });
  test("webpack build is packaging", () => { expect(isTypecheckScript("webpack --mode production")).toBe(false); });
  test("rollup build is packaging", () => { expect(isTypecheckScript("rollup -c")).toBe(false); });
  test("node tasks/build.js is packaging (darkreader)", () => { expect(isTypecheckScript("node tasks/build.js --release")).toBe(false); });
  test("tsc && webpack is NOT a pure typecheck", () => { expect(isTypecheckScript("tsc && webpack")).toBe(false); });
  test("empty/other is not a typecheck", () => { expect(isTypecheckScript("echo hi")).toBe(false); });
});
```

- [ ] **Step 2: Run → FAIL** (`bun test test/setup/lang/node.test.ts -t isTypecheckScript`).
- [ ] **Step 3: Implement** in `node.ts` (top-level export):

```ts
const BUNDLER_RE =
  /\b(webpack|rollup|vite|esbuild|parcel|tsup|microbundle|ncc|electron-builder|snowpack|browserify)\b|\bnext\s+build\b|\bnode\b.*\bbuild\b|\bzip\b/;
export function isTypecheckScript(scriptBody: string): boolean {
  if (BUNDLER_RE.test(scriptBody)) return false;
  return /\btsc\b/.test(scriptBody);
}
```

- [ ] **Step 4: Run → PASS.** Then `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(setup): classify node build scripts (typecheck vs packaging)`

---

### Task 2: Node detector — gate a typecheck, make a packaging build advisory

**Files:** Modify `src/setup/lang/node.ts`, `src/setup/lang/types.ts`; Test `test/setup/lang/node.test.ts`.
**Interfaces:** Consumes `isTypecheckScript` (Task 1). Produces: `ComponentDraft.advisoryBuild?: string`; `nodeDef.detect()` sets `commands.build` to a confirmed typecheck and `advisoryBuild` to a packaging build.

- [ ] **Step 1: Add `advisoryBuild` to the draft type** — in `src/setup/lang/types.ts`, add `advisoryBuild?: string;` to the `ComponentDraft` interface (next to `prepare?`/`dir?`).
- [ ] **Step 2: Failing tests** — add to `test/setup/lang/node.test.ts` (using the file's `fixture(files)` helper):

```ts
test("tsc build → gated build slot", () => {
  const r = fixture({ "package.json": '{"scripts":{"build":"tsc --noEmit"}}' });
  const c = nodeDef.detect(r)[0];
  expect(c.commands.build).toBe("npm run build");
  expect(c.advisoryBuild).toBeUndefined();
});
test("packaging build + tsconfig → synthesized typecheck gated, packaging advisory", () => {
  const r = fixture({ "package.json": '{"scripts":{"build":"rollup -c"}}', "tsconfig.json": "{}" });
  const c = nodeDef.detect(r)[0];
  expect(c.commands.build).toBe("npx tsc --noEmit -p tsconfig.json");
  expect(c.advisoryBuild).toBe("npm run build");
});
test("packaging build, no tsconfig → no gated build, packaging advisory", () => {
  const r = fixture({ "package.json": '{"scripts":{"build":"node tasks/build.js --release"}}' });
  const c = nodeDef.detect(r)[0];
  expect(c.commands.build).toBeUndefined();
  expect(c.advisoryBuild).toBe("npm run build");
});
test("explicit typecheck script wins the gated slot", () => {
  const r = fixture({ "package.json": '{"scripts":{"build":"webpack","typecheck":"tsc --noEmit"}}' });
  const c = nodeDef.detect(r)[0];
  expect(c.commands.build).toBe("npm run typecheck");
  expect(c.advisoryBuild).toBe("npm run build");
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** — in `node.ts` `detect()`, replace the line `if (scripts.build) commands.build = "npm run build";` with:

First move the existing `const isRoot = dir === "";` line up to just after `const scripts = ...` (so `compDir` can use `isRoot`). Then replace `if (scripts.build) commands.build = "npm run build";` with:

```ts
const compDir = isRoot ? repoDir : join(repoDir, dir);
const buildIsTypecheck = scripts.build ? isTypecheckScript(scripts.build) : false;
if (scripts.typecheck) commands.build = "npm run typecheck";
else if (buildIsTypecheck) commands.build = "npm run build";
else if (existsSync(join(compDir, "tsconfig.json"))) commands.build = "npx tsc --noEmit -p tsconfig.json";
const advisoryBuild = scripts.build && !buildIsTypecheck ? "npm run build" : undefined;
```

Keep the existing `if (scripts.check) commands.check = "npm run check";` line unchanged. Then add `...(advisoryBuild ? { advisoryBuild } : {}),` to the `components.push({...})` object.

- [ ] **Step 5: Run → PASS.** Fix any existing node.test.ts assertions that expected the old blind `commands.build = "npm run build"` (the two fixture tests without a tsconfig now expect `undefined`/advisory). Then `bun test` + typecheck + lint green.
- [ ] **Step 6: Commit** `feat(setup): node gates a typecheck; packaging build becomes advisory`

---

### Task 3: rust `cargo check` + gradle compile-only

**Files:** Modify `src/setup/lang/rust.ts`, `src/setup/lang/jvm.ts`; Test `test/setup/lang/rust.test.ts`, `test/setup/lang/jvm.test.ts`.

- [ ] **Step 1: Failing tests** — assert the new gated build strings:

```ts
// rust.test.ts
test("rust build gate is cargo check", () => {
  expect(rustDef.detect(fixture({ "Cargo.toml": "[package]\nname='x'" }))[0].commands.build).toBe("cargo check");
});
test("rust workspace build gate is cargo check --workspace", () => {
  expect(rustDef.detect(fixture({ "Cargo.toml": "[workspace]\nmembers=['a']" }))[0].commands.build).toBe("cargo check --workspace");
});
// jvm.test.ts
test("gradle build gate is compile-only (no assembly)", () => {
  const c = gradleDef.detect(fixture({ "build.gradle": "" }))[0];
  expect(c.commands.build).toBe("gradle classes");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `rust.ts`: change `build: "cargo build --workspace"` → `build: "cargo check --workspace"` (line ~64) and `build: "cargo build"` → `build: "cargo check"` (line ~76). `jvm.ts`: change ``build: `${gradle} build -x test` `` → ``build: `${gradle} classes` `` (line ~35). Leave `mvn -q -DskipTests compile` unchanged (already compile-only).
- [ ] **Step 4: Run → PASS.** Full `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(setup): rust cargo check + gradle compile-only build gate (drop assembly)`

---

### Task 4: `advisoryBuild` schema field

**Files:** Modify `src/dispatch/profile.ts`; Test `test/dispatch/profile.test.ts`.

- [ ] **Step 1: Failing test** — profile round-trips `advisoryBuild`:

```ts
test("ComponentSchema accepts advisoryBuild (optional, no schema bump)", () => {
  const c = ComponentSchema.parse({ name: "frontend", kind: "node", paths: ["**"], advisoryBuild: "npm run build" });
  expect(c.advisoryBuild).toBe("npm run build");
  expect(ComponentSchema.parse({ name: "x", kind: "node", paths: ["**"] }).advisoryBuild).toBeUndefined();
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `ComponentSchema` (profile.ts), add after the `prepare` field:

```ts
  /** A packaging/opaque build the detector chose NOT to gate (design §2). Run at verify:integration
   *  AFTER the gated jobs, non-throwing; a failure emits an advisory `advisory-build` signal
   *  surfaced in the PR body — never a hard merge gate. */
  advisoryBuild: z.string().optional(),
```

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(profile): optional advisoryBuild (packaging build, surfaced not gated)`

---

### Task 5: verify:integration runs `advisoryBuild` non-throwing + `advisory-build` signal

**Files:** Modify `src/dispatch/handlers.ts` (verify:integration ~809-858); Test `test/dispatch/handlers-advisory-build.test.ts`.

**Interfaces:** Produces a `ground_truth_signal(signal_type='advisory-build', result='fail', detail={component, exitCode, timedOut})` on a failing advisory build; verify:integration still returns `pass` when all *gated* jobs passed.

- [ ] **Step 1: Failing test** — a component with a passing gated `test` and a failing `advisoryBuild`: verify:integration returns pass, emits an `advisory-build` signal, does NOT throw. (Mirror the existing verify:integration test harness; stub `runCommand` to exit 0 for the gated job and exit 1 for the advisoryBuild string.)

```ts
test("a failing advisoryBuild does not block integration; emits advisory-build", async () => {
  // profile: one component { test: "t", advisoryBuild: "npm run build" }; stub runCommand: "t"→0, "npm run build"→1
  const res = await runStep(ctx, "verify:integration");
  expect(res).toEqual({ integration: "pass" });
  expect(signalsOfType(ctx.db, "advisory-build").length).toBe(1);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `verify:integration`, after the gated `for (const {label,command,dir} of jobs)` loop and **before** the final `insertSignal(...signalType:"integration"...)`, add:

```ts
    // Advisory builds (design §2): opaque/packaging builds run AFTER the gated jobs pass, and
    // never block — a failure is surfaced via an advisory signal, not a throw.
    if (result === "pass") {
      for (const c of deps.profile.components) {
        if (!c.advisoryBuild) continue;
        const run = await runCommand(c.advisoryBuild, {
          cwd: join(worktreePath, c.dir ?? ""),
          timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
        });
        if (run.exitCode !== 0) {
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id,
            signalType: "advisory-build",
            result: "fail",
            command: c.advisoryBuild,
            branchHeadSha,
            detail: { component: c.name, exitCode: run.exitCode, timedOut: run.timedOut },
          });
        }
      }
    }
```
(The existing gated loop and its `throw` on a gated failure are unchanged — a gated failure still short-circuits before this block.)

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(run): advisory builds run non-blocking at integration (advisory-build signal)`

---

### Task 6: renderPrBody surfaces advisory-build failures

**Files:** Modify `src/dispatch/handlers.ts` (`renderPrBody` ~138-181); Test `test/dispatch/handlers.test.ts` (or the renderPrBody test file).

- [ ] **Step 1: Failing test**:

```ts
test("renderPrBody surfaces an advisory-build failure, keeps it out of the verified claim", () => {
  const { db, ticket } = seedTicket();
  insertSignal(db, { ticketId: ticket.id, signalType: "advisory-build", result: "fail", detail: { component: "frontend" } });
  const body = renderPrBody(db, ticket);
  expect(body).toContain("Advisory build failed");
  expect(body).toContain("- frontend");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `renderPrBody`, mirror the `sweeps` block: add

```ts
  const advBuilds = allSignals.filter((s) => s.signal_type === "advisory-build");
  const advBuildLines =
    advBuilds.length > 0
      ? [
          "",
          "⚠ Advisory build failed (packaging/build step — NOT a merge gate; review):",
          ...advBuilds.map((s) => `- ${JSON.parse(s.detail_json ?? "{}").component ?? "?"}`),
        ]
      : [];
```
and include `...advBuildLines,` in the returned array (after `...sweepLines,`). The final "Verified against the project's checks…" line stays — the gated checks (typecheck + tests) genuinely passed; the advisory build is explicitly not a check.

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(projector): surface advisory-build failures in the PR body`

---

### Task 7: End-to-end — a packaging build fails but the ticket reaches PR-ready

**Files:** Create `test/e2e/advisory-build.test.ts` (mirror the existing e2e harness).

- [ ] **Step 1: Write the e2e** — a synthetic ticket whose profile has a component with a green gated `test` (and, if present, a green `build` typecheck) plus an `advisoryBuild` that always exits 1. Drive the loop to terminal: the ticket reaches **PR-ready** (not blocked/`waiting`), an `advisory-build` signal exists, and `renderPrBody` contains "Advisory build failed". This is the darkreader shape — a packaging build that fails no longer blocks a correct change.

```ts
test("packaging build fails → PR-ready with an advisory note, not blocked", async () => {
  const { db, ticketId } = seedTicketWithProfile(/* test→0, advisoryBuild→1 */);
  await driveToTerminal(db, ticketId);
  expect(ticketSummary(db, ticketId).status).not.toBe("waiting");
  expect(signalsOfType(db, "advisory-build").length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run → FAIL, implement any glue until PASS.**
- [ ] **Step 3:** full `bun test` + typecheck + lint green.
- [ ] **Step 4: Commit** `test(e2e): packaging build failure reaches PR-ready as advisory`

---

## Self-Review

- **Spec coverage (design §2):** node typecheck-vs-packaging classification + synthesized `tsc --noEmit` (Tasks 1–2) ✓; `cargo check` + gradle compile-only (Task 3) ✓; opaque/packaging build = advisory-never-blocks (Tasks 4–6) ✓; e2e darkreader-shape (Task 7) ✓. Native typecheckers (Python/Ruby/PHP), CI-reading, and the T-min test gate are explicitly out of scope (separate specs) ✓.
- **Placeholder scan:** Task 2 Step 4 shows both a rejected sketch and the "use this" clear form — the implementer must use the clear form (`buildIsTypecheck`); no TBDs. The e2e harness helpers (`seedTicketWithProfile`, `driveToTerminal`) reference the existing `test/e2e/` harness — confirm their real names when writing Task 7.
- **Type consistency:** `advisoryBuild?: string` is added to `ComponentDraft` (Task 2), `ComponentSchema` (Task 4), and consumed in `verify:integration` + `renderPrBody` (Tasks 5–6) with the same name/type throughout. `isTypecheckScript(string): boolean` defined in Task 1, consumed in Task 2. The `advisory-build` signal type is written in Task 5, read in Task 6.

## Execution Handoff

Plan saved to `docs/plans/2026-07-06-detector-build-gate-plan.md`. The **test-pinning gate (T-min)** is a *separate* plan (it needs a net-new base-run primitive) and will be written next. Two execution options for this plan: (1) subagent-driven (fresh subagent per task, review between) — recommended; (2) inline with checkpoints.
