# Stop Persisting Component File Extensions Implementation Plan (ENG-361)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `Component.extensions` from `profile.json` and derive file-identity routing from the stack registry at the point of use, so the same ecosystem fact stops existing in two places with different lifecycles.

**Architecture:** `extensions` moves into `src/dispatch/stack-registry.ts`. `extMatches` reads it live instead of reading a value frozen into the profile at `styre setup` time. The schema field, both materialization sites, and `EXTENSIONS_BY_KIND` are deleted. `schemaVersion` goes 3 → 4 so a stale binary rejects a new profile loudly instead of silently over-routing; old profiles keep working because the parser accepts 3 and normalizes it to 4.

**Tech Stack:** TypeScript on Bun. Tests are `bun test`. Lint is `bun run lint` (Biome); types are `bun run typecheck` (`tsc --noEmit --strict`).

**Blocked by:** ENG-344 — `src/dispatch/stack-registry.ts` must exist with `STACKS`, `stackFacts`, `isModeledKind` and its boundary tests (including the literal `SNAPSHOT`).

**Sibling, independent — either order:** ENG-360 (the mechanical fold of provision/manifests/skip-dirs/runtime-deps). It touches no file this plan touches.

**Land ENG-359 first if you can.** It fixes the `SOURCE_EXTS` drift (8 missing extensions) in ~2 lines. If it has landed, Task 5 here is a pure no-op refactor. If it has not, Task 5 silently carries that bug fix and stops being reviewable as a no-op.

**Spec:** `docs/brainstorms/2026-07-22-eng-344-language-stack-registry-design.md` §6b.

## Why

`Component.extensions[]` is materialized at `styre setup` time (`detect-components.ts:28`) into `profile.json`, which is committed and shipped to CI runners and fleet workers. Once `EXTENSIONS_BY_KIND` moves into the registry, the same fact also lives in the running binary and is read live by check-matching.

Add `.vue` to the registry tomorrow: a repo whose profile was written last month still routes without it, while `moduleLeaf` — reading the registry — treats it as a source file. Two halves of one run disagreeing about one fact. That is the bug class this whole effort exists to delete, and the registry would have recreated it.

The operator chose to remove the second copy outright rather than document an invariant against it (design §6b), because an invariant makes drift *discouraged* rather than *impossible*.

## Global Constraints

- **Never commit to `main`.** Branch `refactor/eng-361-extensions-not-persisted`. No `gh pr merge`, ever.
- **Every task ends green with `bun run format && bun run lint && bun run typecheck && bun test`** — all four. `bun run lint` is `biome check .` (no `--write`) and the repo enforces `lineWidth: 100` + `organizeImports`, so hand-wrapped pasted code FAILS lint unless formatted first. `bun run typecheck` is what CI runs (`.github/workflows/ci.yml:18`); Biome does not type-check and `bun test` strips types. **Typecheck matters more than usual here** — Task 4 removes a field from a widely-constructed type, and object-literal excess-property errors are the mechanism that finds every fixture.
- **Import placement and order.** Biome sorts specifiers naturally, so `"bun:test"` sorts BEFORE `"node:fs"`. Never add an import mid-file — merge into the existing import statement for that module.
- **Task order is load-bearing.** The version bump (Task 3) must land *before* the field deletion (Task 4). Reversed, there is a window where `styre setup` writes a profile with no extension list still marked v3, which a stale binary reads as "match every file". Do not reorder these.
- **Do NOT touch** `src/dispatch/check-selector.ts` or `check-rules.ts:349` (`CHECK_RULES`) — PR 2's job. Do NOT touch `src/dispatch/provision.ts`, `src/setup/manifests.ts`, `src/dispatch/worktree.ts`, or `src/setup/runtime-deps/` — ENG-360's job.
- **Regenerate the registry `SNAPSHOT`, never hand-edit it:**
  `bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log(JSON.stringify(m.STACKS, null, 2)))'`
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
| `src/setup/lang/types.ts` | modify | `ComponentDraft` doc updated (Task 4) |
| `src/dispatch/check-rules.ts` | modify | `SOURCE_EXTS` derived (Task 5) |
| `docs/architecture/configuration.md` | modify | Profile reference updated (Task 6) |
| ~15 test files | modify | Fixture sweep (Task 4) |

---

### Task 1: Add `extensions` to the registry

**Files:**
- Modify: `src/dispatch/stack-registry.ts`
- Test: `test/dispatch/stack-registry.test.ts`

**Interfaces:**
- Consumes: `STACKS`, `stackFacts` (from ENG-344).
- Produces: `StackFacts.extensions: readonly string[]`. Tasks 2 and 5 read it.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/stack-registry.test.ts`. This is **differential**, not transcribed — `EXTENSIONS_BY_KIND` still exists at this point, so compare against the live table. A hand-copied literal would pass even if the same transcription error were made in both places. Delete this test in Task 4, when the table it compares against goes away.

```ts
// merge into the existing import block at the top of the file:
import { EXTENSIONS_BY_KIND } from "../../src/dispatch/components.ts";

test("extensions match today's live EXTENSIONS_BY_KIND exactly", () => {
  for (const [kind, exts] of Object.entries(EXTENSIONS_BY_KIND)) {
    expect(stackFacts(kind).extensions).toEqual([...exts]);
  }
  // and the registry covers exactly the same kinds — neither table has an entry the other lacks
  expect(Object.keys(EXTENSIONS_BY_KIND).sort()).toEqual(Object.keys(STACKS).sort());
});

test("an unmodeled kind has no extensions -> path-only routing", () => {
  expect(stackFacts("elixir").extensions).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: FAIL — `stackFacts(...).extensions` is `undefined`, so `toEqual` reports `undefined` vs the expected array.

- [ ] **Step 3: Add the field**

In `src/dispatch/stack-registry.ts`, add to `StackFacts`:

```ts
  /** File extensions owned by this kind, lower-case and dot-prefixed. Empty ⇒ path-only routing
   *  (a `kind` the registry does not model is routed by path globs alone). Read live by
   *  `extMatches` — deliberately NOT persisted into `profile.json`, because a profile is written
   *  once and shipped to CI/fleet workers while this table is read from the running binary, and
   *  two copies with different lifecycles is the drift this module exists to delete (design §6b). */
  readonly extensions: readonly string[];
```

Then populate all nine entries. The shared `NO_INSTALL_STEP` / `INSTALLS_NO_NAMED_TOOLS` constants from ENG-344 must now be **split**, because extensions differ per kind — that split was anticipated in ENG-344's Task 1 note.

```ts
const NODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"] as const;
const JVM_EXTS = [".java", ".kt", ".kts", ".scala", ".groovy"] as const;

/** Has an install step, but it provides no tool the command strings can name — npm/pnpm/yarn and
 *  `bundle` are all preconditions. Spread into node/sveltekit/ruby, which differ only in extensions. */
const INSTALLS_NO_NAMED_TOOLS = { installBinDirs: [], installProvidedTools: [] } as const;
/** No install step at all: dependencies resolve inside the build invocation. */
const NO_INSTALL_STEP = { installBinDirs: [], installProvidedTools: [] } as const;

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

Also update `UNMODELED` to include `extensions: []`.

- [ ] **Step 4: Regenerate the snapshot and run**

```bash
bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log(JSON.stringify(m.STACKS, null, 2)))'
```
Replace the `SNAPSHOT` literal in `test/dispatch/stack-registry.test.ts` with the output (keeping the `const SNAPSHOT = ` prefix and trailing `;`).

Run: `bun test test/dispatch/stack-registry.test.ts`
Expected: PASS. If the differential test fails, the diff names the offending kind — fix the registry entry, never the assertion.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/stack-registry.ts test/dispatch/stack-registry.test.ts
git commit -m "feat(dispatch): add extensions to the stack registry (ENG-361)

Differentially asserted against the live EXTENSIONS_BY_KIND, which still
exists at this point — a hand-copied literal would pass even if the same
transcription error were made twice.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 2: `extMatches` derives from the registry

Behavior-identical: `EXTENSIONS_BY_KIND` still populates `Component.extensions`, and Task 1 proved the two agree. This step makes the field unread before Task 4 deletes it.

**Files:**
- Modify: `src/dispatch/components.ts:70-77`
- Test: `test/dispatch/components.test.ts`

**Interfaces:**
- Consumes: `stackFacts` from Task 1.
- Produces: `extMatches(c: Component, file: string): boolean` — signature unchanged, source of truth changed.

- [ ] **Step 1: Find fixtures whose stored extensions disagree with their kind**

This is the one place Task 2 can change behavior, so find it before writing code:

```bash
grep -rn "extensions:" test --include="*.ts"
```

For each hit, check the fixture's `kind` against the registry. A fixture with `kind: "custom"` and `extensions: [".x"]` currently filters to `.x`; after this task it routes by path alone (unmodeled kind → empty → unfiltered). Any such fixture must be updated **and the change noted in the commit body** — it is a genuine behavior difference for hand-authored profiles, which is the accepted residual in design §6b.2.

Expected: the real fixtures use kinds the registry models with matching extension lists, so most need no change. Verify rather than assume.

- [ ] **Step 2: Write the failing test**

Add to `test/dispatch/components.test.ts`:

```ts
// merge into the existing import block:
import { stackFacts } from "../../src/dispatch/stack-registry.ts";

test("routing follows the component's kind, not a stored extension list", () => {
  // A profile whose stored extensions have gone stale (an older binary, a hand edit)
  // must route by the registry, which is the whole point of ENG-361.
  const stale = {
    name: "fe", kind: "sveltekit", paths: ["**"], commands: {},
    extensions: [".ts"], // stale: missing .svelte
  } as unknown as Parameters<typeof matchesComponent>[0];
  expect(matchesComponent(stale, "src/App.svelte")).toBe(true);
});

test("an unmodeled kind routes by path alone", () => {
  const c = { name: "x", kind: "elixir", paths: ["lib/**"], commands: {} } as unknown as Parameters<
    typeof matchesComponent
  >[0];
  expect(matchesComponent(c, "lib/x.ex")).toBe(true);
  expect(matchesComponent(c, "other/x.ex")).toBe(false);
});

test("registry-backed kinds still filter by extension", () => {
  const c = { name: "py", kind: "python", paths: ["**"], commands: {} } as unknown as Parameters<
    typeof matchesComponent
  >[0];
  expect(matchesComponent(c, "a/b.py")).toBe(true);
  expect(matchesComponent(c, "a/b.rs")).toBe(false);
  expect(stackFacts("python").extensions).toContain(".py"); // guards against a vacuous pass
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/dispatch/components.test.ts`
Expected: FAIL on "routing follows the component's kind" — today `extMatches` reads the stale `[".ts"]` and returns `false` for `App.svelte`.

- [ ] **Step 4: Derive**

In `src/dispatch/components.ts`, replace `extMatches` (lines 70-77):

```ts
/** True iff `file`'s extension belongs to the component's `kind`, per the stack registry — or the
 *  kind has no extensions (unmodeled/custom → path-only routing, unfiltered).
 *
 *  Reads the registry LIVE rather than a value frozen into `profile.json` at setup time. A profile
 *  is written once and shipped to CI runners and fleet workers; the registry ships with the running
 *  binary. Persisting this fact meant the two could disagree — adding an extension would leave every
 *  deployed profile routing without it (ENG-361, design §6b). */
export function extMatches(c: Component, file: string): boolean {
  const exts = stackFacts(c.kind).extensions;
  if (exts.length === 0) return true;
  return exts.includes(extname(file).toLowerCase());
}
```

Add `import { stackFacts } from "./stack-registry.ts";` to the existing import block at the top.

- [ ] **Step 5: Run tests**

Run: `bun test test/dispatch/ test/setup/`
Expected: PASS. A failure here is a fixture found in Step 1 — update it and record it.

- [ ] **Step 6: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/components.ts test/dispatch/components.test.ts
git commit -m "refactor(dispatch): route by registry extensions, not the stored list (ENG-361)

extMatches reads stackFacts(kind).extensions instead of Component.extensions.
Behavior-identical today — EXTENSIONS_BY_KIND still populates the field and
Task 1 proved the two agree — but the field is now unread, so Task 4 can
delete it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 3: Bump `schemaVersion` 3 → 4

**This must land before Task 4.** See the note below on why the ordering is load-bearing.

**Files:**
- Modify: `src/dispatch/profile.ts:110-145`
- Test: `test/dispatch/profile.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Profile["schemaVersion"]` is the literal `4`. `parseProfile` accepts input `3` or `4` and always yields `4`.

**Why the bump exists, and why the normalization is not optional.**

The bump does *not* protect new binaries reading old files — that direction is safe. It protects against a **stale binary reading a new file**. A v4 file omits `extensions`; the v3 schema defaults it to `[]`; and `extMatches` treats an empty list as *match every file* (`components.ts:75`). A stale binary would silently over-route every component against every changed file — wrong attribution, wrong verify scope, no error. `ProfileSchema.schemaVersion` is `z.literal(3)`, so a v3 binary reading a v4 file already fails loudly. The bump costs one line and buys exactly that.

**Accepting 3 is safe** because the derived extension list equals the stored one by construction for all nine kinds (Task 1 asserts precisely that), and both are empty for an unrecognised kind. So no deployed profile needs regenerating.

**But acceptance alone is a trap.** `styre setup` re-reads an existing profile to carry its `analyticsId` forward (`setup.ts:120-126`) and writes the result. If a parsed v3 profile kept `schemaVersion: 3`, that rewrite would emit a file with **no extension list still marked v3** — precisely the silent over-routing the bump exists to prevent, manufactured by our own write path. So the parser must **normalize to 4**, not merely accept 3.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/profile.test.ts`:

```ts
test("a schemaVersion-3 profile is accepted and normalized to 4", () => {
  const p = parseProfile({
    schemaVersion: 3,
    slug: "s", targetRepo: "/r", defaultBranch: "main", checksSystem: "none",
    components: [{ name: "rust", kind: "rust", paths: ["**"], commands: {}, extensions: [".rs"] }],
    repoCommands: {}, promptVars: {}, runtimeContext: {},
  });
  // Normalized, NOT preserved: styre setup re-reads and rewrites a profile to carry
  // analyticsId forward (setup.ts:120-126). Preserving 3 would emit a file with no
  // extension list still marked v3 — which a stale binary reads as "match every file".
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

test("an unknown future schemaVersion is rejected", () => {
  // This is the guard the bump exists for, from the other side: exactly as a v3
  // binary rejects a v4 profile, this binary rejects a v5 one — loudly, rather
  // than defaulting a missing field into silently over-broad routing.
  expect(() =>
    parseProfile({
      schemaVersion: 5,
      slug: "s", targetRepo: "/r", defaultBranch: "main", checksSystem: "none",
      components: [], repoCommands: {}, promptVars: {}, runtimeContext: {},
    }),
  ).toThrow();
});

test("schemaVersion 1 and 2 keep their existing bespoke errors", () => {
  expect(() => parseProfile({ commands: {} })).toThrow(/schemaVersion 1/);
  expect(() => parseProfile({ schemaVersion: 2 })).toThrow(/schemaVersion 2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/profile.test.ts`
Expected: FAIL — the v3 test gets `3` not `4`, and the v4 test throws (`z.literal(3)` rejects `4`).

- [ ] **Step 3: Bump and normalize**

In `src/dispatch/profile.ts`, replace the `schemaVersion` line (`:116`):

```ts
  /** Accepts 3 or 4 on input and ALWAYS yields 4. Normalization is not cosmetic: `styre setup`
   *  re-reads an existing profile to carry `analyticsId` forward (`setup.ts:120-126`) and writes
   *  the result, so a preserved `3` would emit a file with no `extensions[]` still marked v3 — and
   *  a v3 binary reads a missing extension list as "match every file" (`components.ts:75`),
   *  silently over-routing every component. Accepting 3 means no deployed profile needs
   *  regenerating: the derived extension list equals the stored one by construction. */
  schemaVersion: z
    .union([z.literal(3), z.literal(4)])
    .default(4)
    .transform(() => 4 as const),
```

Update the two doc comments above `ComponentSchema` (`:92-95`) and `ProfileSchema` (`:113-114`) to describe 4, and the schemaVersion-1 error text (`:136`) to say "schemaVersion-4 profile".

Leave the bespoke v1/v2 pre-checks (`:133-144`) exactly as they are — they give better messages than a bare union failure, and their wording about `extensions[]` is still accurate history for why v2 was rejected.

- [ ] **Step 4: Run tests**

Run: `bun test test/dispatch/profile.test.ts test/cli/ test/setup/`
Expected: PASS. Fixtures asserting `schemaVersion: 3` on a *parsed* profile now see `4` — update them; that is the change. Fixtures *supplying* `3` as input still work untouched.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
bun run format && bun run lint && bun run typecheck && bun test
git add src/dispatch/profile.ts test/dispatch/profile.test.ts test/
git commit -m "feat(profile): bump schemaVersion to 4, accepting and normalizing 3 (ENG-361)

Lands BEFORE the extensions field is removed. A v4 profile omits
extensions[], and a v3 binary defaults that to [] which extMatches reads as
'match every file' — silent over-routing. schemaVersion is a zod literal, so
a v3 binary rejects a v4 profile loudly. That is what the bump buys.

Accepting 3 means no deployed profile needs regenerating: the derived
extension list equals the stored one by construction.

Normalizing 3 -> 4 is not cosmetic. styre setup re-reads a profile to carry
analyticsId forward and rewrites it; preserving 3 would emit a file with no
extension list still marked v3, manufacturing the exact hazard the bump
exists to prevent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 4: Delete the field and both materialization sites

**Files:**
- Modify: `src/dispatch/profile.ts:102`, `src/dispatch/components.ts:4-20`, `src/setup/detect-components.ts:3,13,28`, `src/setup/discover-schema.ts:43`, `src/setup/lang/types.ts:3-5`
- Test: the fixture sweep below (~15 files)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Component` no longer has `extensions`. `EXTENSIONS_BY_KIND` no longer exists. `ComponentDraft` is now structurally identical to `Component`.

- [ ] **Step 1: Delete the schema field and the writers**

`src/dispatch/profile.ts` — delete line 102 (`extensions: z.array(z.string()).default([]),`).

> Zod objects strip unknown keys by default, so an old profile still carrying `extensions` parses cleanly and the key is dropped. That is the "silently ignored" behavior design §6b.2 accepts — no extra code needed.

`src/setup/detect-components.ts` — drop the `EXTENSIONS_BY_KIND` import (line 3), and line 28 becomes:

```ts
      out.push({ ...c, paths });
```

Update the `runRegistry` doc comment (line 13) — delete the sentence about attaching `extensions`.

`src/setup/discover-schema.ts` — delete line 43 (`extensions: s.extensions,`). (`DiscoverSchema` never carried `extensions`, so the agent could not author it; this line only propagated the scan's own value.)

`src/dispatch/components.ts` — delete lines 4-20 entirely: `NODE_EXTS`, `JVM_EXTS`, the doc comment, and `EXTENSIONS_BY_KIND`. Leave `DOCS_EXTS` and everything below untouched.

`src/setup/lang/types.ts` — the alias stays (it keeps the lang detectors unchanged) but its meaning has changed:

```ts
/** What a detector returns. Identical to `Component` since ENG-361 removed the persisted
 *  `extensions[]` — file-identity routing now derives from the stack registry at the point of use.
 *  The alias is kept because it names the role: a draft the engine validates and promotes. */
export type ComponentDraft = Component;
```

- [ ] **Step 2: Run typecheck to enumerate every fixture**

```bash
bun run typecheck
```
Expected: **many** `TS2353` / excess-property errors across `test/`. That is the mechanism, not a problem — TypeScript is listing every fixture that constructs a `Component` with an `extensions` key. Roughly 15 files:

```bash
grep -rln "extensions" test --include="*.ts"
```

- [ ] **Step 3: Sweep the fixtures**

For each file, **delete the `extensions:` property from the fixture**. Do not replace it with anything — routing now comes from `kind`.

Two files need more than deletion:

- **`test/dispatch/profile.test.ts:39-40`** asserts `p.components[0].extensions` directly. Those assertions cannot survive; replace them with the behavior they were standing in for:

  ```ts
  // was: expect(p.components[0].extensions).toEqual([".rs"]);
  expect(matchesComponent(p.components[0], "src/main.rs")).toBe(true);
  expect(matchesComponent(p.components[0], "src/main.py")).toBe(false);
  ```
  (Import `matchesComponent` from `../../src/dispatch/components.ts`, merged into the existing import block.)

- **`test/dispatch/stack-registry.test.ts`** — delete the differential test added in Task 1 Step 1 and its `EXTENSIONS_BY_KIND` import. The table it compared against no longer exists; the `SNAPSHOT` test now carries that duty.

- **`test/dispatch/components.test.ts`** — its `EXTENSIONS_BY_KIND` assertions (around lines 59-66, 177-180, 200-201) go too. The registry's own tests cover the table's contents; this file should assert *routing*, which the Task 2 tests already do.

- [ ] **Step 4: Verify nothing still references the deleted symbols**

```bash
grep -rn "EXTENSIONS_BY_KIND" src test || true
grep -rn "\.extensions" src test --include="*.ts" || true
```
Expected: **no output** from the first. The second should show only `stackFacts(...).extensions` uses and the registry's own field. `grep` exits 1 when it matches nothing, hence `|| true`.

Also fix the now-stale doc comment at **`src/setup/lang/types.ts:3`**, which said "materialized from `EXTENSIONS_BY_KIND`" — Step 1 already replaces it, but confirm no other doc comment mentions the deleted symbol.

- [ ] **Step 5: Run the full suite**

```bash
bun run format && bun run lint && bun run typecheck && bun test
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove Component.extensions from the profile (ENG-361)

The field, both materialization sites (runRegistry, mergeComponents), and
EXTENSIONS_BY_KIND are deleted. File-identity routing derives from the stack
registry at the point of use, so the fact exists in exactly one place.

Old profiles are unaffected: zod strips the now-unknown key, and the derived
list equals the stored one by construction for every kind.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 5: Derive `SOURCE_EXTS` from the same field

**Files:**
- Modify: `src/dispatch/check-rules.ts:1-20`
- Test: `test/dispatch/check-rules.test.ts` (create if ENG-359 has not already)

**Interfaces:**
- Consumes: `STACKS` from Task 1.
- Produces: no export change — `SOURCE_EXTS` stays module-private; `moduleLeaf` keeps its signature.

**If ENG-359 has landed**, this is a pure no-op refactor: the sets are already equal, and the test below should pass before and after Step 3. **If it has not**, this task silently fixes that bug — say so in the commit body rather than letting it ride.

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

  // All EIGHT the hand-maintained set was missing. ENG-359 fixes these
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
Expected: **PASS** if ENG-359 landed; **FAIL** on the eight otherwise (`expected "button", got "svelte"`). Record which you saw — it determines the commit message.

- [ ] **Step 3: Derive**

Replace `src/dispatch/check-rules.ts` lines 1-20:

```ts
import type { CheckFramework } from "./check-selector.ts";
import { STACKS } from "./stack-registry.ts";

/** Source-file extensions stripped when reducing a path or module reference to its leaf name.
 *  Derived from the stack registry (dot-less, since `moduleLeaf` splits on ".") so it can never
 *  again drift from the extensions that drive routing — before ENG-361 this was a hand-maintained
 *  set that had already fallen eight extensions behind. */
const SOURCE_EXTS = new Set(
  Object.values(STACKS).flatMap((f) => f.extensions.map((e) => e.replace(/^\./, ""))),
);
```

- [ ] **Step 4: Run the checks suite**

Run: `bun test test/dispatch/`
Expected: PASS. If a check-matching test fails on a `.svelte`/`.gradle` path and ENG-359 has *not* landed, that is the drift being corrected — update the expectation and record it in the commit body.

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

### Task 6: Documentation, changelog, and whole-branch verification

**Files:**
- Modify: `docs/architecture/configuration.md:103,108,128`, `docs/architecture/conventions.md`, `CHANGELOG.md`

- [ ] **Step 1: Update the profile reference**

`docs/architecture/configuration.md` — three edits:

- **line 103**: `schemaVersion` is no longer "pinned to `3`". Replace with: *"`schemaVersion` accepts `3` or `4` and is normalized to `4` on load; a v1 (`commands`) or v2 profile is rejected with a re-run message. A `4` profile no longer carries per-component `extensions[]` — file-identity routing derives from the stack registry (`src/dispatch/stack-registry.ts`) at the point of use."*
- **line 108** table row: `literal 3` → `3 or 4 (normalized to 4)`.
- **line 128**: delete the `extensions` row — the field no longer exists in the profile.

- [ ] **Step 2: Update the registry doc**

In `docs/architecture/conventions.md`, under the language-stack-registry section ENG-344 added, append:

```markdown
**Registry facts are never persisted into `profile.json`.** The profile records what setup *decided*
about this repo — its components, their commands, their install step. The registry records what is
*true of an ecosystem*. Persisting the latter creates two copies with different lifecycles: the
profile is written once and shipped to CI runners and fleet workers, while the registry ships with
the running binary, so a registry change would leave every deployed profile disagreeing with it.

`extensions` was persisted until ENG-361 and is now derived at the point of use. `testFilePattern`
(`profile.ts:101`) is the next candidate — php and ruby emit it as a fixed per-ecosystem string, so
it is a registry fact currently living in the profile; it moves under this same rule when the
framework-keyed half lands.
```

- [ ] **Step 3: Changelog**

Add under the unreleased heading, matching the file's existing style:

```markdown
- **Profile `schemaVersion` 4.** Per-component `extensions[]` is no longer written to
  `profile.json`; file-identity routing derives from the language stack registry at run time.
  Existing v3 profiles are accepted unchanged and normalized to v4 on load — **no regeneration
  required**. An older styre binary will now refuse a v4 profile with a validation error rather than
  mis-route; re-run `styre setup` or upgrade the binary. *Residual:* a hand-edited profile carrying
  custom `extensions[]` has them ignored — the field was always machine-written (absent from the
  discovery schema, so the agent could never author it), so hand-editing was never supported.
```

- [ ] **Step 4: Full verification**

```bash
bun run format && bun run lint && bun run typecheck && bun test && bun run build
```
Expected: all green; the build produces the binary.

- [ ] **Step 5: Round-trip an old profile against the built binary**

The one thing the unit tests cannot prove — that a real, previously-written profile still works:

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
git add docs/ CHANGELOG.md
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
| `extMatches` derives from the registry; routing unchanged for all 9 kinds and unmodeled kinds | 2 (tests), 6 Step 5 (round-trip) |
| `EXTENSIONS_BY_KIND` deleted; `SOURCE_EXTS` derived from the same field | 4, 5 |
| `schemaVersion` is 4; `parseProfile` accepts 3 and 4; a v3 file's stored `extensions` ignored without error | 3, 4 Step 1 |
| A test proves the version guard works | 3 ("an unknown future schemaVersion is rejected" — the same guard a v3 binary applies to a v4 file, testable from this side) |
| Stale doc comment at `lang/types.ts:3` updated | 4 |
| Changelog notes the hand-edited-`extensions` residual | 6 |
| `format` + `lint` + `typecheck` + `test` green | every task; final in 6 |

## Behavior changes to call out in the PR description

1. **Older styre binaries reject profiles written by this version** (validation error naming `schemaVersion`). Intended — it is the whole point of the bump, and the alternative is silent over-routing. Operators upgrade the binary or re-run `styre setup`.
2. **A hand-edited profile's custom `extensions[]` is ignored.** The field was machine-written and absent from the discovery schema, so hand-editing was never supported. Changelogged.
3. **`moduleLeaf` gains eight extensions** — only if ENG-359 has not already landed. Prefer landing it first so this PR is a clean no-op.

Everything else is behavior-preserving by construction: the derived extension list equals the stored one for every kind, which Task 1 asserts differentially against the live table before deleting it.
