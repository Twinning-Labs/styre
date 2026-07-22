# Language Stack Registry Implementation Plan (ENG-344)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `src/dispatch/stack-registry.ts` as the home for invariant per-`kind` ecosystem facts, and make the toolchain preflight derive "precondition vs install-provided" from it — retiring the ENG-332 special-case that was a workaround standing in for a fact.

**Architecture:** One new module holding *only* the install facts the preflight consumes, keyed by component `kind`, with a total lookup that degrades conservatively for kinds it does not model. The data-vs-logic boundary is enforced by a checked-in literal snapshot plus structural assertions (no functions, no getters, plain prototypes). Every other scattered per-ecosystem table stays where it is; each migrates in the follow-up, *with* the field it needs.

**Tech Stack:** TypeScript on Bun. Tests are `bun test` (`import { describe, expect, test } from "bun:test"`). Lint is `bun run lint` (Biome); types are `bun run typecheck` (`tsc --noEmit --strict`).

**Spec:** `docs/brainstorms/2026-07-22-eng-344-language-stack-registry-design.md`. Read §4.2 (the preflight rule), §5 (the boundary), §5.6 (the residual), §6 (behavior changes) before starting.

## Scope: why this is two tasks and not eleven

An earlier version of this plan carried the whole migration — 11 tasks, 10 files across `cli`/`dispatch`/`setup`, shipping five independent behavior changes in four unrelated subsystems. Three independent adversarial reviews rejected that as a one-concern violation (`CLAUDE.md`; `docs/architecture/ticket-template.md:309-312` cites ENG-332 precisely as the exemplar of an independently-shippable ticket). Five behavior changes are five independent revert reasons in one PR.

The work now splits three ways:

| Ticket | Carries | Depends on |
|---|---|---|
| **ENG-344** (this plan) | the registry module + the preflight fix — the motivating bug and AC 2 | — |
| **`fix/` × 2** | the two live bugs found during design, ~2 lines each | nothing |
| **`refactor/` follow-up** | the mechanical fold of the remaining tables (`docs/plans/2026-07-22-eng-360-mechanical-fold.md`) | ENG-344 |

The two bugs are deliberately **not** bundled: `MANIFEST_BASENAMES` (`provision.ts:192`) omitting `Gemfile`/`composer.json`, and `SOURCE_EXTS` (`check-rules.ts:4`) missing eight extensions. Both are ~2-line fixes needing no registry at all. Bundling them made the registry look load-bearing for bugs it is not.

**Consequence for the registry's shape.** With the folds moved out, `extensions`, `manifests`, `installMarkers`, `interpreters`, `detectAnchors`, `ignoreDirs` and `manifestPatterns` have **zero consumers here**. The ticket's own rule — *"start with the subset that has ≥2 real consumers — don't add speculative fields"* — means they do not ship in this PR. Each lands in the follow-up task that reads it. `StackFacts` therefore starts with two fields and grows; the module is the single home regardless of how many it currently holds.

This also means **PR 1 creates no duplication window**: `EXTENSIONS_BY_KIND`, `SKIP`, `MANIFEST_BASENAMES` and friends are untouched and un-duplicated until the task that deletes them.

## Global Constraints

- **Never commit to `main`.** All work on `feat/eng-344-language-stack-registry`. No `gh pr merge`, ever.
- **Every task ends green with `bun run format && bun run lint && bun run typecheck && bun test`** — all four. `bun run lint` is `biome check .` (no `--write`) and the repo enforces `lineWidth: 100` + `organizeImports`, so hand-wrapped pasted code FAILS lint unless formatted first. `bun run typecheck` is what CI runs (`.github/workflows/ci.yml:18`); Biome does not type-check and `bun test` strips types, so a duplicate import or type slip commits green and explodes in CI later.
- **Import placement and order.** Biome sorts specifiers naturally, so `"bun:test"` sorts BEFORE `"node:fs"`. Never add an import mid-file — merge into the existing import statement for that module.
- **The registry holds no functions, getters, or class instances.** Strings and readonly arrays of strings only. Anything that *decides* belongs in the consumer.
- **Nine kinds, exactly:** `rust`, `node`, `sveltekit`, `python`, `go`, `jvm-maven`, `jvm-gradle`, `ruby`, `php`.
- **Do NOT add fields with no consumer in this PR** — not `extensions`, `manifests`, `interpreters`, `detectAnchors`, `ignoreDirs`, `installMarkers`, `installOutputDir`, `manifestPatterns`, `checkFrameworks`, or `testFilePattern`. They belong to the follow-up, with their consumers.
- **Do NOT touch** `src/setup/lang/*.ts`, `src/dispatch/check-selector.ts`, `src/dispatch/check-rules.ts`, `src/dispatch/components.ts`, `src/dispatch/provision.ts`, `src/setup/manifests.ts`, `src/setup/detect-components.ts`, or `src/setup/runtime-deps/`. All follow-up.
- Commit messages: conventional-commit with a scope, ending with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/dispatch/stack-registry.ts` | **create** | Invariant per-`kind` install facts. The home the follow-up grows. |
| `test/dispatch/stack-registry.test.ts` | **create** | Boundary invariants + the literal snapshot. |
| `src/cli/preflight.ts` | modify | Derives precondition-vs-install-provided from the registry. |
| `test/cli/preflight.test.ts` | modify | New coverage + three pre-existing assertions updated. |
| `docs/architecture/conventions.md` | modify | Documents the registry as the extension point. |

---

### Task 1: The registry module

**Files:**
- Create: `src/dispatch/stack-registry.ts`
- Test: `test/dispatch/stack-registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface StackFacts`; `const STACKS: Readonly<Record<string, StackFacts>>`; `function stackFacts(kind: string): StackFacts`; `function isModeledKind(kind: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/stack-registry.test.ts`. Note the import order — `bun:test` before `node:*`, matching `test/cli/preflight.test.ts:1`.

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STACKS, isModeledKind, stackFacts } from "../../src/dispatch/stack-registry.ts";
import { REGISTRY } from "../../src/setup/registry.ts";

const KINDS = [
  "rust", "node", "sveltekit", "python", "go",
  "jvm-maven", "jvm-gradle", "ruby", "php",
] as const;

describe("boundary: the registry is data, not logic", () => {
  // §5.1 — no functions, no getters, plain prototypes.
  // getOwnPropertyDescriptors does NOT invoke accessors; Object.entries DOES,
  // which is how an earlier draft's walk was blind to
  //   get installProvidedTools() { return Bun.file(`${process.cwd()}/x`).size ? A : B; }
  test("no functions, no getters, no exotic prototypes", () => {
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) {
        v.forEach((el, i) => walk(el, `${path}[${i}]`));
        return;
      }
      if (v !== null && typeof v === "object") {
        expect(
          Object.getPrototypeOf(v) === Object.prototype ? null : `${path}: exotic prototype`,
        ).toBeNull();
        for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
          expect(d.get === undefined ? null : `${path}.${k}: getter`).toBeNull();
          walk(d.value, `${path}.${k}`);
        }
        return;
      }
      expect(
        ["string", "boolean", "undefined"].includes(typeof v) ? null : `${path}: ${typeof v}`,
      ).toBeNull();
    };
    walk(STACKS, "STACKS");
  });

  // §5.2 — THE load-bearing assertion. Purity is not decidable from source text
  // (Bun.*, process.*, globalThis all reach the filesystem with no import), so
  // pin the whole table to a literal: a repo-state-dependent registry would have
  // to produce this byte-for-byte from every working directory, and any
  // deliberate fact change must be made twice, in a diff a reviewer sees.
  test("STACKS equals its checked-in snapshot", () => {
    expect(STACKS).toEqual(SNAPSHOT);
  });

  // §5.3 — defence in depth and a fast, legible failure. A lint rule, not a proof.
  test("the module source reaches for nothing external", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/dispatch/stack-registry.ts"),
      "utf8",
    );
    for (const bad of ["import ", "import(", "require(", "Bun.", "process.", "globalThis"]) {
      expect(src.includes(bad) ? `${bad} found` : null).toBeNull();
    }
  });

  test("STACKS and its entries are frozen", () => {
    expect(Object.isFrozen(STACKS)).toBe(true);
    for (const kind of KINDS) {
      expect(Object.isFrozen(STACKS[kind])).toBe(true);
      expect(Object.isFrozen(STACKS[kind].installProvidedTools)).toBe(true);
    }
  });
});

describe("coverage", () => {
  test("has an entry for every modeled kind and nothing else", () => {
    expect(Object.keys(STACKS).sort()).toEqual([...KINDS].sort());
  });

  test("isModeledKind is true for the nine kinds, false otherwise", () => {
    for (const k of KINDS) expect(isModeledKind(k)).toBe(true);
    expect(isModeledKind("elixir")).toBe(false);
    expect(isModeledKind("")).toBe(false);
  });

  test("stackFacts is total — an unmodeled kind yields conservative empties", () => {
    const f = stackFacts("elixir");
    expect(f.installBinDirs).toEqual([]);
    expect(f.installProvidedTools).toEqual([]);
  });

  test("every kind the detector registry emits has stack facts (§5.4)", () => {
    // LangDef.kind was previously unused by the engine; this is its first consumer.
    // `sveltekit` is computed inside node.ts rather than being a LangDef.kind,
    // so it is covered by the "nine kinds" test above instead.
    for (const def of REGISTRY) expect(isModeledKind(def.kind)).toBe(true);
  });
});

describe("the ENG-332 facts", () => {
  test("php's test tool is install-provided via vendor/bin", () => {
    expect(stackFacts("php").installBinDirs).toEqual(["vendor/bin"]);
    expect(stackFacts("php").installProvidedTools).toEqual(["phpunit", "pest"]);
  });

  test("python's runners are install-provided by bare name", () => {
    expect(stackFacts("python").installProvidedTools).toEqual(["pytest", "tox", "nox"]);
  });

  test("node's package managers are preconditions, NOT install-provided", () => {
    // npm/pnpm/yarn must be on PATH before provision can run at all.
    expect(stackFacts("node").installProvidedTools).toEqual([]);
    expect(stackFacts("sveltekit").installProvidedTools).toEqual([]);
  });

  test("ruby's bundle is a precondition", () => {
    // `bundle` ships with ruby, so `bundle exec rspec` must be probed.
    expect(stackFacts("ruby").installProvidedTools).toEqual([]);
    expect(stackFacts("ruby").installBinDirs).toEqual([]);
  });

  test("go/jvm/rust have no install step, so nothing is install-provided", () => {
    for (const k of ["go", "rust", "jvm-maven", "jvm-gradle"]) {
      expect(stackFacts(k).installProvidedTools).toEqual([]);
      expect(stackFacts(k).installBinDirs).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/stack-registry.ts'`.

- [ ] **Step 3: Write the registry**

Create `src/dispatch/stack-registry.ts`. The file has **no import statements**.

```ts
/** THE home for invariant, per-ecosystem facts keyed by component `kind` (ENG-344).
 *
 *  Why this module exists: the ENG-332 toolchain preflight shipped a bug because a load-bearing
 *  ecosystem fact was TACIT. `php.ts:30` emits `test: "./vendor/bin/phpunit"` alongside
 *  `prepare: "composer install"` — the test tool is PRODUCED BY the install step and absent on a
 *  clean checkout. That fact lived nowhere explicit (only implied by a command string), so the
 *  preflight probed it before provision ran and false-failed on a clean clone. ENG-332 patched it
 *  with "component has a prepare -> probe only the prepare tool", a workaround standing in for a
 *  fact. This module makes it a fact.
 *
 *  THE BOUNDARY (see test/dispatch/stack-registry.test.ts):
 *  - No functions, getters, or class instances. Strings and readonly string arrays only.
 *  - The load-bearing guarantee is the test's checked-in literal SNAPSHOT, NOT this file's lack of
 *    imports. Purity is not decidable from source text — `Bun.file()`, `process.cwd()` and
 *    `globalThis` all reach the filesystem with no import at all, and `Object.entries` invokes a
 *    getter. Do not weaken the snapshot; it is what actually holds the line.
 *
 *  WHAT DOES NOT BELONG HERE: anything conditional on a specific repo's contents — which package
 *  manager it uses (lockfile scan), which test runner (tox/nox/pytest config scan), its python
 *  import name (pyproject parse), which check framework its test command implies (a command sniff).
 *  Those stay as detector logic in `src/setup/lang/*.ts` and `src/dispatch/check-*.ts`.
 *
 *  A KNOWN RESIDUAL (spec §5.6): "tool X is produced by the install step" is really a property of a
 *  component's `prepare`, not of its ecosystem. `pythonPrepare` (`python.ts:21-33`) emits four
 *  different commands installing four different things, and this table answers the same for all
 *  four. That is not a regression — ENG-332's blanket special-case has the identical hole — but it
 *  is why `collectToolProbes` gates its skip on `c.prepare !== undefined`: the registry says what an
 *  install WOULD provide; only the component says whether one runs.
 *
 *  This table starts small on purpose. Fields are added alongside the consumers that read them (the
 *  ticket's rule: no speculative fields). Migrating the remaining per-ecosystem tables — extensions,
 *  manifests, install markers, interpreters, detect anchors, ignore dirs — is the follow-up, and
 *  each brings its field with it. */
export interface StackFacts {
  /** Dirs, relative to the component root, where the install step drops executables. A command
   *  whose leading token sits under one of these is install-provided, so the preflight must not
   *  probe it before provision has run. */
  readonly installBinDirs: readonly string[];
  /** BARE tool names the install step puts on PATH — syntactically indistinguishable from a
   *  precondition, which is exactly why they must be data rather than inference.
   *  `pip`/`npm`/`bundle`/`composer` are deliberately NOT here: they must already exist for the
   *  install itself to run, so they are preconditions and must be probed. */
  readonly installProvidedTools: readonly string[];
}

/** No install step at all: go, rust and both JVM kinds resolve dependencies inside their own build
 *  invocation, so every tool they name is a precondition. */
const NO_INSTALL_STEP: StackFacts = { installBinDirs: [], installProvidedTools: [] };

/** Has an install step, but it provides no tool the command strings can name:
 *  - node/sveltekit: `prepare` is npm/pnpm/yarn and `build`/`test` are `npm run <script>` — the
 *    package manager must pre-exist, and the inner binary never appears in the command string.
 *  - ruby: `prepare` is `bundle install` and tests run `bundle exec rspec`; `bundle` ships with
 *    ruby, so it is a precondition either way. */
const INSTALLS_NO_NAMED_TOOLS: StackFacts = { installBinDirs: [], installProvidedTools: [] };

const RAW: Record<string, StackFacts> = {
  rust: NO_INSTALL_STEP,
  go: NO_INSTALL_STEP,
  "jvm-maven": NO_INSTALL_STEP,
  "jvm-gradle": NO_INSTALL_STEP,
  node: INSTALLS_NO_NAMED_TOOLS,
  sveltekit: INSTALLS_NO_NAMED_TOOLS,
  ruby: INSTALLS_NO_NAMED_TOOLS,
  python: {
    // pip installs into the active env's site-packages, not a component-relative dir, so there is
    // no bin dir to match on — the runners are reachable only by bare name.
    installBinDirs: [],
    // Exactly the runners `pythonTestCommand` (python.ts:6-19) can emit, minus its
    // `python -m pytest` fallback, whose LEADING token is the interpreter `python` — a genuine
    // precondition that must be probed. See the residual note in this file's header.
    installProvidedTools: ["pytest", "tox", "nox"],
  },
  php: {
    // THE ENG-332 FACT: `./vendor/bin/phpunit` does not exist until `composer install` has run.
    installBinDirs: ["vendor/bin"],
    // Bare-name forms, for a config-override `test` that does not use the vendor path.
    installProvidedTools: ["phpunit", "pest"],
  },
};

/** Deep-freeze so no consumer can mutate a shared fact. */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const el of value) deepFreeze(el);
    return Object.freeze(value) as T;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    return Object.freeze(value) as T;
  }
  return value;
}

export const STACKS: Readonly<Record<string, StackFacts>> = deepFreeze(RAW);

/** Conservative facts for a kind the registry does not model. `kind` is an unconstrained
 *  `z.string()` in `ComponentSchema` (`profile.ts:98`), so a config-override or hand-edited profile
 *  may legitimately carry one. Empty means "we know of nothing install-provided" — a caller that
 *  would read that as "so probe everything" must gate on `isModeledKind` instead. */
const UNMODELED: StackFacts = deepFreeze({ installBinDirs: [], installProvidedTools: [] });

/** Total lookup — never throws, never returns undefined. */
export function stackFacts(kind: string): StackFacts {
  return STACKS[kind] ?? UNMODELED;
}

/** True iff the registry has real facts for this kind. A consumer that would otherwise read
 *  UNMODELED's empties as "nothing is install-provided, so probe everything" must gate on this —
 *  over-probing an un-modeled ecosystem re-creates the very clean-checkout false-fail this module
 *  exists to prevent. */
export function isModeledKind(kind: string): boolean {
  return Object.hasOwn(STACKS, kind);
}
```

**On the two shared constants:** `NO_INSTALL_STEP` and `INSTALLS_NO_NAMED_TOOLS` are both `{[], []}` today and are shared object references, so seven kinds point at two objects. That is deliberate — the *names* carry reasoning that would otherwise be a comment repeated seven times. It also means any test of the form `expect(stackFacts("node")).toEqual(stackFacts("ruby"))` compares an object to itself and asserts nothing; the snapshot is what pins them. When the follow-up adds fields that differ between these kinds, split the constants.

- [ ] **Step 4: Add the snapshot, then run the tests**

Generate `SNAPSHOT` mechanically — hand-typing it defeats the purpose:

```bash
bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log("const SNAPSHOT = " + JSON.stringify(m.STACKS, null, 2) + ";"))'
```

Paste the output at the **bottom** of `test/dispatch/stack-registry.test.ts`.

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Verify the boundary test actually bites**

Temporarily add to the registry, immediately after the `RAW` declaration:

```ts
Object.defineProperty(RAW.go, "installProvidedTools", { get: () => [] });
```

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: **FAIL** on "no functions, no getters, no exotic prototypes" with `STACKS.go.installProvidedTools: getter`. If it passes, the walk is using `Object.entries` (which invokes accessors) instead of `Object.getOwnPropertyDescriptors` — fix it. **Then revert this line.**

This step exists because the previous version of this boundary test did *not* bite, and nobody noticed until an independent reviewer demonstrated a repo-state-branching registry passing every assertion.

- [ ] **Step 6: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/stack-registry.ts test/dispatch/stack-registry.test.ts
git commit -m "feat(dispatch): add the language stack registry (ENG-344)

The home for invariant per-ecosystem facts keyed by component kind. Starts
with only the install facts the preflight consumes — remaining fields land
in the follow-up alongside the consumers that read them, per the ticket's
no-speculative-fields rule. No table is duplicated in the meantime.

The data-vs-logic boundary is held by a checked-in literal snapshot plus
structural assertions (no functions, no getters, plain prototypes). It is
deliberately NOT held by the module's lack of imports: Bun.file(),
process.cwd() and globalThis all reach the filesystem with no import, so a
source-text check cannot decide purity.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 2: Preflight derives precondition-vs-install-provided

The headline. This is AC 2 and the reason the ticket exists.

**Files:**
- Modify: `src/cli/preflight.ts:1-40`
- Test: `test/cli/preflight.test.ts`

**Interfaces:**
- Consumes: `stackFacts`, `isModeledKind`, `StackFacts` from Task 1.
- Produces: `isInstallProvided(command: string, facts: StackFacts): boolean` (exported for test). `collectToolProbes(profile: Profile): ToolProbe[]` keeps its signature and `ToolProbe` shape.

- [ ] **Step 1: Write the failing test**

Add to `test/cli/preflight.test.ts`. **Reuse the file's existing `makeProfile` helper (`test/cli/preflight.test.ts:21-23`)** — it routes through `parseProfile`, so fixtures are schema-validated. Do NOT define a local helper that casts `as unknown as Profile`. Merge new imports into the existing statements: `describe/expect/test`, `collectToolProbes` and `type Profile` are already imported at lines 1, 9, 14 — only `isInstallProvided` and `stackFacts` are new.

```ts
const base = { paths: ["**"], extensions: [] };

describe("isInstallProvided", () => {
  test("a command under an install bin dir is install-provided", () => {
    expect(isInstallProvided("./vendor/bin/phpunit", stackFacts("php"))).toBe(true);
    expect(isInstallProvided("vendor/bin/pest", stackFacts("php"))).toBe(true);
  });

  test("a bare install-provided tool name matches", () => {
    for (const cmd of ["tox", "nox", "pytest -q"]) {
      expect(isInstallProvided(cmd, stackFacts("python"))).toBe(true);
    }
  });

  test("the interpreter in `python -m pytest` is NOT install-provided", () => {
    // The leading token is `python`, a precondition — pytest is merely its argument.
    expect(isInstallProvided("python -m pytest", stackFacts("python"))).toBe(false);
  });

  test("package managers and preconditions are not install-provided", () => {
    expect(isInstallProvided("npm run test", stackFacts("node"))).toBe(false);
    expect(isInstallProvided("pip install -e .", stackFacts("python"))).toBe(false);
    expect(isInstallProvided("bundle exec rspec", stackFacts("ruby"))).toBe(false);
    expect(isInstallProvided("composer install", stackFacts("php"))).toBe(false);
    expect(isInstallProvided("go test ./...", stackFacts("go"))).toBe(false);
  });

  test("any relative path is install/build output, for ANY kind (spec §5.6)", () => {
    // Kind-agnostic rule. Covers composer's configurable bin-dir
    // ("config": {"bin-dir": "bin"}), ./mvnw, ./gradlew, and unmodeled ecosystems.
    expect(isInstallProvided("bin/phpunit", stackFacts("php"))).toBe(true);
    expect(isInstallProvided("./mvnw -q test", stackFacts("jvm-maven"))).toBe(true);
    expect(isInstallProvided("./deps/bin/x", stackFacts("elixir"))).toBe(true);
  });
});

describe("collectToolProbes — the ENG-332 clean-checkout guarantee", () => {
  test("php probes composer but NOT ./vendor/bin/phpunit", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "php", kind: "php",
          commands: { test: "./vendor/bin/phpunit" }, prepare: "composer install" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["composer install"]);
  });

  test("python probes pip but NOT tox", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "python", kind: "python",
          commands: { test: "tox" }, prepare: "pip install tox" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["pip install tox"]);
  });
});

describe("collectToolProbes — the c.prepare gate (spec §4.2)", () => {
  test("a modeled kind with NO prepare probes its tools — they are preconditions", () => {
    // THE bug an earlier draft shipped: the registry says pytest is install-provided,
    // but with no install step nothing will ever supply it, so it MUST be probed.
    // Ungated, this returned [] — strictly worse than the code it replaced.
    const probes = collectToolProbes(
      makeProfile([{ ...base, name: "py", kind: "python", commands: { test: "pytest" } }]),
    );
    expect(probes.map((p) => p.command)).toEqual(["pytest"]);
  });

  test("same for php with no prepare", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "php", kind: "php", commands: { test: "./vendor/bin/phpunit" } },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["./vendor/bin/phpunit"]);
  });
});

describe("collectToolProbes — coverage the special-case dropped (spec §6.1, §6.2)", () => {
  test("node probes its npm scripts as well as its prepare", () => {
    // NOTE: probeCommandExists short-circuits on `npm run` and checks only that the
    // SCRIPT KEY exists in package.json — it never resolves `npm` on PATH
    // (discover-schema.ts:57-62). So this restores a profile-staleness check, NOT
    // the missing-npm check ENG-332 §7 claimed. See spec §6.1's correction.
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "frontend", kind: "node",
          commands: { build: "npm run build", test: "npm run test" },
          prepare: "pnpm install --frozen-lockfile" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual([
      "pnpm install --frozen-lockfile", "npm run build", "npm run test",
    ]);
  });

  test("`python -m pytest` has its interpreter probed", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "python", kind: "python",
          commands: { test: "python -m pytest" }, prepare: "pip install -e ." },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["pip install -e .", "python -m pytest"]);
  });

  test("ruby probes bundle exec rspec — bundle is a precondition", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "ruby", kind: "ruby",
          commands: { test: "bundle exec rspec" }, prepare: "bundle install" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["bundle install", "bundle exec rspec"]);
  });
});

describe("collectToolProbes — unchanged behavior", () => {
  test("go and jvm still probe build and test (no prepare)", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "go", kind: "go",
          commands: { build: "go build ./...", test: "go test ./..." } },
        { ...base, name: "jvm-maven", kind: "jvm-maven",
          commands: { build: "mvn -q -DskipTests compile", test: "mvn -q test" } },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual([
      "go build ./...", "go test ./...", "mvn -q -DskipTests compile", "mvn -q test",
    ]);
  });

  test("an unavailable command slot is not probed", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "ruby", kind: "ruby",
          commands: { test: { unavailable: true } }, prepare: "bundle install" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["bundle install"]);
  });
});

describe("collectToolProbes — the unmodeled-kind fallback (spec §6.6)", () => {
  test("an unmodeled prepare-bearing kind probes ONLY its prepare", () => {
    // We cannot know which of an un-modeled ecosystem's tools its install provides,
    // so probing build/test would risk re-introducing the ENG-332 false-fail.
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "elixir", kind: "elixir",
          commands: { test: "mix test" }, prepare: "mix deps.get" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["mix deps.get"]);
  });

  test("an unmodeled kind with NO prepare still probes build/test", () => {
    const probes = collectToolProbes(
      makeProfile([
        { ...base, name: "elixir", kind: "elixir", commands: { test: "mix test" } },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["mix test"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/preflight.test.ts`
Expected: FAIL — `isInstallProvided` is not exported, and the new coverage tests fail because the current special-case returns only the prepare probe.

**After Step 3, THREE PRE-EXISTING tests in this same file will also fail.** Two reviewers reproduced this independently. They are not regressions — they encode the ENG-332 semantics this task deletes. Update each; do NOT weaken `collectToolProbes` to preserve them:

| Test | Why it breaks | Fix |
|---|---|---|
| `preflight.test.ts:30` | php fixture's `build: "composer build"` — `composer` is neither a relative path, under `vendor/bin`, nor in the tools list, so it is now probed | add the `{component:"api",label:"build",command:"composer build"}` entry to the expectation |
| `preflight.test.ts:90` | node fixture gains `web/build` + `web/test` npm-script probes (intended, §6.1) | add both entries |
| `preflight.test.ts:115` `"a prepare-provided test tool is NOT probed (php clean checkout)"` | its `build: "true"` is now probed and `fakeProbe(["composer"])` lacks `true` | drop the `build` slot from that fixture, so the test still isolates the `./vendor/bin/phpunit` skip it exists to check |

`test/cli/run-preflight.test.ts` is **unaffected** (`kind: "custom"`, no `prepare` → unmodeled-with-no-prepare path, identical output).

- [ ] **Step 3: Rewrite `collectToolProbes`**

In `src/cli/preflight.ts`, add the import and replace lines 14-40 (the doc comment and function body). Leave `ToolProbe` (lines 6-12), `MissingCommand`, `missingHint`, `preflightToolchain` and `formatMissingTools` untouched.

```ts
import { type StackFacts, isModeledKind, stackFacts } from "../dispatch/stack-registry.ts";

/** True iff `command`'s leading program is PRODUCED BY an install step, and so is absent on a clean
 *  checkout by construction. Three shapes:
 *   - a relative path — kind-agnostic; covers `./vendor/bin/phpunit`, composer's configurable
 *     `bin-dir` (`bin/phpunit`), `./mvnw`, `./gradlew`, and any unmodeled ecosystem's `./deps/bin/x`;
 *   - a path under one of the kind's `installBinDirs`;
 *   - a bare tool the kind's install puts on PATH (python's `tox`/`nox`/`pytest`).
 *
 *  Everything else is a genuine precondition, including package managers (`npm`, `pip`, `bundle`,
 *  `composer` — they must exist for the install itself to run) and interpreters (`python` in
 *  `python -m pytest`; pytest is merely its argument). Probing an install-provided tool before
 *  provision runs is the ENG-332 bug; NOT probing a precondition is lost coverage.
 *
 *  Callers MUST also check that the component actually has a `prepare` — see `collectToolProbes`. */
export function isInstallProvided(command: string, facts: StackFacts): boolean {
  const token = (command.trim().split(/\s+/)[0] ?? "").replace(/^\.\//, "");
  if (token.includes("/")) return true;
  if (facts.installBinDirs.some((d) => token.startsWith(`${d}/`))) return true;
  return facts.installProvidedTools.includes(token);
}

/** Enumerate every command whose leading program the run must be able to invoke. A component's
 *  `prepare` is always a precondition — provision cannot install its own installer. Its
 *  `build`/`test`/`check` tools are probed UNLESS the component has an install step AND the registry
 *  says that step provides them.
 *
 *  This replaces ENG-332's blanket "has a prepare -> probe only prepare", which was a workaround
 *  standing in for a fact and which also silently dropped node's `npm run <script>` existence check
 *  and python's interpreter check. The special-case survives in exactly one place: a component whose
 *  `kind` the registry does not model AND which has a `prepare`. There we cannot know what the
 *  install provides, so the conservative rule is right — over-probing an unmodeled ecosystem would
 *  re-create the clean-checkout false-fail this function exists to prevent.
 *
 *  `cwd` is the component's module root (`targetRepo` + `dir`) so an `npm run <script>` probe reads
 *  the right `package.json`. Pure — no side effects. */
export function collectToolProbes(profile: Profile): ToolProbe[] {
  const probes: ToolProbe[] = [];
  for (const c of profile.components) {
    const cwd = join(profile.targetRepo, c.dir ?? "");
    if (c.prepare) probes.push({ component: c.name, label: "prepare", command: c.prepare, cwd });
    if (c.prepare && !isModeledKind(c.kind)) continue; // unmodeled + installs -> conservative
    const facts = stackFacts(c.kind);
    for (const label of ["build", "test", "check"] as const) {
      const command = commandFor(c, label);
      if (!command) continue;
      // The `c.prepare` gate is load-bearing: the registry says what an install WOULD provide, but
      // if this component has no install step then nothing will ever supply the tool — so it is a
      // precondition and must be probed. Ungated, a prepare-less python component (pythonPrepare
      // has a `return undefined` branch, python.ts:33) got ZERO probes.
      if (c.prepare !== undefined && isInstallProvided(command, facts)) continue;
      probes.push({ component: c.name, label, command, cwd });
    }
  }
  return probes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli/preflight.test.ts`
Expected: PASS, with the three pre-existing tests updated per Step 2.

- [ ] **Step 5: Run the wider CLI suite**

Run: `bun test test/cli/`
Expected: PASS. Note every changed assertion in the commit body.

- [ ] **Step 6: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/cli/preflight.ts test/cli/preflight.test.ts
git commit -m "fix(preflight): derive install-provided tools from the registry (ENG-344)

Replaces ENG-332's 'component has a prepare -> probe only prepare'
special-case, a workaround standing in for a fact, with the registry's
installBinDirs + installProvidedTools plus a kind-agnostic relative-path
rule, matched against each command's leading token.

The skip is gated on c.prepare !== undefined: the registry says what an
install WOULD provide, but a component with no install step will never have
one run, so its tools are preconditions and must be probed.

Restores two probes the blanket special-case dropped: node's npm-SCRIPT
existence check (NOT a missing-npm check — probeCommandExists
short-circuits on 'npm run' and never resolves npm on PATH), and the
interpreter in python's 'python -m pytest'.

Also covers composer's configurable bin-dir via the relative-path rule.

The special-case survives only for an unmodeled kind that also has a
prepare, where over-probing would re-create the clean-checkout false-fail.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 3: Document the registry and verify the branch

**Files:**
- Modify: `docs/architecture/conventions.md`

- [ ] **Step 1: Confirm the boundary holds**

```bash
grep -cE "^\s*(import|const .* = require)" src/dispatch/stack-registry.ts || true
```
Expected: `0`. The `|| true` matters — `grep -c` **exits 1 on a zero count**, so without it the success case reads as a failed step.

This grep is a convenience only. The real guarantee is Task 1's snapshot test: `grep` cannot see `Bun.file()`, `process.cwd()`, a dynamic `import()`, or a lazy getter.

- [ ] **Step 2: Document the extension point**

Append to `docs/architecture/conventions.md`:

```markdown
## The language stack registry

`src/dispatch/stack-registry.ts` holds **invariant** per-ecosystem facts keyed by component `kind`,
so a fact cannot be true in one module and false in another. It currently carries the install facts
the toolchain preflight reads (`installBinDirs`, `installProvidedTools`); the remaining scattered
tables — extensions, dependency manifests, install markers, interpreters, detect anchors, ignore
dirs — migrate in a follow-up, each field landing with the consumer that reads it.

**The boundary.** No functions, getters, or class instances. The guarantee is a checked-in literal
snapshot in `test/dispatch/stack-registry.test.ts`, plus structural assertions. It is deliberately
**not** the module's lack of imports: `Bun.file()`, `process.cwd()` and `globalThis` all reach the
filesystem with no import statement, so a source-text check cannot decide purity. The source
denylist that exists is a lint rule, not a proof.

**What does NOT go in it.** Anything conditional on a specific repo's contents: which package
manager it uses (lockfile scan), which test runner (tox/nox/pytest config scan), its python import
name (pyproject parse), which check framework its test command implies (a command sniff). Those stay
as detector logic. Adding a conditional here is the failure mode the registry exists to prevent.

**A known residual.** "Tool X is produced by the install step" is really a property of a component's
`prepare`, not of its ecosystem — `pythonPrepare` emits four different commands installing four
different things, and the table answers the same for all four. This is why `collectToolProbes` gates
its skip on `c.prepare !== undefined`. See the design doc §5.6.

**Adding a language:** add a `StackFacts` entry, add a `LangDef` under `src/setup/lang/`, register it
in `src/setup/registry.ts`, and regenerate the test snapshot.
```

- [ ] **Step 3: Full verification**

```bash
bun run format && bun run lint && bun run typecheck && bun test && bun run build
```
Expected: all green; build produces the binary.

- [ ] **Step 4: Commit and push**

```bash
git add docs/architecture/conventions.md
git commit -m "docs(architecture): document the language stack registry (ENG-344)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
git push
```

---

## Acceptance criteria trace

| Spec AC (§9) | Task |
|---|---|
| Registry exists, 9 kinds, total `stackFacts` | 1 |
| Preflight derives install-provided, gated on `c.prepare !== undefined` | 2 |
| ENG-332 special-case gone for every modeled kind | 2 |
| §5 boundary tests pass, incl. the literal snapshot and getter checks | 1 (proven to bite, Step 5) |
| `format` + `lint` + `typecheck` + `test` green | every task; final in 3 |

**Deferred to the follow-up** (`docs/plans/2026-07-22-eng-360-mechanical-fold.md`) with the spec ACs they carry: `EXTENSIONS_BY_KIND`/`SOURCE_EXTS` supersession, provision's markers/manifests/interpreters, `TARGETED_LANG_MANIFESTS`, `SKIP`/`SWEEP_SKIP_DIRS`, the `runtime-deps` mapping, and invariant RG-1's test (§6b) — RG-1 only becomes live once `extensions` enters the registry.

## Behavior changes to call out in the PR description

Only two ship here. The other four moved to the follow-up with their tasks.

1. **node components regain `npm run <script>` probes** — a profile-staleness check (script renamed since `styre setup`), *not* the missing-`npm` check ENG-332 §7 claimed; see spec §6.1's correction.
2. **`python -m pytest` now probes `python`** — on a machine with `pip` present but `python` absent, this converts a mid-run verify death into a clean exit 69 at second zero. Reviewers disagreed on how large that population is (stock Debian with `python3-pip` and no `python-is-python3`, versus "such a machine almost certainly already fails today's `pip` probe"). Flag it and let the operator judge.

Plus one strictly-better fix with no downside: a component of a modeled kind with **no** `prepare` now probes its build/test tools, which the ENG-332 special-case also skipped.
