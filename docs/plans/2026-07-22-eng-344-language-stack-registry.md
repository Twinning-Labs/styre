# Language Stack Registry Implementation Plan (ENG-344, PR 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-ecosystem facts re-encoded across ten tables in seven modules with one typed, code-consumed registry keyed by component `kind`, and derive the preflight's "precondition vs install-provided" decision from it — retiring the ENG-332 special-case.

**Architecture:** A single new module `src/dispatch/stack-registry.ts` that **imports nothing** — that import-freedom is the mechanically-checkable statement of the data-vs-logic boundary (a module that cannot reach `node:fs` cannot branch on repo state). It exports `STACKS: Record<string, StackFacts>` with an entry per kind, `GENERIC_IGNORE_DIRS`, and a total lookup `stackFacts(kind)`. Every existing per-ecosystem table is then either deleted and re-derived from it, or (where the table carries functions) reduced to a table of functions keyed by registry kinds with a test binding the two together. Conditional detector logic — package-manager choice, test-runner sniff, python import name — is untouched.

**Tech Stack:** TypeScript on Bun. Tests are `bun test` (`import { describe, expect, test } from "bun:test"`). Lint is `bun run lint` (Biome). Test files mirror src layout under `test/`.

**Spec:** `docs/brainstorms/2026-07-22-eng-344-language-stack-registry-design.md`. Read §3 (the type), §4 (consumer migration), §5 (boundary tests), §6 (behavior changes) before starting.

## Global Constraints

- **Never commit to `main`.** All work on `feat/eng-344-language-stack-registry`. No `gh pr merge`, ever.
- **The registry module must import nothing.** No `import` statement of any kind in `src/dispatch/stack-registry.ts`. Task 1's test enforces this; do not weaken it to make a later task easier — if a later task seems to need an import, the fact belongs in the consumer, not the registry.
- **No functions, getters, or class instances inside `STACKS`.** Strings, booleans, and readonly arrays of strings only.
- **Nine kinds, exactly:** `rust`, `node`, `sveltekit`, `python`, `go`, `jvm-maven`, `jvm-gradle`, `ruby`, `php`.
- **PR 1 does NOT touch `check-selector.ts` at all**, nor `check-rules.ts:349` (`CHECK_RULES`). Those are PR 2. The single exception in the whole checks subsystem is Task 4, which changes `SOURCE_EXTS` at `check-rules.ts:4` only. (An earlier draft had Task 6 edit `binaryFor` at `check-selector.ts:394`; three reviewers flagged it — it contradicted this constraint AND was a no-op, replacing the literal `"python3"` with an expression evaluating to `"python3"`, manufactured to give `interpreters` a second consumer. Removed.)
- **Do NOT add `checkFrameworks` or `testFilePattern` to `StackFacts`.** They are PR 2 fields; adding them here creates consumer-less speculative fields (spec §3.4).
- **Conditional detector logic is out of scope.** Do not modify `src/setup/lang/*.ts` in any task.
- **Every task ends green with `bun run format && bun run lint && bun run typecheck && bun test`** — all four. `bun run lint` is `biome check .` (no `--write`), and the repo enforces `lineWidth: 100` + `organizeImports`, so hand-wrapped pasted code FAILS lint unless formatted first. `bun run typecheck` (`tsc --noEmit --strict`) is what CI runs (`.github/workflows/ci.yml:18`); Biome does not type-check and `bun test` strips types, so a duplicate import or type slip commits green and explodes in CI 11 commits later.
- **Import placement and order.** Biome sorts specifiers naturally, so `"bun:test"` sorts BEFORE `"node:fs"`. Every existing test file follows this. Never add an import mid-file — merge into the existing import statement for that module instead.
- Commit messages: conventional-commit with a scope, e.g. `refactor(dispatch): …`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/dispatch/stack-registry.ts` | **create** | The sole source of invariant per-`kind` facts. Imports nothing. |
| `test/dispatch/stack-registry.test.ts` | **create** | The four boundary invariants (§5) + content assertions. |
| `src/cli/preflight.ts` | modify | Derives precondition-vs-install-provided from the registry. |
| `src/dispatch/components.ts` | modify | `EXTENSIONS_BY_KIND` deleted. |
| `src/setup/detect-components.ts` | modify | Reads extensions + detect anchors from the registry. |
| `src/dispatch/check-rules.ts` | modify | `SOURCE_EXTS` derived from registry extensions. |
| `src/dispatch/provision.ts` | modify | Markers, install dir, manifests, interpreters from the registry. |
| `src/setup/manifests.ts` | modify | `SKIP` derived from the registry. |
| `src/dispatch/worktree.ts` | modify | `SWEEP_SKIP_DIRS` derived from the registry. |
| `src/setup/runtime-deps/collect.ts` | modify | Rows keyed by registry kinds; parser map stays local. |
| `docs/architecture/conventions.md` | modify | Documents the registry as the extension point for a new language. |

---

### Task 1: The registry module

**Files:**
- Create: `src/dispatch/stack-registry.ts`
- Test: `test/dispatch/stack-registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface StackFacts`; `const STACKS: Readonly<Record<string, StackFacts>>`; `const GENERIC_IGNORE_DIRS: readonly string[]`; `function stackFacts(kind: string): StackFacts`; `function isModeledKind(kind: string): boolean`. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/stack-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSIONS_BY_KIND } from "../../src/dispatch/components.ts";
import {
  GENERIC_IGNORE_DIRS,
  STACKS,
  isModeledKind,
  stackFacts,
} from "../../src/dispatch/stack-registry.ts";
import { REGISTRY } from "../../src/setup/registry.ts";
import { SKIP } from "../../src/setup/manifests.ts";

const KINDS = [
  "rust", "node", "sveltekit", "python", "go",
  "jvm-maven", "jvm-gradle", "ruby", "php",
] as const;

describe("boundary: the registry is data, not logic", () => {
  // §5.1 — no functions AND no getters AND a plain prototype.
  // getOwnPropertyDescriptors does NOT invoke accessors; Object.entries DOES,
  // which is how an earlier draft's walk was blind to
  //   get extensions() { return Bun.file(`${process.cwd()}/go.work`).size > 0 ? A : B; }
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

  // §5.2 — THE load-bearing assertion. Purity is not decidable from source
  // text (Bun.*, process.*, globalThis all reach the filesystem with no
  // import), so pin the whole table to a literal instead: a repo-state-
  // dependent registry would have to produce this byte-for-byte from every
  // working directory, and any deliberate fact change must be made twice,
  // in a diff a reviewer sees.
  test("STACKS equals its checked-in snapshot", () => {
    expect(STACKS).toEqual(SNAPSHOT); // SNAPSHOT defined at the bottom of this file
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

  // §5.4 — shared facts must not be mutable by a consumer.
  test("STACKS and its entries are frozen", () => {
    expect(Object.isFrozen(STACKS)).toBe(true);
    for (const kind of KINDS) {
      expect(Object.isFrozen(STACKS[kind])).toBe(true);
      expect(Object.isFrozen(STACKS[kind].extensions)).toBe(true);
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
    expect(f.extensions).toEqual([]);
    expect(f.installBinDirs).toEqual([]);
    expect(f.installProvidedTools).toEqual([]);
    expect(f.installMarkers).toEqual([]);
    expect(f.installOutputDir).toBeUndefined();
    expect(f.manifests).toEqual([]);
    expect(f.interpreters).toEqual([]);
  });
});

describe("the ENG-332 facts", () => {
  test("php's test tool is install-provided via vendor/bin", () => {
    expect(stackFacts("php").installBinDirs).toContain("vendor/bin");
    expect(stackFacts("php").installProvidedTools).toEqual(["phpunit", "pest"]);
  });

  test("python's runners are install-provided by name", () => {
    expect(stackFacts("python").installProvidedTools).toEqual(["pytest", "tox", "nox"]);
  });

  test("node's package managers are preconditions, NOT install-provided", () => {
    // npm/pnpm/yarn must be on PATH before provision can run at all.
    expect(stackFacts("node").installProvidedTools).toEqual([]);
    expect(stackFacts("node").installBinDirs).toEqual(["node_modules/.bin"]);
  });

  test("go/jvm/rust have no install step, so nothing is install-provided", () => {
    for (const k of ["go", "rust", "jvm-maven", "jvm-gradle"]) {
      expect(stackFacts(k).installProvidedTools).toEqual([]);
      expect(stackFacts(k).installBinDirs).toEqual([]);
      expect(stackFacts(k).installMarkers).toEqual([]);
    }
  });
});

describe("facts migrated from existing tables", () => {
  // DIFFERENTIAL, not transcribed. At Task 1 time every source table still
  // exists and is importable, so compare against the LIVE table — a
  // hand-copied literal passes even if the same transcription error was made
  // in both places. Delete each of these in the task that deletes its table.
  test("extensions match today's live EXTENSIONS_BY_KIND exactly", () => {
    for (const [kind, exts] of Object.entries(EXTENSIONS_BY_KIND)) {
      expect(stackFacts(kind).extensions).toEqual([...exts]);
    }
    expect(Object.keys(EXTENSIONS_BY_KIND).sort()).toEqual([...KINDS].sort());
  });

  test("node install markers and manifests match provision's tables", () => {
    expect(stackFacts("node").installMarkers).toEqual([
      ".package-lock.json", ".yarn-state.yml", ".modules.yaml",
    ]);
    expect(stackFacts("node").installOutputDir).toBe("node_modules");
    expect(stackFacts("node").manifests).toEqual([
      "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    ]);
  });

  // NOT `toEqual(stackFacts("node").x)` — the ...NODE_INSTALL spread shares the
  // same array OBJECTS, so that would compare an array to itself and can never fail.
  test("sveltekit install facts are pinned independently of node's", () => {
    expect(stackFacts("sveltekit").installMarkers).toEqual([
      ".package-lock.json", ".yarn-state.yml", ".modules.yaml",
    ]);
    expect(stackFacts("sveltekit").installOutputDir).toBe("node_modules");
    expect(stackFacts("sveltekit").manifests).toEqual([
      "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    ]);
  });

  test("python's interpreter fallback order is python3 then python", () => {
    expect(stackFacts("python").interpreters).toEqual(["python3", "python"]);
  });

  test("python's requirements*.txt is a pattern, not a basename", () => {
    expect(stackFacts("python").manifestPatterns).toEqual(["^requirements.*\\.txt$"]);
    const re = new RegExp(stackFacts("python").manifestPatterns[0]);
    expect(re.test("requirements.txt")).toBe(true);
    expect(re.test("requirements-dev.txt")).toBe(true);
    expect(re.test("norequirements.txt")).toBe(false);
  });

  test("the ignore-dir union EQUALS today's live SKIP set", () => {
    // Set equality, NOT superset: SKIP prunes the manifest walk, so extra
    // entries would silently find FEWER components (spec §6.5). Compared
    // against the live SKIP, not a transcription of it.
    const derived = new Set([
      ...GENERIC_IGNORE_DIRS,
      ...Object.values(STACKS).flatMap((f) => [...f.ignoreDirs]),
    ]);
    expect([...derived].sort()).toEqual([...SKIP].sort());
  });

  test("detect anchors match the detectors' trigger manifests", () => {
    expect(stackFacts("jvm-maven").detectAnchors).toEqual(["pom.xml"]);
    expect(stackFacts("jvm-gradle").detectAnchors).toEqual(["build.gradle", "build.gradle.kts"]);
    expect(stackFacts("ruby").detectAnchors).toEqual(["Gemfile"]);
    expect(stackFacts("php").detectAnchors).toEqual(["composer.json"]);
    expect(stackFacts("python").detectAnchors).toEqual([
      "pyproject.toml", "setup.py", "requirements.txt",
    ]);
  });

  test("every dependency manifest today's MANIFEST_BASENAMES knows is still covered", () => {
    const all = new Set(Object.values(STACKS).flatMap((f) => [...f.manifests]));
    for (const m of [
      "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
      "pyproject.toml", "setup.py", "setup.cfg", "poetry.lock", "Pipfile", "Pipfile.lock",
    ]) {
      expect(all.has(m)).toBe(true);
    }
  });

  test("the manifest union closes the Gemfile/composer.json re-arm gap", () => {
    const all = new Set(Object.values(STACKS).flatMap((f) => [...f.manifests]));
    expect(all.has("Gemfile")).toBe(true);
    expect(all.has("composer.json")).toBe(true);
  });
});
```

**`SNAPSHOT`**: after Step 3 compiles, append to the test file a `const SNAPSHOT = { ... }` that is the full literal of all nine entries. Produce it mechanically — `bun -e 'console.log(JSON.stringify((await import("./src/dispatch/stack-registry.ts")).STACKS, null, 2))'` — and paste the result. Hand-typing it would defeat the point.

**Import order:** `bun:test` sorts BEFORE `node:fs`/`node:path` under Biome's natural sort. Put it first, matching `test/cli/preflight.test.ts:1` and every other test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/stack-registry.ts'`.

- [ ] **Step 3: Write the registry**

Create `src/dispatch/stack-registry.ts`. Note the file has **no import statements** — that is enforced by the test above.

```ts
/** THE single source of invariant, per-ecosystem facts, keyed by component `kind` (ENG-344).
 *
 *  Why this module exists: before it, the same ecosystem fact was re-encoded in up to four places
 *  and they drifted — `SOURCE_EXTS` disagreed with `EXTENSIONS_BY_KIND`, and `MANIFEST_BASENAMES`
 *  omitted `Gemfile`/`composer.json` so a mid-run dependency edit never re-armed provision. The
 *  motivating bug is ENG-332's: `php.ts` emits `test: "./vendor/bin/phpunit"` with
 *  `prepare: "composer install"`, so the test tool is PRODUCED BY the install step and absent on a
 *  clean checkout — a fact that lived nowhere explicit and made the preflight false-fail.
 *
 *  THE BOUNDARY (enforced by test/dispatch/stack-registry.test.ts):
 *  - This module imports NOTHING. A module that cannot reach `node:fs` cannot branch on repo state,
 *    which is how "the registry holds no repo-specific logic" becomes a checkable assertion rather
 *    than a comment. Do not add an import to make a consumer's life easier.
 *  - No functions, getters, or class instances in `STACKS`. Strings, booleans, and readonly string
 *    arrays only. Anything that needs to *decide* something belongs in the consumer.
 *
 *  WHAT DOES NOT BELONG HERE: which package manager THIS repo uses (lockfile scan), which test
 *  runner it uses (tox/nox/pytest config scan), its python import name (pyproject parse), and which
 *  check framework a component's command implies (a command sniff). Those are conditional on repo
 *  contents; they stay as detector logic in `src/setup/lang/*.ts` and `src/dispatch/check-*.ts`.
 *
 *  Adding a language: add an entry here, add a `LangDef` in `src/setup/lang/`, register it in
 *  `src/setup/registry.ts`. Nothing else should need a new `kind` branch. */
export interface StackFacts {
  // ─── routing ───
  /** File extensions owned by this kind. Empty ⇒ path-only routing (custom/unknown kinds). */
  readonly extensions: readonly string[];

  // ─── detection ───
  /** Manifests whose presence at a path means "a component of this kind lives here". */
  readonly detectAnchors: readonly string[];
  /** Vendored/build-output dirs belonging to this ecosystem — skipped when walking a repo. */
  readonly ignoreDirs: readonly string[];

  // ─── dependency manifests ───
  /** Basenames whose change means the dependency set may have changed (re-arms provision), and
   *  whose mtime is compared against `installMarkers` to detect a stale install. */
  readonly manifests: readonly string[];
  /** RegExp SOURCE strings for manifests a fixed basename can't express (python's
   *  `requirements*.txt` — pip's convention allows an arbitrary suffix). */
  readonly manifestPatterns: readonly string[];

  // ─── install step ───
  /** Dir the install writes into, relative to the component root. Undefined ⇒ no install output. */
  readonly installOutputDir?: string;
  /** Dirs, relative to the component root, where the install drops executables. A command whose
   *  leading token sits under one of these is install-provided, so the preflight must not probe it
   *  before provision runs (the ENG-332 bug). */
  readonly installBinDirs: readonly string[];
  /** BARE tool names the install step puts on PATH — indistinguishable syntactically from a
   *  precondition, which is exactly why they must be data. `pip`/`npm`/`bundle`/`composer` are NOT
   *  here: they must already exist for the install itself to run. */
  readonly installProvidedTools: readonly string[];
  /** Files under `installOutputDir` whose presence + mtime prove the install completed. Empty ⇒ no
   *  readiness cache, so provision re-installs every time (correct for python: the post-install
   *  source check is the real guarantee). */
  readonly installMarkers: readonly string[];

  // ─── runtime ───
  /** Interpreter candidates in fallback order — first one present on PATH wins. */
  readonly interpreters: readonly string[];
}

const NODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"] as const;
const JVM_EXTS = [".java", ".kt", ".kts", ".scala", ".groovy"] as const;

/** Node and sveltekit share every install fact — sveltekit differs only by owning `.svelte`. */
const NODE_INSTALL = {
  detectAnchors: ["package.json"],
  manifests: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  manifestPatterns: [],
  installOutputDir: "node_modules",
  installBinDirs: ["node_modules/.bin"],
  // npm/pnpm/yarn are PRECONDITIONS — they must exist before `prepare` can run.
  installProvidedTools: [],
  // Per-manager completeness markers: npm/yarn/pnpm each write a different one.
  installMarkers: [".package-lock.json", ".yarn-state.yml", ".modules.yaml"],
  interpreters: ["node"],
} as const;

/** Dirs that belong to no single ecosystem: VCS metadata, a generic build output name, and the
 *  CocoaPods dir (iOS — not a modeled kind, retained so the walk behavior is unchanged). */
export const GENERIC_IGNORE_DIRS: readonly string[] = Object.freeze([".git", "dist", "Pods"]);

const RAW: Record<string, StackFacts> = {
  rust: {
    extensions: [".rs"],
    detectAnchors: ["Cargo.toml"],
    ignoreDirs: ["target"],
    manifests: ["Cargo.toml", "Cargo.lock"],
    manifestPatterns: [],
    installBinDirs: [],
    installProvidedTools: [],
    installMarkers: [],
    interpreters: [],
  },
  node: {
    extensions: [...NODE_EXTS],
    ignoreDirs: ["node_modules", ".svelte-kit"],
    ...NODE_INSTALL,
  },
  sveltekit: {
    extensions: [...NODE_EXTS, ".svelte"],
    ignoreDirs: ["node_modules", ".svelte-kit"],
    ...NODE_INSTALL,
  },
  python: {
    extensions: [".py", ".pyi"],
    detectAnchors: ["pyproject.toml", "setup.py", "requirements.txt"],
    ignoreDirs: [".venv", "venv", "__pycache__", ".tox", ".nox"],
    manifests: ["pyproject.toml", "setup.py", "setup.cfg", "poetry.lock", "Pipfile", "Pipfile.lock"],
    manifestPatterns: ["^requirements.*\\.txt$"],
    // pip installs into the active env's site-packages, not a component-relative dir, so there is
    // no `installOutputDir` and no readiness marker — provision re-installs and verifies via the
    // post-install worktree-source check instead.
    installBinDirs: [],
    installProvidedTools: ["pytest", "tox", "nox"],
    installMarkers: [],
    interpreters: ["python3", "python"],
  },
  go: {
    extensions: [".go"],
    detectAnchors: ["go.mod"],
    // `testdata/` is ignored by the go tool itself — walking it would find non-module manifests.
    ignoreDirs: ["testdata"],
    manifests: ["go.mod", "go.sum"],
    manifestPatterns: [],
    installBinDirs: [],
    installProvidedTools: [],
    installMarkers: [],
    interpreters: [],
  },
  "jvm-maven": {
    extensions: [...JVM_EXTS],
    detectAnchors: ["pom.xml"],
    ignoreDirs: ["target", ".mvn"],
    manifests: ["pom.xml"],
    manifestPatterns: [],
    installBinDirs: [],
    installProvidedTools: [],
    installMarkers: [],
    interpreters: [],
  },
  "jvm-gradle": {
    extensions: [...JVM_EXTS, ".gradle"],
    detectAnchors: ["build.gradle", "build.gradle.kts"],
    ignoreDirs: [".gradle", "build"],
    manifests: ["build.gradle", "build.gradle.kts", "libs.versions.toml"],
    manifestPatterns: [],
    installBinDirs: [],
    installProvidedTools: [],
    installMarkers: [],
    interpreters: [],
  },
  ruby: {
    extensions: [".rb", ".rake", ".gemspec"],
    detectAnchors: ["Gemfile"],
    ignoreDirs: ["vendor"],
    manifests: ["Gemfile", "Gemfile.lock"],
    manifestPatterns: [],
    // `bundle` is a PRECONDITION (ships with ruby); `bundle exec rspec` therefore probes correctly.
    installBinDirs: [],
    installProvidedTools: [],
    installMarkers: [],
    interpreters: ["ruby"],
  },
  php: {
    extensions: [".php"],
    detectAnchors: ["composer.json"],
    ignoreDirs: ["vendor"],
    manifests: ["composer.json", "composer.lock"],
    manifestPatterns: [],
    installOutputDir: "vendor",
    // THE ENG-332 FACT: `./vendor/bin/phpunit` does not exist until `composer install` has run.
    installBinDirs: ["vendor/bin"],
    installProvidedTools: ["phpunit", "pest"],
    installMarkers: [],
    interpreters: ["php"],
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

/** The conservative facts for a kind the registry does not model. `kind` is an unconstrained
 *  `z.string()` in `ComponentSchema`, so a config-override or hand-edited profile may carry one.
 *  Empty everything reproduces today's unknown-kind behavior (path-only routing, no readiness
 *  cache); callers that must not over-probe an unmodeled ecosystem use `isModeledKind`. */
const UNMODELED: StackFacts = deepFreeze({
  extensions: [],
  detectAnchors: [],
  ignoreDirs: [],
  manifests: [],
  manifestPatterns: [],
  installBinDirs: [],
  installProvidedTools: [],
  installMarkers: [],
  interpreters: [],
});

/** Total lookup — never throws, never returns undefined. */
export function stackFacts(kind: string): StackFacts {
  return STACKS[kind] ?? UNMODELED;
}

/** True iff the registry has real facts for this kind. Consumers that would otherwise draw a
 *  confident conclusion from `UNMODELED`'s empties (e.g. "nothing is install-provided, so probe
 *  everything") must gate on this. */
export function isModeledKind(kind: string): boolean {
  return Object.hasOwn(STACKS, kind);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: PASS, all tests green. If "the ignore-dir union EQUALS today's SKIP set" fails, the diff names the offending dir — fix the entry, do NOT relax the assertion to a superset check.

- [ ] **Step 5: Verify the exhaustiveness link to the detector registry**

`REGISTRY` is already imported at the top from Step 1. Append at the end of the file:

```ts
test("every kind the detector registry emits has stack facts (§5.3)", () => {
  for (const def of REGISTRY) expect(isModeledKind(def.kind)).toBe(true);
});
```

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: PASS. (`LangDef.kind` was previously unused by the engine — this is its first consumer. `sveltekit` is computed inside `node.ts`, not a `LangDef.kind`, so it is covered by the "nine kinds" test instead.)

- [ ] **Step 6: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/stack-registry.ts test/dispatch/stack-registry.test.ts
git commit -m "feat(dispatch): add the language stack registry (ENG-344)

One typed, code-consumed table of invariant per-ecosystem facts keyed by
component kind. Imports nothing — that is the mechanically-checkable
statement of the data-vs-logic boundary, since a module that cannot reach
node:fs cannot branch on repo state.

No consumers yet; each existing table is migrated in a following commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 2: Preflight derives precondition-vs-install-provided (the headline)

Retires the ENG-332 special-case. This is AC 2 and the reason the ticket exists.

**Files:**
- Modify: `src/cli/preflight.ts:14-40`
- Test: `test/cli/preflight.test.ts`

**Interfaces:**
- Consumes: `stackFacts`, `isModeledKind`, `StackFacts` from Task 1.
- Produces: `isInstallProvided(command: string, facts: StackFacts): boolean` (exported for test). `collectToolProbes(profile: Profile): ToolProbe[]` keeps its existing signature and `ToolProbe` shape.

- [ ] **Step 1: Write the failing test**

Add to `test/cli/preflight.test.ts`. **Reuse the file's existing `makeProfile` helper at `test/cli/preflight.test.ts:21-23`** — it routes through `parseProfile`, so fixtures are schema-validated. Do NOT redefine a local `profileWith` that casts `as unknown as Profile`; that bypasses validation and lets an invalid `runtimeContext: {}` pass silently. Merge any new imports into the file's existing import statements (`describe/expect/test`, `collectToolProbes` and `type Profile` are already imported at lines 1, 9, 14) — only `isInstallProvided` and `stackFacts` are new.

```ts
import { describe, expect, test } from "bun:test";
import { collectToolProbes, isInstallProvided } from "../../src/cli/preflight.ts";
import type { Profile } from "../../src/dispatch/profile.ts";
import { stackFacts } from "../../src/dispatch/stack-registry.ts";

function profileWith(components: Profile["components"]): Profile {
  return {
    schemaVersion: 3,
    slug: "t",
    targetRepo: "/repo",
    defaultBranch: "main",
    checksSystem: "none",
    components,
    repoCommands: {},
    promptVars: {},
    runtimeContext: {},
  } as unknown as Profile;
}

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

  test("a vendor-bin prefix must be a real path segment, not a substring", () => {
    expect(isInstallProvided("vendor/binary-thing", stackFacts("php"))).toBe(false);
  });
});

describe("collectToolProbes — the ENG-332 clean-checkout guarantee", () => {
  test("php probes composer but NOT ./vendor/bin/phpunit", () => {
    const probes = collectToolProbes(
      profileWith([
        { ...base, name: "php", kind: "php",
          commands: { test: "./vendor/bin/phpunit" }, prepare: "composer install" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["composer install"]);
  });

  test("python probes pip but NOT tox", () => {
    const probes = collectToolProbes(
      profileWith([
        { ...base, name: "python", kind: "python",
          commands: { test: "tox" }, prepare: "pip install tox" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["pip install tox"]);
  });
});

describe("collectToolProbes — coverage the special-case dropped (spec §6.1, §6.2)", () => {
  test("node probes its npm scripts as well as its prepare", () => {
    // ENG-332 design §7 wanted exactly this: a node repo whose prepare is pnpm
    // must still have `npm run …` probed, because that is what verify executes.
    const probes = collectToolProbes(
      profileWith([
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
      profileWith([
        { ...base, name: "python", kind: "python",
          commands: { test: "python -m pytest" }, prepare: "pip install -e ." },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["pip install -e .", "python -m pytest"]);
  });

  test("ruby probes bundle exec rspec — bundle is a precondition", () => {
    const probes = collectToolProbes(
      profileWith([
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
      profileWith([
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
      profileWith([
        { ...base, name: "ruby", kind: "ruby",
          commands: { test: { unavailable: true } }, prepare: "bundle install" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["bundle install"]);
  });

  test("cwd is the component module root", () => {
    const probes = collectToolProbes(
      profileWith([
        { ...base, name: "api", kind: "go", dir: "services/api",
          commands: { test: "go test ./..." } },
      ]),
    );
    expect(probes[0].cwd).toBe("/repo/services/api");
  });
});

describe("collectToolProbes — the unmodeled-kind fallback (spec §6.6)", () => {
  test("an unmodeled prepare-bearing kind probes ONLY its prepare", () => {
    // We cannot know which of an un-modeled ecosystem's tools its install provides,
    // so probing build/test would risk re-introducing the ENG-332 false-fail.
    const probes = collectToolProbes(
      profileWith([
        { ...base, name: "elixir", kind: "elixir",
          commands: { test: "mix test" }, prepare: "mix deps.get" },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["mix deps.get"]);
  });

  test("an unmodeled kind with NO prepare still probes build/test", () => {
    const probes = collectToolProbes(
      profileWith([
        { ...base, name: "elixir", kind: "elixir", commands: { test: "mix test" } },
      ]),
    );
    expect(probes.map((p) => p.command)).toEqual(["mix test"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/preflight.test.ts`
Expected: FAIL — `isInstallProvided` is not exported, and the new "restored coverage" tests fail.

**After Step 3, THREE PRE-EXISTING tests in this same file will also fail.** Two reviewers reproduced this. They are not regressions; they encode the ENG-332 semantics this task deletes. Update each — do NOT weaken `collectToolProbes` to preserve them:

| Test | Why it breaks | New expectation |
|---|---|---|
| `preflight.test.ts:30` | php fixture's `build: "composer build"` — `composer` is neither under `vendor/bin` nor in the tools list, so it is now probed | add the `{component:"api",label:"build",command:"composer build"}` probe |
| `preflight.test.ts:90` | node fixture gains `web/build` + `web/test` npm-script probes (intended, §6.1) | add both entries |
| `preflight.test.ts:115` `"a prepare-provided test tool is NOT probed (php clean checkout)"` | its `build: "true"` is now probed and `fakeProbe(["composer"])` lacks `true` | give the fixture no `build` slot, so the test still isolates the `./vendor/bin/phpunit` skip it exists to check |

`test/cli/run-preflight.test.ts` is **unaffected** (`kind:"custom"`, no `prepare`).

- [ ] **Step 3: Rewrite `collectToolProbes`**

In `src/cli/preflight.ts`, add the imports and replace lines 14-40 (the doc comment and function body):

```ts
import { join } from "node:path";
import { commandFor } from "../dispatch/components.ts";
import type { Profile } from "../dispatch/profile.ts";
import { type StackFacts, isModeledKind, stackFacts } from "../dispatch/stack-registry.ts";
import { probeCommandExists } from "../setup/discover-schema.ts";

/** True iff `command`'s leading program is PRODUCED BY the ecosystem's install step, and so is
 *  absent on a clean checkout by construction. Two shapes, both registry facts:
 *   - it sits under an install bin dir  — php's `./vendor/bin/phpunit`;
 *   - it is a bare tool the install puts on PATH — python's `tox`/`nox`/`pytest`.
 *
 *  Everything else is a genuine precondition, including package managers (`npm`, `pip`, `bundle`,
 *  `composer` — they must exist for the install itself to run) and interpreters (`python` in
 *  `python -m pytest` — pytest is merely its argument). Probing an install-provided tool before
 *  provision runs is the ENG-332 bug; NOT probing a precondition is lost coverage. */
export function isInstallProvided(command: string, facts: StackFacts): boolean {
  const token = (command.trim().split(/\s+/)[0] ?? "").replace(/^\.\//, "");
  // Kind-agnostic: any relative path is build/install output. Covers composer's configurable
  // bin-dir ("config": {"bin-dir": "bin"} → `bin/phpunit`), ./mvnw, ./gradlew, and every
  // unmodeled ecosystem's ./deps/bin/x with no registry entry at all.
  if (token.includes("/")) return true;
  if (facts.installBinDirs.some((d) => token.startsWith(`${d}/`))) return true;
  return facts.installProvidedTools.includes(token);
}

/** Enumerate every command whose leading program the run must be able to invoke. A component's
 *  `prepare` is always a precondition (provision cannot install its own installer). Its
 *  `build`/`test`/`check` tools are probed UNLESS the registry says the install step provides them
 *  — which replaces ENG-332's blanket "has a prepare → probe only prepare" special-case. That
 *  special-case was a workaround standing in for a fact; it also silently dropped node's
 *  `npm run <script>` existence check and python's interpreter check, both restored here.
 *
 *  It survives in exactly one place: a component whose `kind` the registry does not model AND which
 *  has a `prepare`. There we cannot know which tools the install provides, so the conservative rule
 *  is right — over-probing an unmodeled ecosystem would re-create the very clean-checkout
 *  false-fail this function exists to prevent.
 *
 *  `cwd` is the component's module root (`targetRepo` + `dir`) so an `npm run <script>` probe reads
 *  the right `package.json`. Pure — no side effects. */
export function collectToolProbes(profile: Profile): ToolProbe[] {
  const probes: ToolProbe[] = [];
  for (const c of profile.components) {
    const cwd = join(profile.targetRepo, c.dir ?? "");
    if (c.prepare) probes.push({ component: c.name, label: "prepare", command: c.prepare, cwd });
    if (c.prepare && !isModeledKind(c.kind)) continue; // unmodeled + installs → conservative
    const facts = stackFacts(c.kind);
    for (const label of ["build", "test", "check"] as const) {
      const command = commandFor(c, label);
      if (!command) continue;
      // The `c.prepare` gate is load-bearing: the registry says what an install WOULD provide,
      // but if this component has no install step, nothing will ever supply the tool — so it is
      // a precondition and must be probed. Without the gate a prepare-less python component
      // (pythonPrepare has a `return undefined` branch) gets ZERO probes.
      if (c.prepare !== undefined && isInstallProvided(command, facts)) continue;
      probes.push({ component: c.name, label, command, cwd });
    }
  }
  return probes;
}
```

Leave the `ToolProbe` interface (lines 6-12), `MissingCommand`, `missingHint`, `preflightToolchain`, and `formatMissingTools` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli/preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the wider preflight suite for regressions**

Run: `bun test test/cli/`
Expected: PASS, with the three Step-2 tests updated. Note every changed assertion in the commit body.

- [ ] **Step 6: Lint and commit**

```bash
bun run lint && bun test
git add src/cli/preflight.ts test/cli/
git commit -m "fix(preflight): derive install-provided tools from the registry (ENG-344)

Replaces ENG-332's 'component has a prepare -> probe only prepare'
special-case, which was a workaround standing in for a fact, with the
registry's installBinDirs + installProvidedTools matched against each
command's leading token.

Restores two probes the blanket special-case silently dropped:
- node's 'npm run <script>' existence check, including the case the
  ENG-332 design §7 explicitly wanted (node repo whose prepare is pnpm);
- the interpreter in python's 'python -m pytest'.

The special-case survives only for a kind the registry does not model that
also has a prepare, where over-probing would re-create the clean-checkout
false-fail.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 3: Fold `EXTENSIONS_BY_KIND` into the registry

**Files:**
- Modify: `src/dispatch/components.ts:4-20` (delete), `src/setup/detect-components.ts:3,13,28`
- Test: `test/dispatch/components.test.ts:59-66,177-180,200-201`

**Interfaces:**
- Consumes: `stackFacts` from Task 1.
- Produces: `EXTENSIONS_BY_KIND` no longer exists. `Component.extensions` is still materialized by `runRegistry` and its shape is unchanged.

- [ ] **Step 1: Write the failing test**

In `test/dispatch/components.test.ts`, replace the `EXTENSIONS_BY_KIND` import with `stackFacts` and re-point its assertions. Add this routing-invariance test:

```ts
import { stackFacts } from "../../src/dispatch/stack-registry.ts";

test("routing is unchanged: extensions still come from the kind", () => {
  const c = {
    name: "fe", kind: "sveltekit", paths: ["**"], commands: {},
    extensions: [...stackFacts("sveltekit").extensions],
  };
  expect(matchesComponent(c, "src/App.svelte")).toBe(true);
  expect(matchesComponent(c, "src/main.ts")).toBe(true);
  expect(matchesComponent(c, "src/lib.rs")).toBe(false);
});

test("an unmodeled kind gets empty extensions -> path-only routing", () => {
  const c = { name: "x", kind: "elixir", paths: ["**"], commands: { }, extensions: [] };
  expect(matchesComponent(c, "lib/x.ex")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/components.test.ts`
Expected: FAIL — the old `EXTENSIONS_BY_KIND` import still resolves, so the file compiles but the new tests reference nothing broken yet. If both new tests pass immediately, that is fine — they are regression guards; proceed to Step 3, where deleting the export must keep them green.

- [ ] **Step 3: Delete the table and re-point its consumer**

In `src/dispatch/components.ts`, delete lines 4-20 (`NODE_EXTS`, `JVM_EXTS`, the `EXTENSIONS_BY_KIND` doc comment and object). Leave `DOCS_EXTS` and everything below it untouched.

In `src/setup/detect-components.ts`:

```ts
// line 3 — replace the EXTENSIONS_BY_KIND import
import { stackFacts } from "../dispatch/stack-registry.ts";
```

```ts
/** Engine: run every def, enforce Invariant 1 (command backstop, loud) + Invariant 2 (path backstop).
 *  Attaches `extensions` from the stack registry for the detected `kind` (file-identity routing);
 *  an unmodeled kind gets `[]` → path-only routing. */
```

```ts
      // line 28
      out.push({ ...c, paths, extensions: [...stackFacts(c.kind).extensions] });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/components.test.ts test/setup/detect-components.test.ts test/setup/engine.test.ts`
Expected: PASS. A failure naming `EXTENSIONS_BY_KIND` means another importer exists — find it with `grep -rn "EXTENSIONS_BY_KIND" src/ test/` and re-point it to `stackFacts`.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/components.ts src/setup/detect-components.ts test/dispatch/components.test.ts
git commit -m "refactor(dispatch): fold EXTENSIONS_BY_KIND into the stack registry (ENG-344)

The registry supersedes the table; routing behavior is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 4: Derive `SOURCE_EXTS` from the registry

Closes the live drift: `SOURCE_EXTS` is missing `.svelte`, `.gradle`, `.groovy`, `.cts`, `.mts` today.

**Files:**
- Modify: `src/dispatch/check-rules.ts:1-20`
- Test: `test/dispatch/check-rules.test.ts` (create the describe block if the file lacks one; if the file does not exist, create it)

**Interfaces:**
- Consumes: `STACKS` from Task 1.
- Produces: no export change — `SOURCE_EXTS` stays module-private; `moduleLeaf` keeps its signature.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { moduleLeaf } from "../../src/dispatch/check-rules.ts";

describe("moduleLeaf strips every registry-known source extension", () => {
  test("extensions it already handled", () => {
    expect(moduleLeaf("checks/helper.py")).toBe("helper");
    expect(moduleLeaf("./a/helper.js")).toBe("helper");
    expect(moduleLeaf("src/main.rs")).toBe("main");
    expect(moduleLeaf("pkg.helper")).toBe("helper");
    expect(moduleLeaf("util")).toBe("util");
  });

  // EIGHT extensions, not five. kts/rake/gemspec were omitted from an earlier
  // draft and caught independently by two reviewers.
  test("extensions the SOURCE_EXTS drift was missing (spec §6.4)", () => {
    expect(moduleLeaf("src/Button.svelte")).toBe("button");
    expect(moduleLeaf("build.gradle")).toBe("build");
    expect(moduleLeaf("Foo.groovy")).toBe("foo");
    expect(moduleLeaf("a/b.cts")).toBe("b");
    expect(moduleLeaf("a/b.mts")).toBe("b");
    expect(moduleLeaf("build.gradle.kts")).toBe("gradle");
    expect(moduleLeaf("tasks.rake")).toBe("tasks");
    expect(moduleLeaf("styre.gemspec")).toBe("styre");
  });

  test("a non-source extension is still kept as the leaf", () => {
    expect(moduleLeaf("config.yaml")).toBe("yaml");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/check-rules.test.ts`
Expected: FAIL — `expected "button", got "svelte"` (and similarly for `.gradle`, `.groovy`, `.cts`, `.mts`), because those extensions are absent from today's `SOURCE_EXTS`.

- [ ] **Step 3: Derive the set**

In `src/dispatch/check-rules.ts`, replace lines 1-20:

```ts
import type { CheckFramework } from "./check-selector.ts";
import { STACKS } from "./stack-registry.ts";

/** Source-file extensions stripped when reducing a path or module reference to its leaf name.
 *  Derived from the stack registry (dot-less, since `moduleLeaf` splits on ".") so it can never
 *  again drift from `Component.extensions` — before ENG-344 this was a hand-maintained set missing
 *  `.svelte`, `.gradle`, `.groovy`, `.cts` and `.mts`. */
const SOURCE_EXTS = new Set(
  Object.values(STACKS).flatMap((f) => f.extensions.map((e) => e.replace(/^\./, ""))),
);
```

Leave `moduleLeaf` and everything below unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/check-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Check for downstream check-matching regressions**

Run: `bun test test/dispatch/`
Expected: PASS. If a check-matching test now fails on a `.svelte` or `.gradle` path, that is the drift being corrected — update the expectation and record it in the commit body. Do NOT re-add a hand-maintained exclusion.

- [ ] **Step 6: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/check-rules.ts test/dispatch/check-rules.test.ts
git commit -m "fix(checks): derive SOURCE_EXTS from the stack registry (ENG-344)

SOURCE_EXTS and EXTENSIONS_BY_KIND answered the same question and had
already drifted: SOURCE_EXTS was missing .svelte, .gradle, .groovy, .cts
and .mts, so moduleLeaf reduced 'Button.svelte' to 'svelte' instead of
'button'. Deriving it from the registry makes the drift unrepresentable.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 5: `isComponentReady` reads markers from the registry

**Files:**
- Modify: `src/dispatch/provision.ts:14-50`
- Test: `test/dispatch/provision.test.ts`

**Interfaces:**
- Consumes: `stackFacts` from Task 1.
- Produces: `isComponentReady(kind: string, compAbsDir: string): boolean` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/provision.test.ts`, reusing the file's existing `mkdtempSync`/`roots[]`/`afterAll` fixture convention:

```ts
test("readiness generalizes by marker presence, not a node/sveltekit kind check", () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-ready-"));
  roots.push(dir);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");

  expect(isComponentReady("node", dir)).toBe(true);
  expect(isComponentReady("sveltekit", dir)).toBe(true);
  // Kinds with no install markers are never "ready" — they always re-install.
  expect(isComponentReady("python", dir)).toBe(false);
  expect(isComponentReady("php", dir)).toBe(false);
  expect(isComponentReady("go", dir)).toBe(false);
  expect(isComponentReady("elixir", dir)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/provision.test.ts`
Expected: PASS at this point — today's kind check happens to give the same answers. That is the point: this test pins the behavior BEFORE the refactor so Step 3 cannot silently change it. Proceed.

- [ ] **Step 3: Rewrite using registry facts**

In `src/dispatch/provision.ts`, delete `NODE_INSTALL_MARKERS` (line 18) and `NODE_MANIFEST_FILES` (line 22) with their doc comments, add the import, and replace `isComponentReady`:

```ts
import { stackFacts } from "./stack-registry.ts";
```

```ts
/** Is this component's dependency install already complete? **Content-aware** per ecosystem: ready
 *  iff one of the kind's `installMarkers` exists under its `installOutputDir` AND that marker's
 *  mtime is >= the newest mtime among the kind's `manifests` present in `compAbsDir`. A manifest
 *  edited (loopback dependency change) after the last install makes the marker stale → not ready →
 *  `planProvision` reinstalls, closing the silent no-op where a later manifest touch reset
 *  `provision` to pending but the marker still read "ready".
 *
 *  A kind with no `installMarkers` (python, php, ruby, and every no-install kind) is never ready, so
 *  it always re-installs — correct for python, where the guarantee comes from the post-install
 *  worktree-source check instead. Before ENG-344 this was a hardcoded `kind !== "node" &&
 *  kind !== "sveltekit"`; the marker list IS the fact, so the check now generalizes. */
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  const facts = stackFacts(kind);
  if (facts.installMarkers.length === 0 || facts.installOutputDir === undefined) return false;

  const outDir = join(compAbsDir, facts.installOutputDir);
  const markerMtimes = facts.installMarkers
    .map((m) => join(outDir, m))
    .filter((p) => existsSync(p))
    .map((p) => statSync(p).mtimeMs);
  if (markerMtimes.length === 0) return false;
  const freshestMarkerMtime = Math.max(...markerMtimes);

  const manifestMtimes = facts.manifests
    .map((f) => join(compAbsDir, f))
    .filter((p) => existsSync(p))
    .map((p) => statSync(p).mtimeMs);
  if (manifestMtimes.length === 0) return true; // no manifest present to compare against

  return freshestMarkerMtime >= Math.max(...manifestMtimes);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/provision.test.ts`
Expected: PASS, including the pre-existing yarn/pnpm marker tests and the mtime-staleness tests. Those are the regression surface — they must not change.

**Then verify the refactor actually happened.** This task has zero observable behavior delta, so a subagent that writes the test, sees green, and never edits `provision.ts` also produces a green branch. Run:

```bash
grep -n 'kind === "node"\|kind !== "node"\|kind === "sveltekit"' src/dispatch/provision.ts || true
```
Expected: no output. Non-empty means the rewrite was skipped.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/provision.ts test/dispatch/provision.test.ts
git commit -m "refactor(provision): read install markers from the stack registry (ENG-344)

isComponentReady's hardcoded 'kind !== node && kind !== sveltekit' becomes
'this kind declares no install markers'. Same answers for all nine kinds;
the fact now lives in one place.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 6: `resolveInterpreter(kind)` reads the fallback order from the registry

**Files:**
- Modify: `src/dispatch/provision.ts:176-185`, `src/dispatch/check-selector.ts:394`
- Test: `test/dispatch/provision.test.ts`

**Interfaces:**
- Consumes: `stackFacts` from Task 1.
- Produces: `resolveInterpreter(kind: string): string` (new export). `resolvePythonInterpreter(): string` is retained as a thin wrapper — three call sites depend on it and its error string is asserted in tests.

- [ ] **Step 1: Write the failing test**

```ts
import { resolveInterpreter, resolvePythonInterpreter } from "../../src/dispatch/provision.ts";

test("resolveInterpreter('python') matches the legacy python3-then-python order", () => {
  expect(resolveInterpreter("python")).toBe(resolvePythonInterpreter());
  expect(["python3", "python"]).toContain(resolveInterpreter("python"));
});

test("a kind that declares no interpreter throws rather than guessing", () => {
  expect(() => resolveInterpreter("go")).toThrow(/no interpreter/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/provision.test.ts`
Expected: FAIL — `resolveInterpreter` is not exported.

- [ ] **Step 3: Generalize the resolver**

Replace `resolvePythonInterpreter` in `src/dispatch/provision.ts`:

```ts
/** Resolve the interpreter for a kind: the first of its registry `interpreters` present on PATH.
 *  Never hardcodes a name. None present is a distinct provisioning-infra failure, so this throws
 *  (the caller escalates) rather than silently skipping a check or falling through to a bare,
 *  possibly-absent binary. */
export function resolveInterpreter(kind: string): string {
  const candidates = stackFacts(kind).interpreters;
  for (const candidate of candidates) {
    if (Bun.which(candidate)) return candidate;
  }
  throw new Error(
    candidates.length === 0
      ? `provision: kind "${kind}" declares no interpreter`
      : `provision: no ${candidates.join(" or ")} interpreter found on PATH`,
  );
}

/** The python interpreter for the source-check probe and the remediation reinstall (Fix D).
 *  Thin wrapper — the fallback order now lives in the stack registry. */
export function resolvePythonInterpreter(): string {
  return resolveInterpreter("python");
}
```

The thrown message for python is byte-identical to today's (`provision: no python3 or python interpreter found on PATH`), so any existing assertion on it still passes.

**Do NOT touch `check-selector.ts`.** An earlier draft changed its `binaryFor` pytest default to `opts?.interp ?? stackFacts("python").interpreters[0]`. All three reviewers flagged it: the expression evaluates to the literal `"python3"`, so it resolves nothing (unlike `resolveInterpreter`, which probes PATH); it existed only to manufacture a second consumer for `interpreters`; and it contradicts the Global Constraint that PR 1 leaves `check-selector.ts` alone. `binaryFor` is PR 2's job.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/provision.test.ts`
Expected: PASS.

Note the Step-1 test must tolerate a machine with neither `python3` nor `python`, as `test/dispatch/provision.test.ts:214-222` already does — wrap in `try/catch` rather than asserting unconditionally, or a python-less CI container errors instead of skipping.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/provision.ts test/dispatch/provision.test.ts
git commit -m "refactor(provision): read interpreter fallback order from the registry (ENG-344)

resolvePythonInterpreter becomes a wrapper over resolveInterpreter(kind).
Same order, same error string. The bare-pip/python portability follow-up
will consume this same field.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 7: `diffTouchesManifest` unions the registry's manifests

Fixes the live bug: `Gemfile` and `composer.json` never re-armed provision.

**Files:**
- Modify: `src/dispatch/provision.ts:187-216`
- Test: `test/dispatch/provision.test.ts`

**Interfaces:**
- Consumes: `STACKS` from Task 1.
- Produces: `diffTouchesManifest(changedPaths: string[]): boolean` — signature unchanged.

- [ ] **Step 1: Write the failing test**

```ts
test("a Gemfile or composer.json edit re-arms provision (spec §6.3)", () => {
  // Both ecosystems are prepare-bearing, so missing them meant a mid-run
  // dependency change silently skipped the reinstall.
  expect(diffTouchesManifest(["Gemfile"])).toBe(true);
  expect(diffTouchesManifest(["Gemfile.lock"])).toBe(true);
  expect(diffTouchesManifest(["composer.json"])).toBe(true);
  expect(diffTouchesManifest(["composer.lock"])).toBe(true);
});

test("the union also covers the no-prepare ecosystems (cheap no-op re-arm)", () => {
  for (const p of ["Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"]) {
    expect(diffTouchesManifest([p])).toBe(true);
  }
});

test("every manifest the old hardcoded set knew still matches", () => {
  for (const p of [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "pyproject.toml", "setup.py", "setup.cfg", "poetry.lock", "Pipfile", "Pipfile.lock",
  ]) {
    expect(diffTouchesManifest([p])).toBe(true);
  }
});

test("requirements*.txt still matches by pattern, and is path-independent", () => {
  expect(diffTouchesManifest(["requirements.txt"])).toBe(true);
  expect(diffTouchesManifest(["requirements-dev.txt"])).toBe(true);
  expect(diffTouchesManifest(["apps/api/pyproject.toml"])).toBe(true);
});

test("a non-manifest file does not re-arm", () => {
  expect(diffTouchesManifest(["src/index.ts", "README.md"])).toBe(false);
  expect(diffTouchesManifest([])).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/provision.test.ts`
Expected: FAIL — `expected true, got false` for `Gemfile`, `composer.json`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`.

- [ ] **Step 3: Derive the union**

In `src/dispatch/provision.ts`, replace `MANIFEST_BASENAMES` (lines 192-203) and `REQUIREMENTS_RE` (line 205):

```ts
/** Every dependency manifest/lockfile basename across all supported ecosystems, unioned from the
 *  stack registry. Before ENG-344 this was a hand-maintained set that omitted `Gemfile` and
 *  `composer.json` — both prepare-bearing — so a mid-run dependency edit in a Ruby or PHP repo
 *  never re-armed provision. */
const MANIFEST_BASENAMES: ReadonlySet<string> = new Set(
  Object.values(STACKS).flatMap((f) => [...f.manifests]),
);

/** Manifests a fixed basename can't express (python's `requirements*.txt` — pip's convention allows
 *  an arbitrary suffix), compiled from the registry's pattern sources. */
const MANIFEST_PATTERNS: readonly RegExp[] = [
  ...new Set(Object.values(STACKS).flatMap((f) => [...f.manifestPatterns])),
].map((src) => new RegExp(src));
```

Update `diffTouchesManifest` (line 211) to use the compiled patterns:

```ts
export function diffTouchesManifest(changedPaths: string[]): boolean {
  return changedPaths.some((p) => {
    const base = basename(p);
    return MANIFEST_BASENAMES.has(base) || MANIFEST_PATTERNS.some((re) => re.test(base));
  });
}
```

Add `STACKS` to the `stack-registry.ts` import added in Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/provision.test.ts test/dispatch/checks-provision-reset.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/provision.ts test/dispatch/provision.test.ts
git commit -m "fix(provision): re-arm on Gemfile/composer.json dependency edits (ENG-344)

MANIFEST_BASENAMES was hand-maintained and omitted Gemfile and
composer.json, both prepare-bearing — so an implement dispatch that added
a Ruby gem or PHP package never triggered the reinstall before verify.
Unioning the registry's per-kind manifests closes that and also picks up
the no-prepare ecosystems, where the re-arm is a cheap no-op because
planProvision emits nothing for a component without a prepare.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 8: Derive the repo-walk skip sets

**Files:**
- Modify: `src/setup/manifests.ts:4-21`, `src/dispatch/worktree.ts:255`
- Test: `test/setup/manifests.test.ts`, `test/dispatch/worktree.test.ts` (or wherever `sweepScratch` is covered — find with `grep -rln "sweepScratch" test/`)

**Interfaces:**
- Consumes: `STACKS`, `GENERIC_IGNORE_DIRS` from Task 1.
- Produces: `SKIP: ReadonlySet<string>` stays exported from `manifests.ts` with the same name and membership.

- [ ] **Step 1: Write the failing test**

Add to `test/setup/manifests.test.ts`:

`test/setup/manifests.test.ts:5` currently imports only `findManifests`. **Edit that line** to `import { SKIP, findManifests } from "../../src/setup/manifests.ts";` — a second mid-file import trips `organizeImports`.

```ts
test("SKIP membership is unchanged by the registry derivation", () => {
  // Set EQUALITY, not superset: SKIP prunes the walk, so an extra entry would
  // silently find fewer components (spec §6.5).
  expect([...SKIP].sort()).toEqual([
    ".git", ".gradle", ".mvn", ".nox", ".svelte-kit", ".tox", ".venv",
    "Pods", "__pycache__", "build", "dist", "node_modules", "target",
    "testdata", "vendor", "venv",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/manifests.test.ts`
Expected: PASS — the literal set already matches. This pins membership before the refactor; Step 3 must keep it green. Proceed.

- [ ] **Step 3: Derive both sets**

In `src/setup/manifests.ts`, replace lines 1-21:

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENERIC_IGNORE_DIRS, STACKS } from "../dispatch/stack-registry.ts";

/** Directory names the manifest walk must not descend into: every ecosystem's vendored/build-output
 *  dirs, plus the ones belonging to no single ecosystem (`.git`, `dist`, `Pods`). Derived from the
 *  stack registry so adding a language brings its ignore dirs with it.
 *  `test/setup/manifests.test.ts` pins membership — this set PRUNES the walk, so an accidental
 *  addition would silently under-detect components. */
export const SKIP: ReadonlySet<string> = new Set([
  ...GENERIC_IGNORE_DIRS,
  ...Object.values(STACKS).flatMap((f) => [...f.ignoreDirs]),
]);
```

In `src/dispatch/worktree.ts`, add `import { STACKS } from "./stack-registry.ts";` **to the existing import block at the top of the file** (Biome's `organizeImports` errors on a mid-file import), then replace line 255 with:

```ts
/** Dirs `sweepScratch` must not descend into: VCS metadata plus every ecosystem's install output
 *  (`node_modules`, `vendor`). A `styre_scratch/` inside a dependency tree is not the worker's. */
const SWEEP_SKIP_DIRS = new Set([
  ".git",
  ...Object.values(STACKS)
    .map((f) => f.installOutputDir)
    .filter((d): d is string => d !== undefined),
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/manifests.test.ts test/setup/detect-components.test.ts test/dispatch/worktree.test.ts`
Expected: PASS. The `SKIP` equality test failing means a kind's `ignoreDirs` is wrong — fix the registry entry in Task 1's file, never the assertion.

- [ ] **Step 5: Add the sweep behavior-delta test**

Add to the file covering `sweepScratch`:

```ts
test("sweepScratch does not descend into a vendored dependency tree", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-sweep-"));
  roots.push(root);
  mkdirSync(join(root, "vendor", "acme", "styre_scratch"), { recursive: true });
  mkdirSync(join(root, "src", "styre_scratch"), { recursive: true });

  const removed = sweepScratch(root);
  expect(removed).toEqual(["src/styre_scratch"]);
  expect(existsSync(join(root, "vendor", "acme", "styre_scratch"))).toBe(true);
});
```

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
bun run lint && bun test
git add src/setup/manifests.ts src/dispatch/worktree.ts test/setup/manifests.test.ts test/dispatch/worktree.test.ts
git commit -m "refactor(setup): derive the repo-walk skip sets from the registry (ENG-344)

SKIP membership is unchanged (asserted by set equality — it prunes the
walk, so a superset would silently under-detect components). SWEEP_SKIP_DIRS
becomes .git plus every ecosystem's install output, which adds vendor:
sweepScratch no longer descends into a PHP dependency tree.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 9: Derive `TARGETED_LANG_MANIFESTS` from detect anchors

**Files:**
- Modify: `src/setup/detect-components.ts:59-64`
- Test: `test/setup/detect-components.test.ts`

**Interfaces:**
- Consumes: `STACKS` from Task 1 (already imported for `stackFacts` in Task 3).
- Produces: `unrootedManifestWarnings(repoDir: string): string[]` — signature and message strings unchanged.

- [ ] **Step 1: Write the failing test**

`test/setup/detect-components.test.ts` has **no `roots` array and no `afterAll`** — it uses a local `fixture(files)` helper (lines 7-15). Use that, and export `TARGETED_LANG_MANIFESTS` so the derivation itself is asserted:

```ts
// The behavioral test alone is BLIND: a wrong derivation using `.manifests`
// instead of `.detectAnchors` passes all 20 tests in this file, because the
// fixture writes Gemfile/composer.json — the FIRST element of both lists —
// and the loop breaks there. Assert the derived structure directly.
test("targeted-language manifests derive to exactly today's table", () => {
  expect(TARGETED_LANG_MANIFESTS).toEqual([
    ["jvm-maven", ["pom.xml"]],
    ["jvm-gradle", ["build.gradle", "build.gradle.kts"]],
    ["ruby", ["Gemfile"]],
    ["php", ["composer.json"]],
  ]);
});

test("a lockfile-only subdir produces NO warning (the .manifests mis-derivation)", () => {
  // Gemfile.lock is in ruby.manifests but NOT ruby.detectAnchors.
  expect(unrootedManifestWarnings(fixture({ "svc/Gemfile.lock": "" }))).toEqual([]);
});

test("unrooted-manifest warnings still cover the targeted languages", () => {
  const warnings = unrootedManifestWarnings(
    fixture({ "svc/Gemfile": "", "svc/composer.json": "{}" }),
  );
  expect(warnings.some((w) => w.includes("Gemfile") && w.includes("no ruby component"))).toBe(true);
  expect(warnings.some((w) => w.includes("composer.json") && w.includes("no php component"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS — behavior is already correct. This pins it before the refactor. Proceed.

- [ ] **Step 3: Derive the list**

In `src/setup/detect-components.ts`, replace lines 59-64. Add `STACKS` to the existing `stack-registry.ts` import:

```ts
/** The languages whose detection is root-only (§5.4), paired with their detect anchors from the
 *  stack registry. Node/rust/python/go do a bounded nested walk instead, so they need no warning.
 *  Kept as an explicit kind list — WHICH languages are root-only is a detector policy, not an
 *  ecosystem fact, so it does not belong in the registry. */
const TARGETED_LANG_KINDS = ["jvm-maven", "jvm-gradle", "ruby", "php"] as const;

export const TARGETED_LANG_MANIFESTS: Array<[string, readonly string[]]> = TARGETED_LANG_KINDS.map(
  (kind) => [kind, STACKS[kind].detectAnchors],
);
```

The loop at line 70 (`for (const [lang, names] of TARGETED_LANG_MANIFESTS)`) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS, including the pre-existing `unrootedManifestWarnings` assertions.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/setup/detect-components.ts test/setup/detect-components.test.ts
git commit -m "refactor(setup): derive targeted-language manifests from detect anchors (ENG-344)

The manifest filenames come from the registry; WHICH languages are
root-only stays an explicit detector-policy list, since that is not an
ecosystem fact.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 10: Bind `runtime-deps` rows to registry kinds

The parser functions stay local — putting them in the registry would break the no-functions boundary. The mapping is *verified against* the registry rather than *derived from* it, because deriving is ambiguous: `package.json` appears in both `node.manifests` and `sveltekit.manifests`, so a file→kind union has no single answer.

**Files:**
- Modify: `src/setup/runtime-deps/collect.ts:17-31`
- Test: `test/setup/runtime-deps/collect.test.ts`

**Interfaces:**
- Consumes: `STACKS`, `stackFacts` from Task 1.
- Produces: the module-private `MANIFESTS` rows gain a `kind` field typed as a registry key; the emitted `Lang` label is unchanged (`"jvm"` stays coarse).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MANIFEST_ROWS } from "../../../src/setup/runtime-deps/collect.ts";
import { STACKS, isModeledKind } from "../../../src/dispatch/stack-registry.ts";

describe("runtime-deps rows are bound to the registry", () => {
  test("every row names a modeled kind", () => {
    for (const row of MANIFEST_ROWS) expect(isModeledKind(row.kind)).toBe(true);
  });

  test("every row's file is a manifest, anchor, or pattern of its kind", () => {
    for (const row of MANIFEST_ROWS) {
      const f = STACKS[row.kind];
      const known =
        f.manifests.includes(row.file) ||
        f.detectAnchors.includes(row.file) ||
        f.manifestPatterns.some((p) => new RegExp(p).test(row.file));
      expect(known ? null : `${row.file} is not a known manifest of ${row.kind}`).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/runtime-deps/collect.test.ts`
Expected: FAIL — `MANIFEST_ROWS` is not exported.

- [ ] **Step 3: Re-key the rows**

In `src/setup/runtime-deps/collect.ts`, replace lines 17-31:

```ts
/** The coarse label emitted in the enrichment output. Deliberately coarser than component `kind`:
 *  maven and gradle both surface as "jvm" to the prompt. */
type Lang = "node" | "rust" | "python" | "go" | "ruby" | "php" | "jvm";

/** Component kinds → the coarse output label. */
const LANG_FOR_KIND: Record<string, Lang> = {
  node: "node", rust: "rust", python: "python", go: "go",
  ruby: "ruby", php: "php", "jvm-maven": "jvm", "jvm-gradle": "jvm",
};

/** Which manifest a parser handles, and which registry kind it belongs to. The parser is a
 *  FUNCTION, so it cannot live in the stack registry (that module is data-only by construction —
 *  see its header). The `kind` field binds each row to the registry instead, and
 *  `test/setup/runtime-deps/collect.test.ts` asserts every `file` is a known manifest of its kind,
 *  so a registry rename cannot silently orphan a parser.
 *
 *  Not derived from the registry: `package.json` belongs to both `node` and `sveltekit`, so a
 *  file→kind union would be ambiguous. */
export const MANIFEST_ROWS: {
  file: string;
  kind: string;
  parse: (c: string) => string[];
}[] = [
  { file: "package.json", kind: "node", parse: parsePackageJson },
  { file: "Cargo.toml", kind: "rust", parse: parseCargoToml },
  { file: "pyproject.toml", kind: "python", parse: parsePyproject },
  { file: "requirements.txt", kind: "python", parse: parseRequirementsTxt },
  { file: "go.mod", kind: "go", parse: parseGoMod },
  { file: "Gemfile", kind: "ruby", parse: parseGemfile },
  { file: "composer.json", kind: "php", parse: parseComposerJson },
  { file: "pom.xml", kind: "jvm-maven", parse: parsePomXml },
  { file: "build.gradle", kind: "jvm-gradle", parse: parseBuildGradle },
  { file: "build.gradle.kts", kind: "jvm-gradle", parse: parseBuildGradle },
  { file: "libs.versions.toml", kind: "jvm-gradle", parse: parseGradleCatalog },
];

const MANIFESTS = MANIFEST_ROWS.map((r) => ({
  file: r.file,
  lang: LANG_FOR_KIND[r.kind] as Lang,
  parse: r.parse,
}));
```

Everything downstream of `MANIFESTS` is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/runtime-deps/`
Expected: PASS, including the pre-existing collect/parse tests — the emitted `lang` labels are byte-identical.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/setup/runtime-deps/collect.ts test/setup/runtime-deps/collect.test.ts
git commit -m "refactor(setup): bind runtime-deps manifest rows to registry kinds (ENG-344)

The parsers are functions, so they stay out of the data-only registry. The
rows now name a registry kind and a test asserts every file is a known
manifest of that kind, so a registry rename cannot orphan a parser. The
coarse 'jvm' output label is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 11: Document the registry and verify the whole branch

**Files:**
- Modify: `docs/architecture/conventions.md`
- Verify: whole repo

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Confirm no table survived the migration**

```bash
grep -rn "EXTENSIONS_BY_KIND\|NODE_INSTALL_MARKERS\|NODE_MANIFEST_FILES" src/ test/ || true
```
Expected: exactly **one** hit — the stale doc comment at `src/setup/lang/types.ts:3` (`materialized from \`EXTENSIONS_BY_KIND\``). Fix that comment now to say "materialized from the stack registry". Any other hit is an un-migrated consumer.

(`|| true` again: `grep -r` exits 1 when it matches nothing.)

```bash
grep -rn 'kind === "node"\|kind !== "node"\|kind === "sveltekit"' src/dispatch/provision.ts
```
Expected: no output.

- [ ] **Step 2: Confirm the boundary still holds**

```bash
grep -cE "^\s*(import|const .* = require)" src/dispatch/stack-registry.ts || true
```
Expected: `0`. Note the `|| true`: `grep -c` **exits 1 on a zero count**, so without it the success case reads as a failed step.

This grep is a convenience only. The real guarantee is Task 1's literal-snapshot test (spec §5.2) — `grep` cannot see `Bun.file()`, `process.cwd()`, a dynamic `import()`, or a lazy getter, all of which reach repo state with no import statement.

- [ ] **Step 3: Document the extension point**

Append to `docs/architecture/conventions.md`:

```markdown
## The language stack registry

`src/dispatch/stack-registry.ts` is the single source of **invariant** per-ecosystem facts, keyed by
component `kind`: file extensions, detect anchors, ignore dirs, dependency manifests, install output
dir / bin dirs / provided tools / completeness markers, and interpreter fallback order. Detectors,
provision, the toolchain preflight, the repo walk, and the checks module all read from it, so a fact
cannot be true in one module and false in another.

**The boundary.** The module imports nothing and contains no functions. That is not style: a module
that cannot reach `node:fs` cannot branch on repo state, which turns "the registry holds no
repo-specific logic" into an assertion `test/dispatch/stack-registry.test.ts` actually checks.

**What does NOT go in it.** Anything conditional on a specific repo's contents: which package
manager it uses (lockfile scan), which test runner (tox/nox/pytest config scan), its python import
name (pyproject parse), which check framework its test command implies (a command sniff). Those stay
as detector logic. Adding a conditional to the registry is the failure mode it exists to prevent.

**Adding a language:** add a `StackFacts` entry, add a `LangDef` under `src/setup/lang/`, register it
in `src/setup/registry.ts`. Nothing else should need a new `kind` branch — if it does, that fact is
probably missing from the registry.

*(Framework-keyed check facts — `CHECK_RULES`, `binaryFor`, the selector and exit-code tables — move
into this module in a follow-up. `kind → framework` is 1:many resolved by a command sniff, so they
need a second key, not a merge into `StackFacts`.)*
```

- [ ] **Step 4: Full verification**

```bash
bun run lint && bun test && bun run build
```
Expected: lint clean, all tests pass, build produces the binary.

- [ ] **Step 5: Commit and push**

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
| Registry exists, imports nothing, 9 kinds, total `stackFacts` | 1 |
| Preflight derives install-provided; ENG-332 special-case gone for modeled kinds | 2 |
| `EXTENSIONS_BY_KIND` + `SOURCE_EXTS` superseded, routing unchanged | 3, 4 |
| Provision reads markers, output dir, manifests, interpreters | 5, 6, 7 |
| `TARGETED_LANG_MANIFESTS`, `SKIP`, `SWEEP_SKIP_DIRS`, runtime-deps mapping derived | 8, 9, 10 |
| §5 boundary tests pass | 1 |
| `bun run lint` + `bun test` green | every task; final in 11 |

## Behavior changes to call out in the PR description

Each is spec §6 and has a named test:

1. node components regain `npm run <script>` probes (Task 2).
2. `python -m pytest` now probes `python` — a python3-only machine gets exit 69 at second zero instead of a mid-run verify death (Task 2).
3. `diffTouchesManifest` gains `Gemfile`/`composer.json` — fixes a live re-arm bug (Task 7).
4. `moduleLeaf` gains `.svelte`/`.gradle`/`.groovy`/`.cts`/`.mts` (Task 4).
5. `sweepScratch` no longer descends into `vendor/` (Task 8).
6. Unmodeled prepare-bearing kinds keep the conservative probe-only-prepare rule (Task 2).
