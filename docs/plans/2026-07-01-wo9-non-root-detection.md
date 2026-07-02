# WO-9: Non-root detection & naming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`). TDD: failing test → see it fail → implement → see it pass → lint + typecheck + full suite → commit. Suite green after each task.

**Goal:** detect non-root Python/Go modules (per-manifest, root + nested, each dir-scoped) and run each module's commands in its own directory, plus ship `uniquifyNames` — closing the polyglot-setup DONE line for Python/Go.

**Architecture:** Add an optional `Component.dir?` field (the module root); every per-component verify command runs with `cwd = join(worktree, dir ?? "")`. Detectors emit one component per manifest (`findManifests`): `dir===""`→root `["**"]`, `dir!==""`→nested `["<dir>/**"]` + `dir`. `uniquifyNames` (engine post-pass) keeps dir-named components unique. Routing stays pure `ext AND path-glob` (WO-5); `dir` affects execution cwd only.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome (`bun run lint` · `bun run typecheck`). Bare `biome`/`tsc` are NOT on PATH — use the bun scripts.

**Design:** `docs/brainstorms/2026-07-01-wo9-non-root-detection-design.md` (v2, independently reviewed). Reviews: feasibility/adversarial/scope, all SHIP-WITH-FIXES; fixes folded into the design and this plan.

## Global Constraints

- **Behavior-preserving for existing repos:** the `test/setup/detect-components.test.ts` matrix must pass **unchanged** (its repos are root/single-stack; per-manifest emission yields the same single `["**"]` component when only a root manifest exists).
- **`dir` is execution-only, never routing:** `matchesComponent` (`src/dispatch/components.ts`) must stay `extMatches && paths.glob`. No consumer may route on `dir`.
- **`dir` is scan-authoritative:** it is NOT in `DiscoverSchema`; `mergeComponents` reads `s.dir` (scan), never `p.dir` (agent). The agent cannot author `dir`.
- **Machine-channel backstop:** `runRegistry` throws on an unsafe `dir` (`..`/absolute) via `isSafePath`, same loud posture as the command backstop.
- **Optional field ⇒ NO `schemaVersion` bump** (stays `z.literal(3)`); existing v3 profiles parse unchanged.
- **Do NOT ship `scopeColocatedRoots`** (m-c2a Task 2) — rejected. Ship only `uniquifyNames` (m-c2a Task 1).
- **JVM non-root is OUT** (→ WO-8); JVM subdir-only stays warning-only.
- Commit messages: `feat(setup): …` / `fix(setup): …`, subject ending with the WO-9 tag.

---

### Task 1: `Component.dir?` field + plumbing (schema, safety backstop, merge carry)

The enabling mechanism. No detector emits `dir` yet — this task establishes the field, its safety, and its survival through the agent-refine pass.

**Files:**
- Modify: `src/dispatch/profile.ts` (`ComponentSchema`)
- Modify: `src/setup/detect-components.ts` (`runRegistry` safety backstop)
- Modify: `src/setup/discover-schema.ts` (`mergeComponents` carry)
- Test: `test/dispatch/profile.test.ts`, `test/setup/discover-schema.test.ts`, `test/setup/engine.test.ts`

**Interfaces:**
- Produces: `Component.dir?: string` (module root, relative to repo root; absent ⇒ root). `ComponentDraft = Omit<Component,"extensions">` picks it up automatically.

- [ ] **Step 1: Write failing tests.**

`test/dispatch/profile.test.ts` (round-trip — genuinely red; zod strips `dir` until the schema add):
```ts
test("ComponentSchema round-trips an optional dir", () => {
  const c = ComponentSchema.parse({ name: "svc", kind: "go", paths: ["svc/**"], dir: "svc" });
  expect(c.dir).toBe("svc");
});
test("a component without dir parses (dir undefined)", () => {
  const c = ComponentSchema.parse({ name: "go", kind: "go", paths: ["**"] });
  expect(c.dir).toBeUndefined();
});
```

`test/setup/discover-schema.test.ts` (carry — genuinely red until the carry lands):
```ts
test("mergeComponents preserves the scanned dir even when the agent omits the component", () => {
  const scan: Component[] = [{ name: "svc", kind: "go", paths: ["svc/**"], commands: {}, extensions: [".go"], dir: "svc" }];
  const merged = mergeComponents(scan, []); // agent proposed nothing
  expect(merged[0].dir).toBe("svc");
});
test("an agent proposal cannot introduce dir (not in DiscoverSchema)", () => {
  const parsed = DiscoverSchema.parse({ components: [{ name: "svc", kind: "go", paths: ["svc/**"], commands: {}, dir: "../evil" }], repoCommands: {} });
  expect((parsed.components[0] as Record<string, unknown>).dir).toBeUndefined();
});
```

`test/setup/engine.test.ts` (safety backstop — genuinely red until the throw lands):
```ts
test("runRegistry throws on an unsafe dir", () => {
  const evil: LangDef = { kind: "go", detect: () => [{ name: "x", kind: "go", paths: ["**"], commands: {}, dir: "../evil" }] };
  expect(() => runRegistry("/tmp", [evil])).toThrow(/unsafe dir/);
});
test("runRegistry passes a safe dir through", () => {
  const ok: LangDef = { kind: "go", detect: () => [{ name: "svc", kind: "go", paths: ["svc/**"], commands: {}, dir: "svc" }] };
  expect(runRegistry("/tmp", [ok])[0].dir).toBe("svc");
});
```

- [ ] **Step 2: Run — FAIL.** `bun test test/dispatch/profile.test.ts test/setup/discover-schema.test.ts test/setup/engine.test.ts`

- [ ] **Step 3: Implement.**

`src/dispatch/profile.ts` — add to `ComponentSchema` (after `extensions`):
```ts
  extensions: z.array(z.string()).default([]),
  dir: z.string().optional(),
```

`src/setup/detect-components.ts` `runRegistry` — add the backstop next to the existing command/prepare checks, before `out.push`. `isSafePath` is already imported from `./manifests.ts`:
```ts
      if (c.dir !== undefined && !isSafePath(c.dir))
        throw new Error(`engine: unsafe dir for ${c.name}: ${c.dir}`);
```
(Passthrough is automatic — `out.push({ ...c, paths, extensions: … })` already spreads `dir`.)

`src/setup/discover-schema.ts` `mergeComponents` — add to the returned object literal (mirroring the `prepare`/`extensions`/`testFilePattern` carries; reads `s.dir`, the scan):
```ts
      ...(s.dir !== undefined ? { dir: s.dir } : {}),
```

- [ ] **Step 4: Run — PASS** + full `bun test` + `bun run lint` + `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(setup): add optional Component.dir field + safety backstop + merge carry (WO-9)`

---

### Task 2: Per-component command cwd at all three verify run sites

Make `dir` actually scope command execution. Without a non-root detector yet, a root component (`dir` undefined) yields `cwd = join(worktree, "")` = worktree root → **current behavior byte-for-byte preserved**; the tests construct a `dir`-bearing component to prove the join.

**Files:**
- Modify: `src/dispatch/handlers.ts` (hard-gate run `:503`, advisory sweep run `:559`, `verify:integration` jobs `:630-636` + run `:655`)
- Test: `test/dispatch/verify-routing.test.ts` (or the existing verify handler test file)

**Interfaces:**
- Consumes: `Component.dir` (Task 1).
- `join` is already imported in `handlers.ts`.

- [ ] **Step 1: Write failing tests.** Add a verify test on a profile whose impacted component has `dir: "services/api"` and a `test` command; assert the command runs with `cwd` ending in `services/api` (spy/stub `runCommand` to capture `opts.cwd`, or use a fixture whose command writes its cwd). Add the mirror: a root component (`dir` undefined) runs with `cwd === worktreePath`. Cover the `verify:integration` path too: a non-root component job runs with the module cwd while a `repoCommands` job runs at worktree root.

*(Match the existing verify-test harness in the file — it already stubs `runCommand`/uses a temp worktree. Assert on the captured `cwd`.)*

- [ ] **Step 2: Run — FAIL** (commands currently run at `worktreePath` for non-root dirs).

- [ ] **Step 3: Implement** — three edits in `handlers.ts`:

**(a) Hard-gate.** Carry `dir` in `toRun` (`:452-454`) and use it at the run (`:501-506`):
```ts
      const toRun = realImpacted
        .filter((c) => commandFor(c, checkType) !== undefined)
        .map((c) => ({ component: c.name, command: commandFor(c, checkType) as string, dir: c.dir }));
```
```ts
      for (const { component, command, dir } of toRun) {
        lastCommand = command;
        const run = await runCommand(command, {
          cwd: join(worktreePath, dir ?? ""),
          timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
        });
```

**(b) Advisory sweep** (`:555-562`) — the swept component `c` is in scope:
```ts
        const sweepRun = await runCommand(cmd, {
          cwd: join(worktreePath, c.dir ?? ""),
          timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
        });
```

**(c) `verify:integration`** — carry `dir` on component jobs only (`:630-636`), leave `repoCommands` (`:637-639`) at root, and use it at the run (`:653-658`):
```ts
    const jobs: Array<{ label: string; command: string; dir?: string }> = [];
    for (const c of deps.profile.components) {
      for (const key of ["build", "test"] as const) {
        const cmd = commandFor(c, key);
        if (cmd) jobs.push({ label: `${c.name}:${key}`, command: cmd, dir: c.dir });
      }
    }
    for (const [name, cmd] of Object.entries(deps.profile.repoCommands)) {
      jobs.push({ label: `repo:${name}`, command: cmd }); // repo-wide → no dir → worktree root
    }
```
```ts
    for (const { label, command, dir } of jobs) {
      lastCommand = command;
      const run = await runCommand(command, {
        cwd: join(worktreePath, dir ?? ""),
        timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
      });
```

- [ ] **Step 4: Run — PASS** + full `bun test` + lint + typecheck. (The existing verify tests, whose components have no `dir`, must be unchanged — `cwd` resolves to `worktreePath`.)
- [ ] **Step 5: Commit** — `feat(verify): run each component's command in its module dir (Component.dir cwd, WO-9)`

---

### Task 3: `uniquifyNames` engine post-pass

Land m-c2a Task 1 verbatim so dir-named non-root components stay unique. Independent of `dir`; behavior-preserving (no current fixture has colliding names).

**Files:**
- Modify: `src/setup/detect-components.ts` (add `uniquifyNames`; apply in `runRegistry`)
- Test: `test/setup/engine.test.ts`

**Interfaces:**
- Produces: `uniquifyNames(components: Component[]): Component[]`. `runRegistry` returns `uniquifyNames(out)`.

- [ ] **Step 1: Write failing tests.**
```ts
import { uniquifyNames } from "../../src/setup/detect-components.ts";

test("uniquifyNames qualifies colliding names by kind, leaves unique names alone", () => {
  const cs: Component[] = [
    { name: "services-api", kind: "go", paths: ["services/api/**"], commands: {}, extensions: [".go"] },
    { name: "services-api", kind: "python", paths: ["services/api/**"], commands: {}, extensions: [".py"] },
    { name: "frontend", kind: "node", paths: ["src/**"], commands: {}, extensions: [".ts"] },
  ];
  expect(uniquifyNames(cs).map((c) => c.name).sort()).toEqual(["frontend", "go-services-api", "python-services-api"]);
});
test("uniquifyNames handles a kind-qualified name that itself collides", () => {
  const cs: Component[] = [
    { name: "api", kind: "go", paths: ["api/**"], commands: {}, extensions: [".go"] },
    { name: "api", kind: "go", paths: ["api2/**"], commands: {}, extensions: [".go"] },
  ];
  expect(uniquifyNames(cs).map((c) => c.name).sort()).toEqual(["go-api", "go-api-2"]);
});
```

- [ ] **Step 2: Run — FAIL** (`uniquifyNames` undefined).

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

- [ ] **Step 4: Run — PASS** + full `bun test` (matrix unchanged — no fixture has colliding names) + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): guarantee unique component names in the engine (WO-9, m-c2a Task 1)`

---

### Task 4: Go non-root detection (per-manifest, root + nested)

**Files:**
- Modify: `src/setup/lang/go.ts`
- Modify: `src/setup/detect-components.ts` (remove `go` from `TARGETED_LANG_MANIFESTS` — now detected)
- Test: `test/setup/lang/go.test.ts` (create if absent), `test/setup/detect-components.test.ts` (warning)

**Interfaces:**
- Consumes: `findManifests` (`../manifests.ts`), `Component.dir` (Task 1).

- [ ] **Step 1: Write failing tests** (use the `fixture()` helper from `test/setup/detect-components.test.ts`):
```ts
test("go: single root go.mod → one root component (unchanged)", () => {
  const root = fixture({ "go.mod": "module x\n", "main.go": "" });
  const cs = goDef.detect(root);
  expect(cs).toEqual([{ name: "go", kind: "go", paths: ["**"], commands: { build: "go build ./...", test: "go test ./..." } }]);
});
test("go: subdir-only monorepo → per-subdir dir-scoped components", () => {
  const root = fixture({ "services/api/go.mod": "module api\n", "services/worker/go.mod": "module w\n" });
  const cs = goDef.detect(root).sort((a, b) => a.name.localeCompare(b.name));
  expect(cs.map((c) => [c.name, c.dir, c.paths[0]])).toEqual([
    ["services-api", "services/api", "services/api/**"],
    ["services-worker", "services/worker", "services/worker/**"],
  ]);
});
test("go: root + nested go.mod → root ['**'] AND a nested dir-scoped component", () => {
  const root = fixture({ "go.mod": "module x\n", "tools/gen/go.mod": "module gen\n" });
  const cs = goDef.detect(root);
  expect(cs.find((c) => c.dir === undefined)?.paths).toEqual(["**"]);
  expect(cs.find((c) => c.dir === "tools/gen")?.paths).toEqual(["tools/gen/**"]);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — replace `src/setup/lang/go.ts`:
```ts
import { join } from "node:path";
import { findManifests } from "../manifests.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

export const goDef: LangDef = {
  kind: "go",
  detect(repoDir: string): ComponentDraft[] {
    const out: ComponentDraft[] = [];
    for (const rel of findManifests(repoDir, "go.mod")) {
      const dir = rel.slice(0, -"go.mod".length).replace(/\/$/, "");
      out.push({
        name: dir === "" ? "go" : dir.replace(/\//g, "-"),
        kind: "go",
        ...(dir === "" ? {} : { dir }),
        paths: [dir === "" ? "**" : `${dir}/**`],
        commands: { build: "go build ./...", test: "go test ./..." },
      });
    }
    return out;
  },
};
```
(`join` may be unused now — drop the import if lint flags it.) In `detect-components.ts`, remove the `["go", ["go.mod"]]` entry from `TARGETED_LANG_MANIFESTS` (every `go.mod` is now detected — the Go warning is retired).

- [ ] **Step 4: Run — PASS** + full `bun test` + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): Go non-root detection (per-manifest, dir-scoped) (WO-9)`

---

### Task 5: Python non-root detection + the precise `requirements.txt` warning

**Files:**
- Modify: `src/setup/lang/python.ts`
- Modify: `src/setup/detect-components.ts` (`TARGETED_LANG_MANIFESTS` — remove `python`; add the `requirements.txt`-only warning to `unrootedManifestWarnings`)
- Test: `test/setup/lang/python.test.ts` (create if absent), `test/setup/detect-components.test.ts` (warning)

**Interfaces:**
- Consumes: `findManifests`, `pythonTestCommand` (already in `python.ts`), `Component.dir`.

- [ ] **Step 1: Write failing tests.**
```ts
test("python: single root pyproject → one root component (unchanged)", () => {
  const root = fixture({ "pyproject.toml": "[project]\n" });
  expect(pythonDef.detect(root)).toEqual([{ name: "python", kind: "python", paths: ["**"], commands: { test: "python -m pytest" } }]);
});
test("python: subdir-only pyproject/setup.py → per-subdir dir-scoped components", () => {
  const root = fixture({ "services/a/pyproject.toml": "[project]\n", "services/b/setup.py": "" });
  const cs = pythonDef.detect(root).sort((x, y) => x.name.localeCompare(y.name));
  expect(cs.map((c) => [c.name, c.dir, c.paths[0]])).toEqual([
    ["services-a", "services/a", "services/a/**"],
    ["services-b", "services/b", "services/b/**"],
  ]);
});
test("python: root + nested → root ['**'] AND nested dir-scoped", () => {
  const root = fixture({ "pyproject.toml": "[project]\n", "libs/x/pyproject.toml": "[project]\n" });
  const cs = pythonDef.detect(root);
  expect(cs.find((c) => c.dir === undefined)?.paths).toEqual(["**"]);
  expect(cs.find((c) => c.dir === "libs/x")?.paths).toEqual(["libs/x/**"]);
});
test("python: a module with BOTH pyproject and setup.py → ONE component", () => {
  const root = fixture({ "svc/pyproject.toml": "[project]\n", "svc/setup.py": "" });
  expect(pythonDef.detect(root).filter((c) => c.dir === "svc")).toHaveLength(1);
});
test("python: subdir requirements.txt with no pyproject/setup.py → NOT a module, but warns", () => {
  const root = fixture({ "svc/requirements.txt": "flask\n" });
  expect(pythonDef.detect(root)).toEqual([]); // no module emitted
  expect(unrootedManifestWarnings(root).some((w) => w.includes("svc") && w.includes("requirements.txt"))).toBe(true);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`src/setup/lang/python.ts` — keep `pythonTestCommand` as-is; replace `pythonDef`:
```ts
const PY_ROOT_MANIFESTS = ["pyproject.toml", "setup.py", "requirements.txt"];
const PY_MODULE_ANCHORS = ["pyproject.toml", "setup.py"]; // nested-module anchors (NOT requirements.txt)

export const pythonDef: LangDef = {
  kind: "python",
  detect(repoDir: string): ComponentDraft[] {
    const out: ComponentDraft[] = [];
    // Root component: existing 3-name trigger (incl requirements.txt), unchanged.
    if (PY_ROOT_MANIFESTS.some((m) => existsSync(join(repoDir, m)))) {
      out.push({ name: "python", kind: "python", paths: ["**"], commands: { test: pythonTestCommand(repoDir) } });
    }
    // Nested modules: a subdir with pyproject.toml or setup.py (dedup by dir).
    const dirs = new Set<string>();
    for (const m of PY_MODULE_ANCHORS) {
      for (const rel of findManifests(repoDir, m)) {
        const dir = rel.slice(0, -m.length).replace(/\/$/, "");
        if (dir !== "") dirs.add(dir);
      }
    }
    for (const dir of [...dirs].sort()) {
      out.push({
        name: dir.replace(/\//g, "-"),
        kind: "python",
        dir,
        paths: [`${dir}/**`],
        commands: { test: pythonTestCommand(join(repoDir, dir)) },
      });
    }
    return out;
  },
};
```
Add `import { findManifests } from "../manifests.ts";` to `python.ts` (it already imports `existsSync`/`join`).

`src/setup/detect-components.ts` — remove the `["python", […]]` entry from `TARGETED_LANG_MANIFESTS`, and add the Python `requirements.txt` rule to `unrootedManifestWarnings` (after the JVM loop):
```ts
  // Python: a subdir requirements.txt with NO sibling pyproject.toml/setup.py is not a detectable
  // module — surface it (loud) rather than emitting nothing (would be a silent under-detection).
  for (const rel of findManifests(repoDir, "requirements.txt")) {
    const dir = rel.slice(0, -"requirements.txt".length).replace(/\/$/, "");
    if (dir === "") continue; // root → root component handles it
    const hasAnchor =
      existsSync(join(repoDir, dir, "pyproject.toml")) || existsSync(join(repoDir, dir, "setup.py"));
    if (!hasAnchor)
      out.push(`⚠ requirements.txt under ${dir}/ has no pyproject.toml/setup.py — not a detectable Python module; no component emitted.`);
  }
```

- [ ] **Step 4: Run — PASS** + full `bun test` + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): Python non-root detection + requirements-only warning (WO-9)`

---

### Task 6: Rust/Node `dir` retrofit (correct their non-root command cwd)

Rust's `findManifests` branch and Node's subdir members already emit dir-scoped components with unscoped commands (`cargo test`, `npm run build`) that today run at the repo root (a latent bug Task 2 now lets us fix). Set `dir` on those.

**Files:**
- Modify: `src/setup/lang/rust.ts` (the non-workspace `findManifests` branch)
- Modify: `src/setup/lang/node.ts` (subdir members)
- Test: `test/setup/lang/rust.test.ts`, `test/setup/lang/node.test.ts` (or the detect-components matrix)

- [ ] **Step 1: Write failing tests.** Assert a non-root Rust component (`crates/a/Cargo.toml`, non-workspace) carries `dir: "crates/a"`, and a Node subdir member (`packages/x/package.json`) carries `dir: "packages/x"`; assert the ROOT components (rust workspace root / node `frontend`) carry **no** `dir`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**

`src/setup/lang/rust.ts` — in the `findManifests` loop (non-workspace branch), add `dir` for non-root:
```ts
      components.push({
        name: dir === "" ? "rust" : dir.replace(/\//g, "-"),
        kind: "rust",
        ...(dir === "" ? {} : { dir }),
        paths: [dir === "" ? "**" : `${dir}/**`],
        commands: { build: "cargo build", test: "cargo test" },
      });
```
(The workspace-collapse branch emits a root component — leave it without `dir`.)

`src/setup/lang/node.ts` — in the `components.push`, add `dir` for non-root members:
```ts
      components.push({
        name: isRoot ? "frontend" : dir.replace(/\//g, "-"),
        kind: isRoot && fe ? "sveltekit" : "node",
        ...(isRoot ? {} : { dir }),
        paths: isRoot ? ["src/**", "static/**", "package.json"] : [`${dir}/**`],
        commands,
      });
```

- [ ] **Step 4: Run — PASS** + full `bun test` + lint + typecheck.
- [ ] **Step 5: Commit** — `feat(setup): retrofit dir on Rust/Node non-root components for correct command cwd (WO-9)`

---

## Self-review notes

- **Spec coverage:** design §4.1→Task 1; §4.2→Task 2; §4.4→Task 3; §4.3 Go→Task 4; §4.3 Python + §4.6 warning→Task 5; §4.5 retrofit→Task 6. All four decisions (per-manifest, `dir`+cwd, Python+Go, `uniquifyNames`) covered.
- **Type consistency:** `Component.dir?: string` defined in Task 1, consumed in Tasks 2/4/5/6; `uniquifyNames(Component[]): Component[]` defined in Task 3.
- **Behavior-preservation:** Tasks 1/3 are no-ops for existing fixtures; Task 2's cwd resolves to `worktreePath` when `dir` is undefined; Tasks 4/5 emit the same single `["**"]` component for a root-only repo. The `detect-components.test.ts` matrix should pass unchanged after each task (verify at Step 4).
- **The vacuous-pass fix:** root+nested now emits a nested dir-scoped component (Task 4/5) whose command runs in its dir (Task 2) — the nested module is really gated. The `mergeComponents` `dir` round-trip test (Task 1) guards against silently reverting to root-cwd.
- **Ordering:** 1 (field) → 2 (cwd) → 3 (uniquify) → 4 (Go) → 5 (Python) → 6 (retrofit). Each task's suite stays green.
- **Not shipped:** `scopeColocatedRoots` (rejected); JVM non-root (WO-8). `verify:integration` `repoCommands` stay at worktree root (Task 2c).
