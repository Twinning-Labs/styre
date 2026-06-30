# M-C2a: engine-level naming uniqueness + deterministic co-located root scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two engine post-passes over `runRegistry` output: (1) guarantee **unique component names** (kind-qualifying collisions), and (2) **deterministically scope co-located root components** so two stacks rooted at the repo root never both claim `["**"]` — closing the spec's forced-fix from §3 (the agent provably cannot narrow paths).

**Architecture:** Both are pure post-passes in `src/setup/detect-components.ts` applied to `runRegistry`'s result — no `LangDef`/lang-file changes. Behavior-preserving for single-stack repos (one component → no collision, no co-location); only multi-component repos are affected. Prerequisite for M-C2b (non-root) which will emit dir-named components that must stay unique.

**Tech Stack:** TypeScript, Bun (`bun test`), biome.

## Global Constraints

- **Behavior-preserving for existing tests:** the `test/setup/detect-components.test.ts` matrix must pass unchanged (its repos are single-component or already-scoped, so neither pass alters them).
- Tests: `bun test`; lint/types via `bun run lint` / `bun run typecheck` (bare `biome`/`tsc` NOT on PATH).
- `detectComponents`/`runRegistry` signatures unchanged; `ComponentSchema` unchanged.
- **Naming rule (spec F4):** every emitted component has a unique `name`. A name shared by ≥2 components is qualified to `<kind>-<name>` (then `-<n>` if still colliding). Non-colliding names are left untouched.
- **Scoping rule (spec §3, the forced fix):** a component whose paths is exactly `["**"]` keeps `["**"]` ONLY if it is the sole component OR no other component owns any top-level dir. When ≥1 other component owns top-level entries, the `["**"]` component is rescoped to the repo's top-level entries (anchored globs) **minus** those owned by other components. Two stacks that both legitimately span the whole repo (both `["**"]`, neither owning specific dirs) stay `["**"]` — accepted **over-verify** (the safe direction; never under-verify).
- Rescoped globs are engine-constructed from `readdirSync` (trusted) and anchored (`<dir>/**`, `<file>`), so they pass `isSafePath`.

---

### Task 1: Unique component names (`uniquifyNames`)

**Files:**
- Modify: `src/setup/detect-components.ts` (add `uniquifyNames`; apply in `runRegistry`)
- Test: `test/setup/engine.test.ts` (add cases)

**Interfaces:**
- Produces: `uniquifyNames(components: Component[]): Component[]` — collisions qualified `<kind>-<name>` (then `-2`,`-3`…), non-colliding untouched. `runRegistry` returns `uniquifyNames(out)`.

- [ ] **Step 1: Write the failing test**

```ts
import { uniquifyNames } from "../../src/setup/detect-components.ts";
import type { Component } from "../../src/dispatch/profile.ts";

test("uniquifyNames qualifies colliding names by kind, leaves unique names alone", () => {
  const cs: Component[] = [
    { name: "services-api", kind: "go", paths: ["services/api/**"], commands: {} },
    { name: "services-api", kind: "node", paths: ["services/api/**"], commands: {} },
    { name: "frontend", kind: "sveltekit", paths: ["src/**"], commands: {} },
  ];
  const out = uniquifyNames(cs);
  expect(out.map((c) => c.name).sort()).toEqual(["frontend", "go-services-api", "node-services-api"]);
});

test("uniquifyNames handles a kind-qualified name that itself collides", () => {
  const cs: Component[] = [
    { name: "api", kind: "go", paths: ["api/**"], commands: {} },
    { name: "api", kind: "go", paths: ["api2/**"], commands: {} }, // same kind+name
  ];
  const names = uniquifyNames(cs).map((c) => c.name).sort();
  expect(names).toEqual(["go-api", "go-api-2"]);
});
```

- [ ] **Step 2: Run — FAIL** (`uniquifyNames` undefined). `bun test test/setup/engine.test.ts`

- [ ] **Step 3: Implement** (in `detect-components.ts`):

```ts
/** Guarantee unique component names: a name shared by ≥2 components is qualified `<kind>-<name>`
 *  (then `-<n>`). Non-colliding names are left untouched (behavior-preserving for single-stack repos). */
export function uniquifyNames(components: Component[]): Component[] {
  const counts = new Map<string, number>();
  for (const c of components) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const used = new Set<string>();
  for (const c of components) if ((counts.get(c.name) ?? 0) === 1) used.add(c.name);
  return components.map((c) => {
    if ((counts.get(c.name) ?? 0) === 1) return c;
    let name = `${c.kind}-${c.name}`;
    let i = 2;
    while (used.has(name)) name = `${c.kind}-${c.name}-${i++}`;
    used.add(name);
    return { ...c, name };
  });
}
```
In `runRegistry`, change `return out;` → `return uniquifyNames(out);`.

- [ ] **Step 4: Run — PASS** + full `bun test` (existing matrix unaffected — no current fixture has colliding names). `bun run lint && bun run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(setup): guarantee unique component names in the engine (M-C2a)"`

---

### Task 2: Deterministic co-located root scoping (`scopeColocatedRoots`)

**Files:**
- Modify: `src/setup/detect-components.ts` (add `scopeColocatedRoots`; apply in `runRegistry`)
- Test: `test/setup/engine.test.ts` (add cases)

**Interfaces:**
- Consumes: `SKIP` from `./manifests.ts`.
- Produces: `scopeColocatedRoots(components: Component[], repoDir: string): Component[]` — rescopes `["**"]` components per the scoping rule. `runRegistry` applies it before `uniquifyNames`.

- [ ] **Step 1: Write the failing tests** (use the `fixture()` helper from `test/setup/detect-components.test.ts`)

```ts
import { scopeColocatedRoots } from "../../src/setup/detect-components.ts";

test("a ['**'] component co-located with a dir-owning sibling is scoped to top-level minus siblings", () => {
  const root = fixture({ "go.mod": "module x\n", "src/app.svelte": "", "static/x": "", "pkg/main.go": "", "README.md": "x" });
  const comps: Component[] = [
    { name: "go", kind: "go", paths: ["**"], commands: { test: "go test ./..." } },
    { name: "frontend", kind: "sveltekit", paths: ["src/**", "static/**", "package.json"], commands: {} },
  ];
  const out = scopeColocatedRoots(comps, root);
  const go = out.find((c) => c.kind === "go");
  expect(go?.paths).not.toContain("**");
  // owns the non-frontend top-level entries; excludes src/static (sibling-owned)
  expect(go?.paths).toEqual(expect.arrayContaining(["pkg/**", "go.mod", "README.md"]));
  expect(go?.paths).not.toContain("src/**");
  expect(go?.paths).not.toContain("static/**");
});

test("a sole ['**'] component is left unchanged", () => {
  const root = fixture({ "go.mod": "module x\n", "main.go": "" });
  const comps: Component[] = [{ name: "go", kind: "go", paths: ["**"], commands: {} }];
  expect(scopeColocatedRoots(comps, root)[0].paths).toEqual(["**"]);
});

test("two ['**'] stacks that own nothing both stay ['**'] (accepted over-verify)", () => {
  const root = fixture({ "go.mod": "module x\n", "pyproject.toml": "[project]\n", "main.go": "" });
  const comps: Component[] = [
    { name: "go", kind: "go", paths: ["**"], commands: {} },
    { name: "python", kind: "python", paths: ["**"], commands: {} },
  ];
  const out = scopeColocatedRoots(comps, root);
  expect(out.every((c) => c.paths[0] === "**")).toBe(true);
});
```

- [ ] **Step 2: Run — FAIL** (`scopeColocatedRoots` undefined).

- [ ] **Step 3: Implement** (in `detect-components.ts`; add `import { readdirSync, statSync } from "node:fs"` and `import { SKIP } from "./manifests.ts"`):

```ts
/** Top-level entries a component "owns" = the first segment of each anchored (non-`**`/non-`*`) glob. */
function ownedTopLevel(c: Component): Set<string> {
  const out = new Set<string>();
  for (const g of c.paths) {
    const first = (g.split("/")[0] ?? "").trim();
    if (first && first !== "**" && !/^\*/.test(first)) out.add(first);
  }
  return out;
}

/** Spec §3: a `["**"]` component co-located with siblings that own top-level dirs is rescoped to the
 *  repo's top-level entries minus the sibling-owned ones; otherwise it keeps `["**"]` (over-verify). */
export function scopeColocatedRoots(components: Component[], repoDir: string): Component[] {
  if (components.length < 2) return components;
  const ownedByNonRoot = new Set<string>();
  for (const c of components) {
    if (c.paths.length === 1 && c.paths[0] === "**") continue;
    for (const d of ownedTopLevel(c)) ownedByNonRoot.add(d);
  }
  if (ownedByNonRoot.size === 0) return components; // nothing to carve around
  let entries: string[];
  try {
    entries = readdirSync(repoDir).filter((e) => !SKIP.has(e) && !e.startsWith("."));
  } catch {
    return components;
  }
  const carved: string[] = [];
  for (const e of entries) {
    if (ownedByNonRoot.has(e)) continue;
    let isDir = false;
    try {
      isDir = statSync(join(repoDir, e)).isDirectory();
    } catch {
      continue;
    }
    carved.push(isDir ? `${e}/**` : e);
  }
  if (carved.length === 0) return components;
  return components.map((c) =>
    c.paths.length === 1 && c.paths[0] === "**" ? { ...c, paths: [...carved] } : c,
  );
}
```
In `runRegistry`, apply before `uniquifyNames`: `return uniquifyNames(scopeColocatedRoots(out, repoDir));`.

- [ ] **Step 4: Run — PASS** + full `bun test`. Confirm the existing matrix is unchanged: no existing fixture has a `["**"]` component co-located with a dir-owning sibling (the Tauri fixture's components are both already-scoped). `bun run lint && bun run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(setup): deterministic co-located root scoping (M-C2a, spec F1)"`

---

## Self-review notes (author)

- **Spec coverage (M-C2a slice):** spec F4 unique names → Task 1; spec §3/F1 deterministic co-located root scoping → Task 2. M-C2b (non-root detection) and M-C2c (reactor parsers) are out of this plan.
- **Behavior-preservation:** both passes are no-ops unless there are ≥2 components AND (a name collision / a `["**"]` co-located with a dir-owning sibling). Existing fixtures don't hit either, so `detect-components.test.ts` passes unchanged (Task 2 Step 4 verifies).
- **Safety:** rescoped globs are `readdirSync`-derived + anchored → pass `isSafePath`. The over-verify-never-under-verify rule holds: when carving isn't possible (no sibling owns dirs, or readdir fails), the component keeps `["**"]` (runs everything) rather than narrowing to nothing.
- **Ordering:** `scopeColocatedRoots` runs before `uniquifyNames` (scoping doesn't change names; naming doesn't change paths — order is independent, but fixed for determinism).
- **Open for M-C2b:** when non-root detection lands, dir-named components (`<kind>-<dir>`) will rely on Task 1 for uniqueness; co-located scoping (Task 2) only touches root `["**"]` components, so non-root components are unaffected.
