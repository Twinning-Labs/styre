# Detector / build gate (A+B) — Implementation Plan (v2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop styre from hard-gating a merge on a *packaging* build; hard-gate only a *project-declared typecheck*, and run a packaging build as an advisory (surfaced in the PR body, never blocking).

**Architecture:** All the intelligence is at *detection* time. The node detector classifies the `build` script by **shape** — a pure typecheck is a *single* `tsc` invocation. A project-declared typecheck (a `typecheck`/`check` script, or a single-`tsc` `build` script) stays the gated `build`; a packaging build moves to a new optional `advisoryBuild` field. `rust`→`cargo check` (gated) + `cargo build` (advisory); the gradle tweak is deferred (plugin-conditional). At `verify:integration`, `advisoryBuild` runs *after* the gated jobs and never throws — a failure emits a non-gating `advisory-build` signal surfaced in the PR body.

**Tech Stack:** TypeScript, Bun (`bun test`), Zod. Runner: `bun test`; `bun run typecheck` + `bun run lint` stay green.

**This is a heuristic narrowing, NOT a proof.** It removes the darkreader-class false-block (packaging as a hard gate) without inventing a new one (no synthesized typecheck gate). Classification can still misjudge exotic build scripts; the design defaults to the *safe* direction (when unsure, advisory-not-gated).

## Global Constraints

- Branch `feat/verify-gates` (continues PR #51); commit per task; **never `main`**; PR-only merge.
- **A build gate is defensible only as a check-only compile the project already keeps green** (design §2). **Never synthesize a hard-gate typecheck** — a gate must be a command the project itself declares (its CI presumably keeps it green), else it re-creates the false-block (review Finding 1).
- Schema change is **additive** (`advisoryBuild` optional) — **no `schemaVersion` bump** (stays `3`).
- Detector-emitted commands stay metachar-free fixed strings (the `isCommandSafe` machine-channel invariant): `cargo check`, `cargo build`, `npm run build`, `npm run typecheck`.
- Runner: `bun test`; also `bun run typecheck` + `bun run lint` green after each task.
- **Out of scope (separate specs/deferred):** the T-min test-pinning gate; pre-warm; CI-reading; native typecheckers (mypy/phpstan); a plugin-aware gradle compile-only task; synthesizing a typecheck for repos that declare none; the CL-BASELINE `inconclusive` verdict.

## File Structure

- `src/dispatch/profile.ts` — add `advisoryBuild: z.string().optional()` to `ComponentSchema` (flows into `ComponentDraft = Omit<Component,"extensions">` automatically). **Modify.**
- `src/setup/lang/node.ts` — add `isTypecheckScript`; rewire `detect()` build/advisory logic. **Modify.**
- `src/setup/discover.ts` — carry `advisoryBuild` through `mergeComponents` (it currently drops non-allowlisted fields). **Modify.**
- `src/setup/resolve-commands.ts` — treat "has `advisoryBuild`" as build-intentionally-ungated (no prompt, no false warning). **Modify.**
- `src/setup/lang/rust.ts` — `cargo build`→`cargo check` gated + `cargo build` advisory. **Modify.**
- `src/dispatch/handlers.ts` — `verify:integration` runs `advisoryBuild` non-throwing (+ `advisory-build` signal); `renderPrBody` surfaces it. **Modify.**
- Tests: `test/setup/lang/node.test.ts`, `test/setup/lang/rust.test.ts`, `test/setup/discover.test.ts`, `test/setup/resolve-commands.test.ts`, `test/dispatch/profile.test.ts`, `test/dispatch/handlers.test.ts`.
- **Note (gradle deferred):** `jvm.ts` is NOT changed in this plan — `gradle classes` is plugin-conditional (Android/base-only projects lack it → a new false-block). A plugin-aware compile-only task is a named follow-on.

---

### Task 1: `advisoryBuild` schema field (first — the detector depends on it)

**Files:** Modify `src/dispatch/profile.ts`; Test `test/dispatch/profile.test.ts`.
**Interfaces:** Produces `Component.advisoryBuild?: string` (and, via `Omit`, `ComponentDraft.advisoryBuild?`).

- [ ] **Step 1: Failing test** — add to `test/dispatch/profile.test.ts`:

```ts
test("ComponentSchema accepts optional advisoryBuild (no schema bump)", () => {
  expect(ComponentSchema.parse({ name: "frontend", kind: "node", paths: ["**"], advisoryBuild: "npm run build" }).advisoryBuild).toBe("npm run build");
  expect(ComponentSchema.parse({ name: "x", kind: "node", paths: ["**"] }).advisoryBuild).toBeUndefined();
});
```

- [ ] **Step 2: Run → FAIL** (`bun test test/dispatch/profile.test.ts -t advisoryBuild`).
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

### Task 2: Classify a node `build` script by shape (single tsc invocation)

**Files:** Modify `src/setup/lang/node.ts`; Test `test/setup/lang/node.test.ts`.
**Interfaces:** Produces `export function isTypecheckScript(scriptBody: string): boolean` — true iff the script is a *single* `tsc` invocation (no command chaining/piping/redirection).

- [ ] **Step 1: Failing test** — add to `test/setup/lang/node.test.ts`:

```ts
import { isTypecheckScript } from "../../../src/setup/lang/node.ts";
describe("isTypecheckScript (single tsc invocation)", () => {
  test.each([["tsc --noEmit", true], ["tsc -p tsconfig.build.json", true], ["vue-tsc --noEmit", true], ["npx tsc", true]])(
    "typecheck: %s", (s, e) => expect(isTypecheckScript(s as string)).toBe(e));
  test.each([
    ["webpack --mode production", false], ["rollup -c", false], ["node tasks/build.js --release", false],
    ["tsc && webpack", false], ["tsc && copyfiles -u 1 src/**/*.json dist", false],
    ["tsc -p . && node scripts/postbuild.js", false], ["tsc | tee log", false], ["tsc && tsc -p other", false],
  ])("packaging/chained: %s", (s, e) => expect(isTypecheckScript(s as string)).toBe(e));
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in `node.ts` (top-level export):

```ts
export function isTypecheckScript(scriptBody: string): boolean {
  const s = scriptBody.trim();
  // A pure typecheck is a SINGLE command with no chaining/piping/redirection — any of these means
  // there's a second (build/copy/package) step, so it is NOT a check-only compile.
  if (/[&|;<>]/.test(s)) return false;
  // The single command's executable must be a tsc invocation (tsc, npx tsc, vue-tsc, ./node_modules/.bin/tsc).
  return /^(npx\s+)?[\w@./-]*\btsc\b/.test(s);
}
```

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(setup): classify node build by shape (single tsc invocation = typecheck)`

---

### Task 3: Node detector — gate a project-declared typecheck; packaging → advisory

**Files:** Modify `src/setup/lang/node.ts`; Test `test/setup/lang/node.test.ts`.
**Interfaces:** Consumes `isTypecheckScript` (Task 2), `Component.advisoryBuild` (Task 1). `nodeDef.detect()` sets `commands.build` to a project-declared typecheck (only) and `advisoryBuild` to a packaging build.

- [ ] **Step 1: Failing tests** — add (using the file's `fixture(files)` helper):

```ts
test("tsc build → gated build slot, no advisory", () => {
  const c = nodeDef.detect(fixture({ "package.json": '{"scripts":{"build":"tsc --noEmit"}}' }))[0];
  expect(c.commands.build).toBe("npm run build"); expect(c.advisoryBuild).toBeUndefined();
});
test("packaging build → NO gated build (never synthesize), packaging advisory", () => {
  const c = nodeDef.detect(fixture({ "package.json": '{"scripts":{"build":"rollup -c"}}', "tsconfig.json": "{}" }))[0];
  expect(c.commands.build).toBeUndefined(); expect(c.advisoryBuild).toBe("npm run build");
});
test("explicit typecheck script wins the gated slot; packaging → advisory", () => {
  const c = nodeDef.detect(fixture({ "package.json": '{"scripts":{"build":"webpack","typecheck":"tsc --noEmit"}}' }))[0];
  expect(c.commands.build).toBe("npm run typecheck"); expect(c.advisoryBuild).toBe("npm run build");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `node.ts` `detect()`, replace `if (scripts.build) commands.build = "npm run build";` with:

```ts
const buildIsTypecheck = scripts.build ? isTypecheckScript(scripts.build) : false;
if (scripts.typecheck) commands.build = "npm run typecheck";
else if (buildIsTypecheck) commands.build = "npm run build";
// NOTE: never synthesize `tsc --noEmit` as a gate for repos that declare no typecheck (review Finding 1).
const advisoryBuild = scripts.build && !buildIsTypecheck ? "npm run build" : undefined;
```
Keep the existing `if (scripts.check) commands.check = "npm run check";` line unchanged. Add `...(advisoryBuild ? { advisoryBuild } : {}),` to the `components.push({...})` object.

- [ ] **Step 4: Run → PASS. FIX the existing breaking assertions** (review Finding 3): the fixture tests whose `build` script is packaging with no gated typecheck now expect `commands.build === undefined` + the packaging string on `advisoryBuild` — this includes **the sveltekit test (`build: "vite build"`, `check: "svelte-check"`)** and any plain-`npm run build` fixture. The `build: "tsc"` test stays green (typecheck). Then `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(setup): node gates only a declared typecheck; packaging build → advisory`

---

### Task 4: Carry `advisoryBuild` through `mergeComponents` (the silent-drop fix)

**Files:** Modify `src/setup/discover.ts` (`mergeComponents` ~37-48); Test `test/setup/discover.test.ts`.

**Why (review Finding 1 — MUST-FIX):** the live `styre setup` path runs detectors → `mergeComponents` → profile. `mergeComponents` reconstructs each agent-named component field-by-field from an allowlist and **does not carry `advisoryBuild`** (same gap `prepare`/`dir` needed). Without this, the darkreader fix is silently stripped before the profile is written — and every unit/e2e test that bypasses `mergeComponents` stays green.

- [ ] **Step 1: Failing test** — a scan component the agent names carries `advisoryBuild` through the merge:

```ts
test("mergeComponents preserves advisoryBuild for an agent-named component", () => {
  const scan = [{ name: "frontend", kind: "node", paths: ["**"], commands: { test: "npm run test" }, extensions: [], advisoryBuild: "npm run build" }];
  const agent = [{ name: "frontend", kind: "node", paths: ["src/**"], commands: {} }];
  expect(mergeComponents(scan as any, agent as any)[0].advisoryBuild).toBe("npm run build");
});
```

- [ ] **Step 2: Run → FAIL** (`advisoryBuild` is undefined — dropped).
- [ ] **Step 3: Implement** — in `mergeComponents`, in the reconstructed return object (next to the `prepare`/`dir` spreads), add:

```ts
  ...(s.advisoryBuild !== undefined ? { advisoryBuild: s.advisoryBuild } : {}),
```

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `fix(setup): carry advisoryBuild through mergeComponents (was silently dropped)`

---

### Task 5: `resolveCommands` — advisoryBuild means build-intentionally-ungated

**Files:** Modify `src/setup/resolve-commands.ts` (~22-35); Test `test/setup/resolve-commands.test.ts`.

**Why (review Finding 4):** `MUST_HAVE` forces `build`; a packaging-only component has no gated `build`, so headless setup stamps `build:{unavailable}` + warns *"cannot ground-truth-build this stack"* (false — there's an advisory build), and interactive setup **prompts the operator to supply a build**, where typing `npm run build` re-installs the hard gate the plan just removed.

- [ ] **Step 1: Failing test**:

```ts
test("a component with advisoryBuild is not warned/prompted for a missing build", () => {
  const c = { name: "frontend", kind: "node", paths: ["**"], commands: { test: "npm run test" }, extensions: [], advisoryBuild: "npm run build" };
  const { components, warnings } = resolveCommands([c as any], { interactive: false, ask: () => null });
  expect(warnings.some((w) => w.includes("no build command"))).toBe(false);
  expect(isUnavailable(components[0], "build")).toBe(true); // intentionally ungated, no warning
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in the `for (const k of MUST_HAVE)` loop, before the prompt/warn logic, add:

```ts
      if (k === "build" && c.advisoryBuild) { commands[k] = { unavailable: true }; continue; } // build intentionally ungated (advisory build carries the packaging step)
```

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `fix(setup): advisoryBuild suppresses the missing-build prompt/warning`

---

### Task 6: rust `cargo check` gated + `cargo build` advisory

**Files:** Modify `src/setup/lang/rust.ts`; Test `test/setup/lang/rust.test.ts`.

**Note:** gradle is intentionally **not** changed (deferred — `gradle classes` is plugin-conditional). Maven stays `mvn -q -DskipTests compile` (already compile-only).

- [ ] **Step 1: Failing tests**:

```ts
test("rust gates cargo check, surfaces cargo build advisorily", () => {
  const c = rustDef.detect(fixture({ "Cargo.toml": "[package]\nname=\"x\"" }))[0];
  expect(c.commands.build).toBe("cargo check"); expect(c.advisoryBuild).toBe("cargo build");
});
test("rust workspace: cargo check --workspace + advisory cargo build --workspace", () => {
  const c = rustDef.detect(fixture({ "Cargo.toml": "[workspace]\nmembers=[\"a\"]" }))[0];
  expect(c.commands.build).toBe("cargo check --workspace"); expect(c.advisoryBuild).toBe("cargo build --workspace");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `rust.ts`: workspace branch (~line 64) → `commands: { build: "cargo check --workspace", test: "cargo test --workspace" }, advisoryBuild: "cargo build --workspace"`; single-crate branch (~line 76) → `commands: { build: "cargo check", test: "cargo test" }, advisoryBuild: "cargo build"`. (Add `advisoryBuild` to the pushed draft object in both branches.)
- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(setup): rust gates cargo check; cargo build surfaced advisorily (link errors)`

---

### Task 7: verify:integration runs `advisoryBuild` non-throwing + `advisory-build` signal

**Files:** Modify `src/dispatch/handlers.ts` (verify:integration ~809-858); Test `test/dispatch/handlers.test.ts`.

**Interfaces:** Produces a `ground_truth_signal(signal_type='advisory-build', result='fail', detail={component, exitCode, timedOut})` on a failing advisory build; verify:integration still returns `pass` when all *gated* jobs passed. (`signal_type` is free TEXT — no schema edit.)

- [ ] **Step 1: Failing test** — a component with a passing gated `test` and a failing `advisoryBuild`: integration returns pass, emits `advisory-build`, does NOT throw. Use `makeTestDb()` (the real helper) + the real registry; stub `runCommand` so the gated command exits 0 and the `advisoryBuild` string exits 1.

```ts
test("a failing advisoryBuild does not block integration; emits advisory-build", async () => {
  // profile component { test: "t", advisoryBuild: "npm run build" }; runCommand: "t"→0, "npm run build"→1
  const res = await runStep(ctx, "verify:integration");
  expect(res).toEqual({ integration: "pass" });
  expect(listSignalsByTicket(ctx.db, ctx.ticket.id).filter((s) => s.signal_type === "advisory-build").length).toBe(1);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — after the gated `for (const {label,command,dir} of jobs)` loop and **before** the final `insertSignal(...signalType:"integration"...)`:

```ts
    if (result === "pass") {
      for (const c of deps.profile.components) {
        if (!c.advisoryBuild) continue;
        const run = await runCommand(c.advisoryBuild, {
          cwd: join(worktreePath, c.dir ?? ""),
          timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
        });
        if (run.exitCode !== 0) {
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id, signalType: "advisory-build", result: "fail",
            command: c.advisoryBuild, branchHeadSha,
            detail: { component: c.name, exitCode: run.exitCode, timedOut: run.timedOut },
          });
        }
      }
    }
```
(The gated loop and its `throw` are unchanged — a gated failure short-circuits before this block via `break`.)

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(run): advisory builds run non-blocking at integration (advisory-build signal)`

---

### Task 8: renderPrBody surfaces advisory-build failures

**Files:** Modify `src/dispatch/handlers.ts` (`renderPrBody` ~138-181); Test `test/dispatch/handlers.test.ts`.

- [ ] **Step 1: Failing test** (use `makeTestDb()` + `insertSignal`):

```ts
test("renderPrBody surfaces an advisory-build failure", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "advisory-build", result: "fail", detail: { component: "frontend" } });
  const body = renderPrBody(db, { id: ticketId, ident: "ENG-1", title: "t" });
  expect(body).toContain("Advisory build failed");
  expect(body).toContain("- frontend");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — mirror the `sweeps` block: add

```ts
  const advBuilds = allSignals.filter((s) => s.signal_type === "advisory-build");
  const advBuildLines =
    advBuilds.length > 0
      ? ["", "⚠ Advisory build failed (packaging/build step — NOT a merge gate; review):",
         ...advBuilds.map((s) => `- ${JSON.parse(s.detail_json ?? "{}").component ?? "?"}`)]
      : [];
```
and include `...advBuildLines,` in the returned array (after `...sweepLines,`). The final "Verified against the project's checks…" line stays — the *gated* checks passed; the advisory build is explicitly not a check.

- [ ] **Step 4: Run → PASS.** `bun test` + typecheck + lint green.
- [ ] **Step 5: Commit** `feat(projector): surface advisory-build failures in the PR body`

---

### Task 9: Setup-path integration test — advisoryBuild survives detect → merge → resolve → profile

**Files:** Create/extend `test/setup/setup-advisory-build.test.ts` (mirror an existing setup pipeline test).

**Why:** replaces the v1 full-drive e2e (whose harness helpers don't exist). The high-value coverage gap the review found is that unit tests bypass `mergeComponents`/`resolveCommands` — so test the *whole setup pipeline* on a darkreader-shaped repo and assert `advisoryBuild` reaches the parsed profile and `build` is not a gated command.

- [ ] **Step 1: Write the test** — run the real setup assembly (`detectComponents` → `mergeComponents` with an empty/echoing agent scan → `resolveCommands` → `ProfileSchema.parse`) over a fixture repo with `package.json` `{"scripts":{"build":"node tasks/build.js","test":"npm run test:ci"}}`. Assert the resulting node component has `advisoryBuild === "npm run build"`, `commandFor(c,"build") === undefined`, and no "no build command" warning. (Consult the real function names in `src/setup/detect-components.ts` + `src/cli/setup.ts` for the exact assembly.)
- [ ] **Step 2: Run → FAIL, wire the fixture until PASS.**
- [ ] **Step 3:** full `bun test` + typecheck + lint green.
- [ ] **Step 4: Commit** `test(setup): advisoryBuild survives the full setup pipeline (darkreader shape)`

---

## Self-Review

- **Spec coverage (design §2):** classify by shape (Task 2) ✓; gate only a declared typecheck, packaging → advisory, **no synthesized gate** (Task 3, review Finding 1/2) ✓; `advisoryBuild` schema + merge + resolve carry-through (Tasks 1/4/5 — the setup-path integrity the review found broken) ✓; rust `cargo check` + advisory `cargo build` (Task 6) ✓; non-throwing advisory run + PR surfacing (Tasks 7/8) ✓; full-pipeline test (Task 9) ✓. Gradle compile-only, synthesized typechecks, native typecheckers, CI-reading, and the T-min test gate are explicitly deferred ✓.
- **Placeholder scan:** no rejected sketches; Task 9 names the real functions to consult (`detectComponents`/`mergeComponents`/`resolveCommands`/`ProfileSchema`) rather than fictional helpers. `runStep`/`ctx` in Task 7 follow the existing `handlers.test.ts` convention (confirm `makeTestDb`/registry setup there).
- **Type consistency:** `advisoryBuild?: string` defined in `ComponentSchema` (Task 1), set by the node detector (Task 3) and rust detector (Task 6), carried by `mergeComponents` (Task 4), honored by `resolveCommands` (Task 5), consumed by `verify:integration` (Task 7) and `renderPrBody` (Task 8) — same name/type throughout. `isTypecheckScript(string): boolean` (Task 2) consumed in Task 3. `advisory-build` signal written in Task 7, read in Task 8.

## Changelog
- *v1 → v2 (2026-07-06, post independent review):* dropped the synthesized `tsc --noEmit` hard gate (would re-create the false-block — MUST-FIX); reshaped `isTypecheckScript` to a single-`tsc`-invocation test (the denylist leaked packaging into the gate); added Task 4 (`mergeComponents` carry-through — the silent feature-defeat the reviews caught) + Task 5 (`resolveCommands` suppression); deferred the gradle `classes` tweak (plugin-conditional/Android-unsafe); gave rust an advisory `cargo build`; replaced the fictional-harness e2e with a real setup-pipeline test (Task 9); reordered schema-first and dropped the redundant `types.ts` edit; removed the "darkreader fix by construction" overclaim.

## Execution Handoff

Plan saved to `docs/plans/2026-07-06-detector-build-gate-plan.md`. The **test-pinning gate (T-min)** is a separate plan (needs a net-new base-run primitive). Two execution options for this plan: (1) subagent-driven (fresh subagent per task, review between) — recommended; (2) inline with checkpoints.
