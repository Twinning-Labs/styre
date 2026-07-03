# M-B: deterministic polyglot detectors (Python / Go / JVM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised after an independent 2-reviewer pass (feasibility / scope).** Feasibility: clean (all code compiles, tests RED→GREEN, no existing test breaks). Scope changes folded in: JVM wrapper preference (Task 4), a "loud note" for unrooted manifests (Task 5, honoring design §5.4/§10), and Task 1 reframed as orthogonal hardening (not a prerequisite — root-only detectors never call `findManifests`).

**Goal:** Make `styre setup`'s deterministic scanner detect a component (existence + a runnable test command) for Python, Go, and JVM (Maven/Gradle) repos, so the language-agnostic `run` loop can be exercised across the multilingual benchmark corpus — building on the M-A-hardened pipeline.

**Architecture:** Add manifest-anchored branches to `detectComponents` (`src/setup/detect-components.ts`). New detectors are **root-only** (`existsSync` at the repo root → one component spanning `["**"]`), which gives single-module N=1 by construction and avoids descending into dependency trees. JVM detection prefers the repo's wrapper (`./mvnw`/`./gradlew`) when present (same spirit as §5.3's Python-runner detection). A `..`-style "loud note" warns when a targeted-language manifest is found only in subdirs (the §5.4 deferral, surfaced not silent). Task 1 separately hardens the existing *recursive* Rust/Node detectors by extending the manifest-walk `SKIP` set — an orthogonal pre-existing-bug fix (the new root-only detectors do not use `findManifests`). Multi-module / workspace-collapse for the new languages is deferred (design §5.4).

**Tech Stack:** TypeScript, Bun (`bun test`), biome.

## Global Constraints

- Source of truth: `docs/brainstorms/2026-06-28-polyglot-setup-language-agnostic-design.md` §5 (Track B). C/C++, Ruby, PHP are **out of scope** (operator decision — dropped from first cut).
- Detectors and machine-authored candidate commands (from §5.2/§5.3, with wrapper preference):
  - `pyproject.toml` / `setup.py` / `requirements.txt` → kind `python`, `test` = §5.3 runner detection (no `build`).
  - `go.mod` → kind `go`, `build` = `go build ./...`, `test` = `go test ./...`.
  - `pom.xml` → kind `jvm-maven`; `mvn` is `./mvnw` if a root `mvnw` exists else `mvn`; `build` = `<mvn> -q -DskipTests compile`, `test` = `<mvn> -q test`.
  - `build.gradle` / `build.gradle.kts` → kind `jvm-gradle`; `gradle` is `./gradlew` if a root `gradlew` exists else `gradle`; `build` = `<gradle> build -x test`, `test` = `<gradle> test`.
- Python runner detection order (§5.3): `tox.ini` → `tox`; `noxfile.py` → `nox`; `pytest.ini` OR `[tool.pytest` in `pyproject.toml` → `pytest`; else `python -m pytest`.
- New detectors are **root-only** (single-module N=1, paths `["**"]`). Nested/multi-module manifests are NOT detected; instead a warning is surfaced (Task 5) — never silently dropped.
- No `ComponentSchema` change; `schemaVersion` stays 2. No agent involvement (deterministic only — Tier-2 stays deferred).
- Tests: `bun test`, in `test/` mirroring `src/`, `import { expect, test } from "bun:test";`. Use the existing `fixture(files)` helper in `test/setup/detect-components.test.ts`. Must pass `bun run lint` (biome) + `bun run typecheck`.
- `detect-components.ts` already imports `existsSync, readFileSync, readdirSync, statSync` from `node:fs` and `join` from `node:path`, and `Component` from `../dispatch/profile.ts` — no new imports needed there.

---

### Task 1: Harden the manifest-walk SKIP set (orthogonal existing-detector fix)

The recursive `findManifests` walk (used by the existing **Rust/Node** detectors — the new detectors are root-only and do not use it) descends up to depth 3 and emits phantom components from manifests inside dependency/build dirs (e.g. a `package.json` under a Python repo's `.tox/`, or a `Cargo.toml` under `vendor/`). Extend `SKIP` to cover the common dependency/build dirs of all targeted ecosystems. This is a standalone hardening of shipped behavior; it does not block Tasks 2–4.

**Files:**
- Modify: `src/setup/detect-components.ts:5` (the `SKIP` set)
- Test: `test/setup/detect-components.test.ts` (add case)

**Interfaces:**
- Produces: no signature change; `detectComponents` no longer descends into the added dirs.

- [ ] **Step 1: Write the failing test**

```ts
test("manifests inside dependency/build dirs are skipped (no phantom components)", () => {
  const root = fixture({
    ".tox/py311/lib/package.json": JSON.stringify({ scripts: { test: "x" } }),
    "vendor/github.com/foo/Cargo.toml": '[package]\nname="dep"\n',
    ".gradle/tmp/package.json": JSON.stringify({ scripts: { build: "x" } }),
  });
  const { components } = detectComponents(root);
  expect(components).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/detect-components.test.ts`
Expected: FAIL — without the extended SKIP, `findManifests` finds the `vendor/.../Cargo.toml` (standalone-Rust) and the `.tox`/`.gradle` `package.json`s (Node) → 3 components.

- [ ] **Step 3: Implement** — replace the `SKIP` set at `src/setup/detect-components.ts:5`:

```ts
const SKIP = new Set([
  "node_modules", "target", ".git", "dist", "build", ".svelte-kit",
  ".venv", "venv", "__pycache__", ".tox", ".nox", "vendor", ".gradle", ".mvn", "Pods",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS (existing + new). Then full `bun test` — no regressions.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/setup/detect-components.ts test/setup/detect-components.test.ts
git commit -m "fix(setup): skip dependency/build dirs in manifest walk"
```

---

### Task 2: Python detector + test-runner detection

**Files:**
- Modify: `src/setup/detect-components.ts` (add a `pythonTestCommand` helper + a Python branch after the Node branch, before `return`)
- Test: `test/setup/detect-components.test.ts` (add cases)

**Interfaces:**
- Produces: a root `pyproject.toml`/`setup.py`/`requirements.txt` yields one component `{ name: "python", kind: "python", paths: ["**"], commands: { test: <runner> } }`, `<runner>` per §5.3.

- [ ] **Step 1: Write the failing tests**

```ts
test("python: pyproject.toml → one python component, default runner", () => {
  const root = fixture({ "pyproject.toml": "[project]\nname='x'\n" });
  const py = detectComponents(root).components.find((c) => c.kind === "python");
  expect(py?.paths).toEqual(["**"]);
  expect(py?.commands.test).toBe("python -m pytest");
});

test("python: runner detection precedence tox > nox > pytest-config > default", () => {
  expect(detectComponents(fixture({ "setup.py": "", "tox.ini": "[tox]\n" }))
    .components.find((c) => c.kind === "python")?.commands.test).toBe("tox");
  expect(detectComponents(fixture({ "setup.py": "", "noxfile.py": "" }))
    .components.find((c) => c.kind === "python")?.commands.test).toBe("nox");
  expect(detectComponents(fixture({ "setup.py": "", "pytest.ini": "[pytest]\n" }))
    .components.find((c) => c.kind === "python")?.commands.test).toBe("pytest");
  expect(detectComponents(fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n" }))
    .components.find((c) => c.kind === "python")?.commands.test).toBe("pytest");
  expect(detectComponents(fixture({ "requirements.txt": "pytest\n" }))
    .components.find((c) => c.kind === "python")?.commands.test).toBe("python -m pytest");
});

test("python: no python manifest → no python component", () => {
  expect(detectComponents(fixture({ "README.md": "x" }))
    .components.find((c) => c.kind === "python")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/setup/detect-components.test.ts`
Expected: FAIL — no `python` component.

- [ ] **Step 3: Implement** — add the helper above `detectComponents` and the branch inside it (after the Node loop, before `return { components, repoCommands: {} };`):

```ts
/** §5.3 runner detection: tox > nox > pytest-config > default. Root-level config only. */
function pythonTestCommand(repoDir: string): string {
  if (existsSync(join(repoDir, "tox.ini"))) return "tox";
  if (existsSync(join(repoDir, "noxfile.py"))) return "nox";
  if (existsSync(join(repoDir, "pytest.ini"))) return "pytest";
  const pp = join(repoDir, "pyproject.toml");
  if (existsSync(pp)) {
    try {
      if (/\[tool\.pytest/.test(readFileSync(pp, "utf8"))) return "pytest";
    } catch {
      // unreadable pyproject — fall through to default
    }
  }
  return "python -m pytest";
}
```

```ts
  // --- Python: root manifest → one component (single-module; multi-module deferred §5.4).
  const hasPython = ["pyproject.toml", "setup.py", "requirements.txt"].some((m) =>
    existsSync(join(repoDir, m)),
  );
  if (hasPython) {
    components.push({
      name: "python",
      kind: "python",
      paths: ["**"],
      commands: { test: pythonTestCommand(repoDir) },
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS (existing + 3 new). Then full `bun test`.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/setup/detect-components.ts test/setup/detect-components.test.ts
git commit -m "feat(setup): detect python components with runner detection"
```

---

### Task 3: Go detector

**Files:**
- Modify: `src/setup/detect-components.ts` (add a Go branch after the Python branch)
- Test: `test/setup/detect-components.test.ts` (add cases)

**Interfaces:**
- Produces: a root `go.mod` yields `{ name: "go", kind: "go", paths: ["**"], commands: { build: "go build ./...", test: "go test ./..." } }`. A nested-only `go.mod` yields no Go component (single-module first; Task 5 warns).

- [ ] **Step 1: Write the failing tests**

```ts
test("go: root go.mod → one go component with build/test", () => {
  const go = detectComponents(fixture({ "go.mod": "module x\n\ngo 1.22\n" }))
    .components.find((c) => c.kind === "go");
  expect(go?.paths).toEqual(["**"]);
  expect(go?.commands.build).toBe("go build ./...");
  expect(go?.commands.test).toBe("go test ./...");
});

test("go: nested-only go.mod (no root) → no go component (single-module first)", () => {
  expect(detectComponents(fixture({ "backend/go.mod": "module x\n" }))
    .components.find((c) => c.kind === "go")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/setup/detect-components.test.ts`
Expected: FAIL — no `go` component.

- [ ] **Step 3: Implement** — add after the Python branch:

```ts
  // --- Go: root go.mod → one component (single-module; multi-module/go.work deferred §5.4).
  if (existsSync(join(repoDir, "go.mod"))) {
    components.push({
      name: "go",
      kind: "go",
      paths: ["**"],
      commands: { build: "go build ./...", test: "go test ./..." },
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS. Then full `bun test`.

- [ ] **Step 5: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/setup/detect-components.ts test/setup/detect-components.test.ts
git commit -m "feat(setup): detect go components"
```

---

### Task 4: JVM detectors (Maven + Gradle) with wrapper preference

**Files:**
- Modify: `src/setup/detect-components.ts` (add Maven + Gradle branches after the Go branch)
- Test: `test/setup/detect-components.test.ts` (add cases)

**Interfaces:**
- Produces: root `pom.xml` → `jvm-maven` using `./mvnw` if a root `mvnw` exists else `mvn`; root `build.gradle`/`build.gradle.kts` → `jvm-gradle` using `./gradlew` if a root `gradlew` exists else `gradle`. Commands per Global Constraints.

- [ ] **Step 1: Write the failing tests**

```ts
test("jvm: root pom.xml → jvm-maven (bare mvn when no wrapper)", () => {
  const m = detectComponents(fixture({ "pom.xml": "<project/>" }))
    .components.find((c) => c.kind === "jvm-maven");
  expect(m?.paths).toEqual(["**"]);
  expect(m?.commands.build).toBe("mvn -q -DskipTests compile");
  expect(m?.commands.test).toBe("mvn -q test");
});

test("jvm: pom.xml + mvnw → prefers the maven wrapper", () => {
  const m = detectComponents(fixture({ "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" }))
    .components.find((c) => c.kind === "jvm-maven");
  expect(m?.commands.build).toBe("./mvnw -q -DskipTests compile");
  expect(m?.commands.test).toBe("./mvnw -q test");
});

test("jvm: build.gradle(.kts) → jvm-gradle; gradlew preferred when present", () => {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const g = detectComponents(fixture({ [f]: "" })).components.find((c) => c.kind === "jvm-gradle");
    expect(g?.commands.build).toBe("gradle build -x test");
    expect(g?.commands.test).toBe("gradle test");
  }
  const gw = detectComponents(fixture({ "build.gradle": "", gradlew: "#!/bin/sh\n" }))
    .components.find((c) => c.kind === "jvm-gradle");
  expect(gw?.commands.test).toBe("./gradlew test");
  expect(gw?.commands.build).toBe("./gradlew build -x test");
});

test("jvm: no jvm manifest → no jvm component", () => {
  const comps = detectComponents(fixture({ "README.md": "x" })).components;
  expect(comps.find((c) => c.kind === "jvm-maven" || c.kind === "jvm-gradle")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/setup/detect-components.test.ts`
Expected: FAIL — no `jvm-*` component.

- [ ] **Step 3: Implement** — add after the Go branch:

```ts
  // --- JVM (single-module; multi-module reactor deferred §5.4). Prefer the repo's wrapper.
  if (existsSync(join(repoDir, "pom.xml"))) {
    const mvn = existsSync(join(repoDir, "mvnw")) ? "./mvnw" : "mvn";
    components.push({
      name: "jvm-maven",
      kind: "jvm-maven",
      paths: ["**"],
      commands: { build: `${mvn} -q -DskipTests compile`, test: `${mvn} -q test` },
    });
  }
  if (existsSync(join(repoDir, "build.gradle")) || existsSync(join(repoDir, "build.gradle.kts"))) {
    const gradle = existsSync(join(repoDir, "gradlew")) ? "./gradlew" : "gradle";
    components.push({
      name: "jvm-gradle",
      kind: "jvm-gradle",
      paths: ["**"],
      commands: { build: `${gradle} build -x test`, test: `${gradle} test` },
    });
  }
```

- [ ] **Step 4: Run tests + full suite to verify**

Run: `bun test test/setup/detect-components.test.ts && bun test`
Expected: PASS (all).

- [ ] **Step 5: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/setup/detect-components.ts test/setup/detect-components.test.ts
git commit -m "feat(setup): detect JVM (maven/gradle) components with wrapper preference"
```

---

### Task 5: Loud note for unrooted (subdir-only) manifests

Honors design §5.4/§10: single-module-first must surface a **loud note** rather than silently emit nothing when a targeted-language manifest exists only in subdirectories (so the operator knows why no component was produced). Applies to the four new root-only languages only (nested Node/Rust manifests are legitimately handled by their recursive detectors).

**Files:**
- Modify: `src/setup/detect-components.ts` (export `unrootedManifestWarnings`)
- Modify: `src/cli/setup.ts` (surface the warnings in `runSetup`)
- Test: `test/setup/detect-components.test.ts` (add cases)

**Interfaces:**
- Consumes: the internal `findManifests` (already in `detect-components.ts`).
- Produces: `unrootedManifestWarnings(repoDir: string): string[]` — one warning per targeted language whose manifest is found in a subdir but not at the repo root.

- [ ] **Step 1: Write the failing tests**

```ts
import { unrootedManifestWarnings } from "../../src/setup/detect-components.ts";

test("loud note: subdir-only go.mod warns; root go.mod does not", () => {
  const nested = unrootedManifestWarnings(fixture({ "backend/go.mod": "module x\n" }));
  expect(nested.some((w) => /go\.mod/.test(w) && /backend/.test(w) && /deferred/i.test(w))).toBe(true);
  expect(unrootedManifestWarnings(fixture({ "go.mod": "module x\n" }))).toEqual([]);
});

test("loud note: subdir-only pyproject warns; non-targeted nested files do not", () => {
  expect(unrootedManifestWarnings(fixture({ "src/pyproject.toml": "[project]\n" }))
    .some((w) => /pyproject\.toml/.test(w))).toBe(true);
  expect(unrootedManifestWarnings(fixture({ "README.md": "x" }))).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/setup/detect-components.test.ts`
Expected: FAIL — `unrootedManifestWarnings` is not exported.

- [ ] **Step 3: Implement** — add to `src/setup/detect-components.ts` (after `detectComponents`):

```ts
const TARGETED_LANG_MANIFESTS: Array<[string, string[]]> = [
  ["python", ["pyproject.toml", "setup.py", "requirements.txt"]],
  ["go", ["go.mod"]],
  ["jvm-maven", ["pom.xml"]],
  ["jvm-gradle", ["build.gradle", "build.gradle.kts"]],
];

/** §5.4 loud note: warn when a targeted-language manifest exists only in subdirs (no root match),
 *  so root-only detection's deferral is surfaced rather than silent. */
export function unrootedManifestWarnings(repoDir: string): string[] {
  const out: string[] = [];
  for (const [lang, names] of TARGETED_LANG_MANIFESTS) {
    if (names.some((n) => existsSync(join(repoDir, n)))) continue; // detected at root — fine
    for (const n of names) {
      const nested = findManifests(repoDir, n);
      if (nested.length > 0) {
        const dir = nested[0].replace(/\/?[^/]+$/, "") || ".";
        out.push(
          `⚠ ${n} found under ${dir}/ but not at repo root — multi-module detection deferred (§5.4); no ${lang} component emitted.`,
        );
        break;
      }
    }
  }
  return out;
}
```

Then in `src/cli/setup.ts` `runSetup`, after the profile's components are resolved (alongside the existing `discovered.warnings` print), add:

```ts
for (const w of unrootedManifestWarnings(repoDir)) console.warn(w);
```

(Import `unrootedManifestWarnings` from `../setup/detect-components.ts` at the top of `setup.ts`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/detect-components.test.ts && bun test`
Expected: PASS (all).

- [ ] **Step 5: Lint + typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/setup/detect-components.ts src/cli/setup.ts test/setup/detect-components.test.ts
git commit -m "feat(setup): loud note when a targeted-language manifest is subdir-only (§5.4)"
```

---

## Self-review notes (author)

- **Spec coverage:** §5.1 SKIP → Task 1 (orthogonal existing-detector hardening); §5.2 Python/Go/JVM table → Tasks 2/3/4 (JVM wrapper preference added per review); §5.3 Python runner → Task 2; §5.4 single-module-first + **loud note** → root-only detectors + Task 5. C/C++/Ruby/PHP correctly absent.
- **Review findings folded in:** JVM wrapper preference (scope Finding 2); loud-note Task 5 (scope Finding 1 / design §5.4/§10 / no-silent-deferral); Task 1 reframed as orthogonal (scope Finding 5).
- **Accepted/scoped:** `["**"]` overlap (verified sound downstream — union+aggregate, never substitutes a wrong command); `python -m pytest` default partiality (mitigated by §5.3, honestly acknowledged); multi-module workspace-collapse deferred but now surfaced via Task 5.
- **Type consistency:** every detector pushes a `Component`; `pythonTestCommand(repoDir: string): string` and `unrootedManifestWarnings(repoDir: string): string[]` are the only new functions; `paths: ["**"]` is valid for deterministic scan output (the anchored-paths guard binds only *agent* paths in `mergeComponents`).
- **Telemetry note (out of scope, confirmed):** new kinds bucket to `"other"` in `component_kinds` (consistent with existing rust/node); the bench's Axis-2 per-language metric reads `stackBucket` (`STACK_KEYWORDS` already recognizes go/jvm/python). No telemetry change in this milestone.
