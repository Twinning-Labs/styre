# Stop Persisting Component File Extensions Implementation Plan (ENG-361)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `Component.extensions` from `profile.json` and derive file-identity routing from the stack registry at the point of use, so the same ecosystem fact stops existing in two places with different lifecycles.

**Architecture:** `extensions` moves into `src/dispatch/stack-registry.ts`. `extMatches` reads it live instead of reading a value frozen into the profile at `styre setup` time. The schema field, both materialization sites, and `EXTENSIONS_BY_KIND` are deleted. `schemaVersion` goes 3 → 4 so a stale binary rejects a new profile loudly instead of silently over-routing; old profiles keep working because the parser accepts 3 and normalizes to 4.

**Tech Stack:** TypeScript on Bun. Tests are `bun test`. Lint is `bun run lint` (Biome); types are `bun run typecheck` (`tsc --noEmit --strict`).

**Spec:** `docs/brainstorms/2026-07-22-eng-344-language-stack-registry-design.md` §6b.

## Blockers and siblings

**Blocked by ENG-344** — `src/dispatch/stack-registry.ts` must exist with `STACKS`, `stackFacts`, `isModeledKind` and its boundary tests (including the literal `SNAPSHOT`).

**Blocked by ENG-362** — and this one is load-bearing, not procedural.

This plan re-points routing onto `c.kind`. Today the discovery agent can author `kind`: `DiscoverSchema` includes it (`discover-schema.ts:9-14`), `mergeComponents` lets it win (`:38` — `kind: p.kind || s.kind`) while carrying the scan's `extensions` verbatim (`:43`), and `discover.ts:47` runs the merge *before* the `trusted` gate on `:49`, which filters only `commands`. So a machine-written v3 profile can already carry `kind: python` alongside node extensions.

Deriving routing from `kind` changes behavior for exactly those components — `.ts` files stop routing to a node component whose kind was refined. That is a **silent under-verify**, which `docs/plans/2026-06-30-wo5-file-identity-routing.md` calls "the cardinal sin", and whose closure was the stated purpose of WO-5 decision **D1** ("extensions materialized at setup … closes agent-kind-drift"). ENG-362 gates the agent's `kind` refinement and must land first.

**Sibling, independent — either order:** ENG-360 (the mechanical fold of provision/manifests/skip-dirs/runtime-deps).

**Land ENG-359 first if you can.** It fixes the `SOURCE_EXTS` drift (8 missing extensions) in ~2 lines. If it has landed, Task 5 here is a pure no-op refactor. If not, Task 5 carries that behavior change — say so in the PR body rather than letting it ride. As of writing it had **not** landed.

## Why

`Component.extensions[]` is materialized at `styre setup` time (`detect-components.ts:28`) into `profile.json`, which is written once and then read by every later run — including runs of a newer binary. Once `EXTENSIONS_BY_KIND` moves into the registry, the same fact also lives in the running binary and is read live by check-matching.

Add `.vue` to the registry tomorrow: a profile written last month still routes without it, while `moduleLeaf` — reading the registry — treats it as a source file. Two halves of one run disagreeing about one fact. That is the bug class this effort exists to delete, and the registry would have recreated it.

The operator chose to remove the second copy outright rather than document an invariant against it (design §6b), because an invariant makes drift discouraged rather than impossible.

**Compatibility, stated precisely.** For a profile written after ENG-362, the derived extension list equals the stored one for every kind, so behavior is preserved and no regeneration is needed. For a profile written *before* ENG-362 whose `kind` was agent-refined, stored and derived can disagree and routing changes; re-running `styre setup` repairs it. That residual is listed under behavior changes.

## Global Constraints

- **Never commit to `main`.** Branch `feat/eng-361-extensions-not-persisted` — `CONTRIBUTING.md:46` allows only `feat/` and `fix/` prefixes.
- **Every task ends green with `bun run format && bun run lint && bun run typecheck && bun test`** — all four. `bun run lint` is `biome check .` (no `--write`) and the repo enforces `lineWidth: 100`, so hand-wrapped pasted code fails lint unless formatted first. `bun run typecheck` is what CI runs (`.github/workflows/ci.yml:18`); Biome does not type-check and `bun test` strips types.
- **`bun run format` does NOT fix import order.** `organizeImports` is a Biome *assist*, enforced only by `biome check` and never auto-fixed. Biome sorts by module specifier (`"bun:test"` before `"node:fs"`). Every import this plan adds comes from a different module than the existing ones, so each needs **its own statement in sorted position** — not a merge into an existing block.
- **`grep`, not `tsc`, is the authority for the fixture sweep.** Typecheck catches ~12 of the 15 affected test files; three defeat excess-property checking entirely (Task 4 Step 2 names them).
- **Task order is load-bearing.** The version bump (Task 3) must land *before* the field deletion (Task 4). Reversed, an intermediate state writes a profile with no extension list still marked v3, which a stale binary reads as "match every file".
- **Do NOT touch** `src/dispatch/check-selector.ts` or `check-rules.ts:347` (`CHECK_RULES`) — PR 2's job. Do NOT touch `src/dispatch/provision.ts`, `src/setup/manifests.ts`, `src/dispatch/worktree.ts`, or `src/setup/runtime-deps/` — ENG-360's job.
- **Regenerate the registry `SNAPSHOT`, never hand-edit it** (identical to ENG-344's form — the two plans run back to back and must not diverge):
  ```bash
  bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log("const SNAPSHOT = " + JSON.stringify(m.STACKS, null, 2) + ";"))'
  ```
- **The repo squash-merges** (`ci.yml:24-26`), and `CHANGELOG.md` is generated by git-cliff from commit subjects (`CONTRIBUTING.md:53`). Per-task commit bodies are discarded at merge — anything that must survive belongs in the **PR title and body** (Task 6 Step 3).
- Commit messages: conventional-commit with a scope, ending with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/dispatch/stack-registry.ts` | modify | Gains `extensions` (Task 1) |
| `src/dispatch/components.ts` | modify | `extMatches` derives (Task 2); `EXTENSIONS_BY_KIND` deleted (Task 4) |
| `src/dispatch/profile.ts` | modify | `schemaVersion` 3→4 (Task 3); `extensions` removed from `ComponentSchema` (Task 4) |
| `src/setup/detect-components.ts` | modify | Materialization deleted (Task 4) |
| `src/setup/discover-schema.ts` | modify | `mergeComponents` carry deleted (Task 4) |
| `src/setup/lang/types.ts` | modify | `ComponentDraft` restated (Task 4) |
| `src/dispatch/check-rules.ts` | modify | `SOURCE_EXTS` derived (Task 5) |
| `docs/architecture/configuration.md`, `conventions.md` | modify | Profile + registry reference (Task 6) |
| 15 test files | modify | Fixture sweep (Task 4) |

---

### Task 1: Add `extensions` to the registry

**Files:**
- Modify: `src/dispatch/stack-registry.ts`
- Test: `test/dispatch/stack-registry.test.ts`

**Interfaces:**
- Consumes: `STACKS`, `stackFacts` (from ENG-344).
- Produces: `StackFacts.extensions: readonly string[]`. Tasks 2 and 5 read it.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/stack-registry.test.ts`. This is **differential**: `EXTENSIONS_BY_KIND` still exists at this point, so compare against the live table rather than a hand-copied literal — a transcription error made twice would pass a literal comparison. Task 4 deletes this test along with the table it compares against.

Add as its own import statement in sorted position:
```ts
import { EXTENSIONS_BY_KIND } from "../../src/dispatch/components.ts";
```

```ts
test("extensions match today's live EXTENSIONS_BY_KIND exactly", () => {
  for (const [kind, exts] of Object.entries(EXTENSIONS_BY_KIND)) {
    expect(stackFacts(kind).extensions).toEqual([...exts]);
  }
  // Symmetry: neither table has an entry the other lacks. Because stackFacts is
  // total, a MISSING registry key yields [] and fails the loop above, so
  // omissions are caught too.
  expect(Object.keys(EXTENSIONS_BY_KIND).sort()).toEqual(Object.keys(STACKS).sort());
});

test("an unmodeled kind has no extensions -> path-only routing", () => {
  expect(stackFacts("elixir").extensions).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: FAIL — `stackFacts(...).extensions` is `undefined`, reported as `undefined` vs the expected array.

- [ ] **Step 3: Add the field**

In `src/dispatch/stack-registry.ts`, add to `StackFacts`:

```ts
  /** File extensions owned by this kind, lower-case and dot-prefixed. Empty ⇒ path-only routing
   *  (a `kind` the registry does not model is routed by path globs alone). Read live by
   *  `extMatches` — deliberately NOT persisted into `profile.json`, because a profile is written
   *  once and read by every later run, including runs of a newer binary, and two copies with
   *  different lifecycles is the drift this module exists to delete (design §6b).
   *
   *  Also the source for `SOURCE_EXTS` (`check-rules.ts`), which strips a trailing source extension
   *  when reducing a path to a module leaf. Do NOT add a non-source extension here for routing
   *  reasons alone — it would silently change check name-matching too. */
  readonly extensions: readonly string[];
```

ENG-344's shared `NO_INSTALL_STEP` / `INSTALLS_NO_NAMED_TOOLS` constants become **spreadable partials**, since `extensions` differs per kind and must be written inline. This drops their `: StackFacts` annotation — the only compile-time check that those constants are complete — which is unavoidable (an annotated literal missing `extensions` would not compile). A future `StackFacts` field will now fail only at the nine `RAW` entries.

```ts
const NODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"] as const;
const JVM_EXTS = [".java", ".kt", ".kts", ".scala", ".groovy"] as const;

/** No install step at all: dependencies resolve inside the build invocation. */
const NO_INSTALL_STEP = { installBinDirs: [], installProvidedTools: [] } as const;
/** Has an install step, but it provides no tool the command strings can name — npm/pnpm/yarn and
 *  `bundle` are all preconditions. */
const INSTALLS_NO_NAMED_TOOLS = { installBinDirs: [], installProvidedTools: [] } as const;

const RAW: Record<string, StackFacts> = {
  rust: { extensions: [".rs"], ...NO_INSTALL_STEP },
  go: { extensions: [".go"], ...NO_INSTALL_STEP },
  "jvm-maven": { extensions: [...JVM_EXTS], ...NO_INSTALL_STEP },
  "jvm-gradle": { extensions: [...JVM_EXTS, ".gradle"], ...NO_INSTALL_STEP },
  node: { extensions: [...NODE_EXTS], ...INSTALLS_NO_NAMED_TOOLS },
  sveltekit: { extensions: [...NODE_EXTS, ".svelte"], ...INSTALLS_NO_NAMED_TOOLS },
  ruby: { extensions: [".rb", ".rake", ".gemspec"], ...INSTALLS_NO_NAMED_TOOLS },
  python: {
    extensions: [".py", ".pyi"],
    installBinDirs: [],
    installProvidedTools: ["pytest", "tox", "nox"],
  },
  php: {
    extensions: [".php"],
    installBinDirs: ["vendor/bin"],
    installProvidedTools: ["phpunit", "pest"],
  },
};
```

Add `extensions: []` to `UNMODELED`.

- [ ] **Step 4: Regenerate the snapshot and run**

```bash
bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log("const SNAPSHOT = " + JSON.stringify(m.STACKS, null, 2) + ";"))'
```
Replace the `SNAPSHOT` literal in `test/dispatch/stack-registry.test.ts` with the output verbatim.

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: PASS. If the differential test fails, the diff names the offending kind — fix the registry entry, never the assertion.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/stack-registry.ts test/dispatch/stack-registry.test.ts
git commit -m "feat(dispatch): add extensions to the stack registry (ENG-361)

Asserted differentially against the live EXTENSIONS_BY_KIND, which still
exists at this point — a hand-copied literal would pass even if the same
transcription error were made twice.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 2: `extMatches` derives from the registry

`EXTENSIONS_BY_KIND` still populates `Component.extensions`, and Task 1 proved the two agree, so this is behavior-identical for correctly-written profiles. It makes the field unread before Task 4 deletes it.

**Files:**
- Modify: `src/dispatch/components.ts:70-77`
- Test: `test/dispatch/components.test.ts`

**Interfaces:**
- Consumes: `stackFacts` from Task 1.
- Produces: `extMatches(c: Component, file: string): boolean` — signature unchanged, source of truth changed.

- [ ] **Step 1: Audit fixtures whose stored list disagrees with their kind**

This is where Task 2 can change behavior, so survey before coding:

```bash
grep -rn "extensions:" test --include="*.ts"
```

For each hit ask: **does the stored list equal `stackFacts(kind).extensions`? If not, does anything route files through that fixture?**

The population is modeled kinds carrying an **empty** list, which flip from *unfiltered* to *extension-filtered*: `test/cli/run-guard.test.ts:18-21,33-40,50-57,67-70`, `test/dispatch/reuse.test.ts:58-61,87-90,105-108,115-118`, `test/setup/resolve-commands.test.ts:10-13,17-20,45-52`, `test/dispatch/prompt-vars.test.ts:210-231`, `test/setup/discover-schema.test.ts`, `test/dispatch/provision.test.ts:39-42`, `test/setup/discover.test.ts:40-50,166-169`.

None of them feeds a routing assertion, so the suite stays green — confirm that rather than assuming it, and note any real change in the commit body.

- [ ] **Step 2: Write the failing tests**

Add to `test/dispatch/components.test.ts`. Add as its own import statement in sorted position:
```ts
import { stackFacts } from "../../src/dispatch/stack-registry.ts";
```

The `as unknown as Component` casts are required only while `extensions` is still a mandatory field; Task 4 Step 3 converts them to plain `const c: Component = {...}` literals, matching this file's convention.

```ts
test("routing follows the component's kind, not a stored extension list", () => {
  // A profile whose stored extensions have gone stale (older binary, hand edit)
  // must route by the registry. This is the point of ENG-361.
  const stale = {
    name: "fe", kind: "sveltekit", paths: ["**"], commands: {},
    extensions: [".ts"], // stale: missing .svelte
  } as unknown as Component;
  expect(matchesComponent(stale, "src/App.svelte")).toBe(true);
});

test("registry-backed kinds still filter by extension", () => {
  const c = { name: "py", kind: "python", paths: ["**"], commands: {} } as unknown as Component;
  expect(matchesComponent(c, "a/b.py")).toBe(true);
  expect(matchesComponent(c, "a/b.rs")).toBe(false);
  expect(stackFacts("python").extensions).toContain(".py"); // guards a vacuous pass
});

test("an unmodeled kind routes by path alone", () => {
  // Regression guard: passes before AND after. Not part of the red step.
  const c = { name: "x", kind: "elixir", paths: ["lib/**"], commands: {} } as unknown as Component;
  expect(matchesComponent(c, "lib/x.ex")).toBe(true);
  expect(matchesComponent(c, "other/x.ex")).toBe(false);
});

test("an unmodeled kind IGNORES a stored extension list", () => {
  // The accepted residual, locked down: a hand-authored profile with a custom
  // kind and its own extensions now routes by path alone.
  const c = {
    name: "x", kind: "custom", paths: ["**"], commands: {}, extensions: [".x"],
  } as unknown as Component;
  expect(matchesComponent(c, "a/b.x")).toBe(true);
  expect(matchesComponent(c, "a/b.zzz")).toBe(true); // was false when the list was honored
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/dispatch/components.test.ts`
Expected: **three** failures —
- *"routing follows the component's kind"* — today `extMatches` reads the stale `[".ts"]` and returns `false` for `App.svelte`.
- *"registry-backed kinds still filter by extension"* — its fixture omits `extensions`, so `c.extensions ?? []` is `[]` and `extMatches` returns `true` for `a/b.rs`.
- *"an unmodeled kind IGNORES a stored extension list"* — today `[".x"]` is honored, so `a/b.zzz` returns `false`.

*"an unmodeled kind routes by path alone"* passes both sides.

- [ ] **Step 4: Derive**

In `src/dispatch/components.ts`, replace `extMatches` (lines 70-77):

```ts
/** True iff `file`'s extension belongs to the component's `kind`, per the stack registry — or the
 *  kind has no extensions (unmodeled/custom → path-only routing, unfiltered).
 *
 *  Reads the registry LIVE rather than a value frozen into `profile.json` at setup time. A profile
 *  is written once and read by every later run, including runs of a newer binary; the registry
 *  ships with the binary. Persisting this fact meant the two could disagree — adding an extension
 *  would leave every existing profile routing without it (ENG-361, design §6b). */
export function extMatches(c: Component, file: string): boolean {
  const exts = stackFacts(c.kind).extensions;
  if (exts.length === 0) return true;
  return exts.includes(extname(file).toLowerCase());
}
```

Add `import { stackFacts } from "./stack-registry.ts";` in sorted position.

- [ ] **Step 5: Run the wider suite**

Run: `bun test test/dispatch/ test/setup/ test/cli/`
Expected: PASS. Any failure is a fixture from Step 1 — update it and record it.

- [ ] **Step 6: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/components.ts test/dispatch/components.test.ts
git commit -m "refactor(dispatch): route by registry extensions, not the stored list (ENG-361)

extMatches reads stackFacts(kind).extensions instead of Component.extensions,
making the field unread so Task 4 can delete it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 3: Bump `schemaVersion` 3 → 4

Must land **before** Task 4.

**Files:**
- Modify: `src/dispatch/profile.ts:110-145`
- Test: `test/dispatch/profile.test.ts`

**Interfaces:**
- Produces: `Profile["schemaVersion"]` is the literal `4`. `parseProfile` accepts input `3` or `4` and always yields `4`; `> 4` is rejected with a bespoke message.

**What the bump buys.** It protects against a **stale binary reading a new file**. A v4 file omits `extensions`; the v3 schema defaults it to `[]`; and `extMatches` treats an empty list as *match every file* (`components.ts:75`). A stale binary would silently over-route every component against every changed file — wrong attribution, wrong verify scope, no error. `ProfileSchema.schemaVersion` is `z.literal(3)`, so a v3 binary reading a v4 file already fails loudly at parse. One line, exactly the guard needed.

**Why normalize rather than merely accept 3.** Two narrow reasons: `Profile["schemaVersion"]` stays a single literal rather than a union every consumer must narrow, and any future code that round-trips a loaded profile writes the correct version by default. Note that today's write path never carries a loaded profile's version forward — `src/cli/setup.ts:112` builds from a fresh `probeProfile` and the re-read at `:118-127` contributes only `analyticsId` and `runtimeContext` — so this is hygiene, not a fix for a live hazard.

**One genuine parse-behavior change.** `.default(4)` means a profile with **no** `schemaVersion` key is now read as 4 where it previously became 3. Harmless (extensions are ignored either way), but `test/dispatch/profile.test.ts:127` covers that path today asserting `3` and must be updated.

- [ ] **Step 1: Write the failing tests**

Add to `test/dispatch/profile.test.ts`:

```ts
test("a schemaVersion-3 profile is accepted and normalized to 4", () => {
  const p = parseProfile({
    schemaVersion: 3,
    slug: "s", targetRepo: "/r", defaultBranch: "main", checksSystem: "none",
    components: [{ name: "rust", kind: "rust", paths: ["**"], commands: {}, extensions: [".rs"] }],
    repoCommands: {}, promptVars: {}, runtimeContext: {},
  });
  expect(p.schemaVersion).toBe(4);
});

test("a schemaVersion-4 profile is accepted", () => {
  const p = parseProfile({
    schemaVersion: 4,
    slug: "s", targetRepo: "/r", defaultBranch: "main", checksSystem: "none",
    components: [{ name: "rust", kind: "rust", paths: ["**"], commands: {} }],
    repoCommands: {}, promptVars: {}, runtimeContext: {},
  });
  expect(p.schemaVersion).toBe(4);
});

test("a profile written by a NEWER styre is rejected with an actionable message", () => {
  // The mirror of what a v3 binary now does to a v4 file. That direction cannot
  // be fixed retroactively, but the next bump should be diagnosable rather than
  // reading like a corrupt profile.
  expect(() =>
    parseProfile({
      schemaVersion: 5,
      slug: "s", targetRepo: "/r", defaultBranch: "main", checksSystem: "none",
      components: [], repoCommands: {}, promptVars: {}, runtimeContext: {},
    }),
  ).toThrow(/newer styre|upgrade/i);
});

test("schemaVersion 1 and 2 keep their bespoke errors", () => {
  expect(() => parseProfile({ commands: {} })).toThrow(/schemaVersion 1/);
  expect(() => parseProfile({ schemaVersion: 2 })).toThrow(/schemaVersion 2.*re-run.*styre setup/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/dispatch/profile.test.ts`
Expected: FAIL — the v3 test gets `3`, the v4 test throws (`z.literal(3)` rejects `4`), and the v5 test throws with a generic zod message not matching `/newer styre|upgrade/i`.

- [ ] **Step 3: Bump, normalize, and add the too-new pre-check**

In `src/dispatch/profile.ts`, replace the `schemaVersion` line (`:116`):

```ts
  /** Accepts 3 or 4 on input and always yields 4, so `Profile["schemaVersion"]` stays a single
   *  literal rather than a union every consumer must narrow, and any future round-trip of a loaded
   *  profile writes the correct version without having to remember to.
   *
   *  Accepting 3 means no existing profile needs regenerating — a v3 file's stored `extensions[]`
   *  is stripped (zod drops unknown keys) and re-derived from `kind`. The bump exists for the OTHER
   *  direction: a v4 file omits `extensions[]`, and a v3 binary defaults that to `[]`, which
   *  `extMatches` reads as "match every file" (`components.ts:75`) — silent over-routing.
   *  `z.literal(3)` makes that a loud parse failure instead. */
  schemaVersion: z
    .union([z.literal(3), z.literal(4)])
    .default(4)
    .transform(() => 4 as const),
```

Add a too-new pre-check alongside the existing v1/v2 ones (`:133-144`):

```ts
  const v = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof v === "number" && v > 4) {
    throw new Error(
      `profile: schemaVersion ${v} was written by a newer styre than this binary understands. ` +
        "Upgrade styre, or re-run `styre setup` to regenerate a supported profile.",
    );
  }
```

Update the v2 message (`:141-142`) — after this change both of its claims are false. `extensions[]` is no longer required for file-identity routing (this PR deletes that requirement), and re-running setup now produces a v4 profile:

```ts
      "profile: schemaVersion 2 profiles are no longer supported. " +
        "Re-run `styre setup` to regenerate a schemaVersion-4 profile.",
```

Also update the v1 message's version number (`:136`) and the doc comments above `ComponentSchema` (`:92-95`) and `ProfileSchema` (`:113-114`).

- [ ] **Step 4: Run tests, including typecheck**

Run `bun test test/dispatch/profile.test.ts test/cli/ test/setup/`, then `bun run typecheck`.

Expected: two kinds of breakage, and **the second is invisible to `bun test`**:
- *Runtime:* assertions expecting `schemaVersion` `3` on a parsed profile — `test/dispatch/profile.test.ts:37` and `:127`. Update to `4`.
- *Type-only:* `test/setup/setup-analytics-id.test.ts:6` is `const profile: Profile = { schemaVersion: 3 as const, … }` — an input-shaped fixture annotated with the **output** type. It passes at runtime and only `tsc` catches it (`TS2322: Type '3' is not assignable to type '4'`). Change it to `4`.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/profile.ts test/
git commit -m "feat(profile): bump schemaVersion to 4, accepting and normalizing 3 (ENG-361)

Lands BEFORE the extensions field is removed. A v4 profile omits
extensions[], and a v3 binary defaults that to [] which extMatches reads as
'match every file' — silent over-routing. schemaVersion is a zod literal, so
a v3 binary rejects a v4 profile loudly. That is what the bump buys.

Accepting 3 means no existing profile needs regenerating. Also adds the
symmetric too-new pre-check so the NEXT bump is diagnosable, and corrects
the v2 message, whose claims this change falsifies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 4: Delete the field and both materialization sites

**Files:**
- Modify: `src/dispatch/profile.ts:102`, `src/dispatch/components.ts:4-20`, `src/setup/detect-components.ts:3,13,28`, `src/setup/discover-schema.ts:43`, `src/setup/lang/types.ts:3-5`
- Test: the 15-file fixture sweep below

**Interfaces:**
- Produces: `Component` no longer has `extensions`. `EXTENSIONS_BY_KIND` no longer exists. `ComponentDraft` is structurally identical to `Component`.

- [ ] **Step 1: Delete the schema field and the writers**

`src/dispatch/profile.ts` — delete line 102 (`extensions: z.array(z.string()).default([]),`).

> Zod objects strip unknown keys by default (nothing here calls `.strict()` or `.passthrough()`), so an old profile still carrying `extensions` parses cleanly and the key is dropped. No extra code needed.

`src/setup/detect-components.ts` — drop the `EXTENSIONS_BY_KIND` import (line 3); line 28 becomes `out.push({ ...c, paths });`. Delete the sentence about attaching `extensions` from the `runRegistry` doc comment (line 13).

`src/setup/discover-schema.ts` — delete line 43 (`extensions: s.extensions,`). Forgetting this cannot ship: it becomes `TS2339: Property 'extensions' does not exist`.

`src/dispatch/components.ts` — delete lines 4-20 entirely (`NODE_EXTS`, `JVM_EXTS`, the doc comment, `EXTENSIONS_BY_KIND`). Leave `DOCS_EXTS` and below untouched.

`src/setup/lang/types.ts` — keep the alias (it leaves the lang detectors untouched) but restate it:

```ts
/** What a detector returns. Identical to `Component` since ENG-361 removed the persisted
 *  `extensions[]` — file-identity routing now derives from the stack registry at the point of use.
 *  The alias is kept because it names the role: a draft the engine validates and promotes. */
export type ComponentDraft = Component;
```

- [ ] **Step 2: Enumerate every fixture — by grep, not typecheck**

```bash
grep -rln "extensions" test --include="*.ts"    # THE authority: 15 files
bun run typecheck                                # a helper: catches ~12 of them
```

**Typecheck is not sufficient.** Three files defeat excess-property checking, and because zod strips the unknown key they keep **passing** with dead, misleading data:

| File | Why `tsc` cannot see it |
|---|---|
| `test/cli/preflight.test.ts:17-19` | `Omit<Profile["components"][number], "extensions"> & { extensions?: string[] }` — `Omit` of a key that no longer exists is a legal no-op, and the intersection re-adds it as optional |
| `test/dispatch/replay-harness.test.ts:11-21` | a named `const PY = {…}`, not a fresh literal at the call site |
| `test/setup/lang/php.test.ts:100-102,113-115` | `drafts.map((d) => ({ ...d, extensions: [".php"] }))` — spread result, no contextual type |

There is also a within-file miss: `test/setup/discover.test.ts` is flagged at `:43,:50` but not `:169` (`extensions: [] as string[]` in an un-annotated const).

- [ ] **Step 3: Sweep the fixtures**

Default action per file: **delete the `extensions:` property.** Exceptions:

- **`test/dispatch/stack-registry.test.ts`** — delete the Task-1 differential test and its `EXTENSIONS_BY_KIND` import, but **leave the `SNAPSHOT` literal's nine `extensions` entries alone**. A blanket sweep here produces `TS2769: Property 'extensions' is missing in type … but required in type 'StackFacts'`.
- **`test/dispatch/profile.test.ts:39-40`** asserts `p.components[0].extensions` directly. Replace with the behavior it stood in for — noting that this fixture's `paths` is `["src-tauri/**"]`, so the file path must match that glob or the assertion fails for an unrelated reason:
  ```ts
  expect(matchesComponent(p.components[0], "src-tauri/main.rs")).toBe(true);
  expect(matchesComponent(p.components[0], "src-tauri/main.py")).toBe(false);
  ```
  Add `import { matchesComponent } from "../../src/dispatch/components.ts";` in sorted position.
- **`test/cli/preflight.test.ts`** — delete the `ComponentInput` alias (`:17-19`) and its now-false comment; change `makeProfile`'s parameter to `Profile["components"]`. **Coordinate with ENG-344**, whose Task 2 adds fixtures to this same file using `const base = { paths: ["**"], extensions: [] }` — that `extensions: []` goes too.
- **`test/dispatch/components.test.ts`** — delete the `EXTENSIONS_BY_KIND` assertions (`:59-66`, `:177-180`, `:200-201`). Retire or rename `:112-121` (`"extMatches: undefined or empty extensions → path-only fallback"`): `extMatches` no longer reads `c.extensions`, so its `{...noExts, extensions: undefined} as unknown as Component` cast asserts nothing — what it now measures is "an unmodeled kind routes by path alone". Also convert Task 2's `as unknown as Component` casts to plain `const c: Component = {…}` literals, matching this file's convention.
- **`test/dispatch/replay-harness.test.ts:11-21`** and **`test/setup/lang/php.test.ts:100-102,113-115`** — delete the key *and* the comments describing `extensions` as required / "mirrors what runRegistry does", which this task falsifies.

- [ ] **Step 4: Verify nothing still references the deleted symbols**

```bash
grep -rn "EXTENSIONS_BY_KIND" src test || true
grep -rln "extensions" test --include="*.ts" || true
```
The first must be empty. The second should list only `test/dispatch/stack-registry.test.ts` (the `SNAPSHOT`). `grep` exits 1 on no match, hence `|| true`.

- [ ] **Step 5: Full suite**

```bash
bun run format && bun run lint && bun run typecheck && bun test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove Component.extensions from the profile (ENG-361)

The field, both materialization sites (runRegistry, mergeComponents), and
EXTENSIONS_BY_KIND are deleted. File-identity routing derives from the stack
registry at the point of use, so the fact exists in exactly one place.

Old profiles are unaffected: zod strips the now-unknown key.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 5: Derive `SOURCE_EXTS` from the same field

**Files:**
- Modify: `src/dispatch/check-rules.ts:1-20`
- **Create:** `test/dispatch/check-rules.test.ts` — it does not exist today (unless ENG-359 created it)

**Interfaces:**
- Consumes: `STACKS` from Task 1.
- Produces: no export change — `SOURCE_EXTS` stays module-private; `moduleLeaf` keeps its signature.

- [ ] **Step 1: Write the test**

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

  // The eight the hand-maintained set was missing. ENG-359 fixes these
  // independently; deriving from the registry makes the drift unrepresentable.
  test("the eight the drift was missing", () => {
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

- [ ] **Step 2: Run it**

Run: `bun test test/dispatch/check-rules.test.ts`
Expected: **FAIL** on *"the eight"* (`expected "button", got "svelte"`) — unless ENG-359 landed first, in which case PASS. Record which you saw; it determines the commit message and the PR's behavior-change list. The other two tests pass either way as regression guards.

- [ ] **Step 3: Derive**

Replace `src/dispatch/check-rules.ts` lines 1-20:

```ts
import type { CheckFramework } from "./check-selector.ts";
import { STACKS } from "./stack-registry.ts";

/** Source-file extensions stripped when reducing a path or module reference to its leaf name.
 *  Derived from the stack registry (dot-less, since `moduleLeaf` splits on ".") so it can never
 *  again drift from the extensions that drive routing — as a hand-maintained set it had already
 *  fallen eight extensions behind. */
const SOURCE_EXTS = new Set(
  Object.values(STACKS).flatMap((f) => f.extensions.map((e) => e.replace(/^\./, ""))),
);
```

- [ ] **Step 4: Run the checks suite**

Run: `bun test test/dispatch/`
Expected: PASS. If a check-matching test fails on a `.svelte`/`.gradle` path, that is the drift being corrected — update the expectation and record it.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/check-rules.ts test/dispatch/check-rules.test.ts
git commit -m "refactor(checks): derive SOURCE_EXTS from the stack registry (ENG-361)

SOURCE_EXTS and the routing extension list answered the same question from
two hand-maintained tables. Deriving both from the registry makes the drift
unrepresentable rather than merely fixed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 6: Documentation and whole-branch verification

**Files:**
- Modify: `docs/architecture/configuration.md:103,108,128`, `docs/architecture/conventions.md`

- [ ] **Step 1: Update the profile reference**

`docs/architecture/configuration.md`:
- **:103** — `schemaVersion` is no longer "pinned to `3`". Replace with: *"`schemaVersion` accepts `3` or `4` and is normalized to `4` on load; a v1 (`commands`) or v2 profile is rejected with a re-run message, and a version above 4 is rejected as written by a newer styre. A v4 profile no longer carries per-component `extensions[]` — file-identity routing derives from the stack registry (`src/dispatch/stack-registry.ts`) at the point of use."*
- **:108** table row — `literal 3` → `3 or 4 (normalized to 4)`.
- **:128** — delete the `extensions` row.

- [ ] **Step 2: Update the registry doc**

Append to the language-stack-registry section in `docs/architecture/conventions.md`:

```markdown
**Registry facts are never persisted into `profile.json`.** The profile records what setup *decided*
about this repo — its components, their commands, their install step. The registry records what is
*true of an ecosystem*. Persisting the latter creates two copies with different lifecycles: the
profile is written once, while the registry ships with whichever binary is running, so a registry
change would leave existing profiles disagreeing with it.

`extensions` was persisted until ENG-361 and is now derived at the point of use. `testFilePattern`
(`profile.ts:101`) is the next candidate — php and ruby emit it as a fixed per-ecosystem string, so
it is a registry fact currently living in the profile; it moves under this same rule when the
framework-keyed half lands.
```

- [ ] **Step 3: Write the PR title and body**

Do **not** hand-edit `CHANGELOG.md` — it is generated by git-cliff from commit subjects, has no unreleased heading, and a hand-added block is clobbered at the next release. The repo squash-merges, so the **PR title** becomes the changelog line.

Title: `feat(profile)!: derive component extensions from the stack registry (schemaVersion 4)`

Body must cover:

```markdown
Per-component `extensions[]` is no longer written to `profile.json`; file-identity routing derives
from the language stack registry at run time.

**Existing profiles keep working** — schemaVersion 3 is accepted and normalized to 4, so no
regeneration is required.

**An older styre binary will refuse a v4 profile** with a validation error rather than mis-routing.
Upgrade the binary, or re-run `styre setup`.

**Residuals:**
- A hand-edited profile carrying custom `extensions[]` has them silently stripped. `profile.ts:80-82`
  states the profile is hand-editable, so this was undocumented as an override rather than
  forbidden — a warn-on-strip in `parseProfile` would make it a visible migration.
- A profile written before ENG-362, whose `kind` was refined by the discovery agent, may route
  differently: `mergeComponents` applied the agent's `kind` while keeping the scan's `extensions`,
  so stored and derived could disagree. Re-run `styre setup` to repair.
```

- [ ] **Step 4: Full verification**

```bash
bun run format && bun run lint && bun run typecheck && bun test && bun run build
```

- [ ] **Step 5: Round-trip a real old profile**

The one thing unit tests cannot prove — that a previously-written profile still works end to end:

```bash
cat > /tmp/eng361-v3-profile.json <<'JSON'
{
  "schemaVersion": 3,
  "slug": "legacy",
  "targetRepo": "/tmp/eng361-repo",
  "defaultBranch": "main",
  "checksSystem": "none",
  "components": [
    { "name": "rust", "kind": "rust", "paths": ["**"], "commands": {}, "extensions": [".rs"] }
  ],
  "repoCommands": {},
  "promptVars": {},
  "runtimeContext": {}
}
JSON
bun -e '
  const { loadProfile } = await import("./src/dispatch/profile.ts");
  const { matchesComponent } = await import("./src/dispatch/components.ts");
  const p = loadProfile("/tmp/eng361-v3-profile.json");
  console.log("schemaVersion:", p.schemaVersion);
  console.log("has extensions key:", "extensions" in p.components[0]);
  console.log("routes .rs:", matchesComponent(p.components[0], "src/main.rs"));
  console.log("routes .py:", matchesComponent(p.components[0], "src/main.py"));
'
```
Expected exactly:
```
schemaVersion: 4
has extensions key: false
routes .rs: true
routes .py: false
```

- [ ] **Step 6: Commit and push**

```bash
git add docs/
git commit -m "docs: profile schemaVersion 4 and the no-persisted-facts rule (ENG-361)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
git push
```

---

## Acceptance criteria trace

| Ticket AC | Task |
|---|---|
| `extensions` absent from `ComponentSchema`, `Component`, and every written profile | 4 |
| `extMatches` derives from the registry; routing unchanged for all 9 kinds and unmodeled kinds | 2, 6 Step 5 |
| `EXTENSIONS_BY_KIND` deleted; `SOURCE_EXTS` derived from the same field | 4, 5 |
| `schemaVersion` is 4; `parseProfile` accepts 3 and 4; a v3 file's stored `extensions` ignored | 3, 4 |
| A test proves the version guard works | 3 (the too-new pre-check — the same guard a v3 binary applies to a v4 file, testable from this side) |
| v2 error message updated; too-new pre-check added | 3 |
| Unmodeled-kind-with-stored-extensions residual has a test | 2 |
| Stale doc comment at `lang/types.ts:3` updated | 4 |
| Migration residuals recorded for the changelog | 6 Step 3 (PR body) |
| `format` + `lint` + `typecheck` + `test` green | every task; final in 6 |

## Behavior changes for the PR body

1. **Older styre binaries reject profiles written by this version**, with a validation error naming `schemaVersion`. Intended — the alternative is silent over-routing.
2. **A hand-edited profile's custom `extensions[]` is silently stripped.** `profile.ts:80-82` says the profile is hand-editable, so this was undocumented rather than forbidden; the silence is the sharp edge.
3. **A profile written before ENG-362 whose `kind` was agent-refined may route differently.** ENG-362 closes the source but does not repair profiles already on disk; re-running `styre setup` does.
4. **A profile with no `schemaVersion` key** is now read as 4 rather than 3. Harmless — extensions are ignored either way.
5. **`moduleLeaf` gains eight extensions**, unless ENG-359 landed first. Prefer landing ENG-359 so this PR is a clean no-op.

Everything else is behavior-preserving for profiles written after ENG-362: the derived extension list equals the stored one for every kind whose `kind` was not agent-refined, which Task 1 asserts differentially against the live table before deleting it.
