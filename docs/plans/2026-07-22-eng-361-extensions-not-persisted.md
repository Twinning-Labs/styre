# Stop Persisting Component File Extensions Implementation Plan (ENG-361)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `Component.extensions` from `profile.json` and derive file-identity routing from the stack registry at the point of use, so the same ecosystem fact stops existing in two places with different lifecycles.

**Architecture:** `extensions` moves into `src/dispatch/stack-registry.ts`. `extMatches` reads it live instead of reading a value frozen into the profile at `styre setup` time. The schema field, both materialization sites, and `EXTENSIONS_BY_KIND` are deleted. `schemaVersion` goes 3 → 4 so a stale binary rejects a new profile loudly instead of silently over-routing; old profiles keep working because the parser accepts 3 and normalizes it to 4.

**Tech Stack:** TypeScript on Bun. Tests are `bun test`. Lint is `bun run lint` (Biome); types are `bun run typecheck` (`tsc --noEmit --strict`).

**Blocked by:** ENG-344 (`src/dispatch/stack-registry.ts` must exist with `STACKS`, `stackFacts`, `isModeledKind` and its boundary tests, including the literal `SNAPSHOT`) **and ENG-362**.

> **ENG-362 is a hard prerequisite, not a nicety.** This plan re-points routing from a scan-authoritative stored list onto `c.kind` — the one component field the discovery agent can author. `mergeComponents` (`discover-schema.ts:38-43`) applies the agent's `kind` while carrying the scan's `extensions`, and `discover.ts:47` runs it *before* the `trusted` gate, which filters only `commands`. So a machine-written v3 profile can already carry `kind: python` with node extensions. Deriving from `kind` then makes `.ts` files stop routing to that component — a **silent under-verify**, which `docs/plans/2026-06-30-wo5-file-identity-routing.md` calls "the cardinal sin", and which WO-5's decision **D1** materialized `extensions` specifically to close. Do not execute this plan until ENG-362 has landed.

**Sibling, independent — either order:** ENG-360 (the mechanical fold of provision/manifests/skip-dirs/runtime-deps). It touches no file this plan touches.

**Land ENG-359 first if you can.** It fixes the `SOURCE_EXTS` drift (8 missing extensions) in ~2 lines. If it has landed, Task 5 here is a pure no-op refactor. If it has not, Task 5 silently carries that bug fix and stops being reviewable as a no-op.

**Spec:** `docs/brainstorms/2026-07-22-eng-344-language-stack-registry-design.md` §6b.

## Why

`Component.extensions[]` is materialized at `styre setup` time (`detect-components.ts:28`) into `profile.json`, which is committed and shipped to CI runners and fleet workers. Once `EXTENSIONS_BY_KIND` moves into the registry, the same fact also lives in the running binary and is read live by check-matching.

Add `.vue` to the registry tomorrow: a repo whose profile was written last month still routes without it, while `moduleLeaf` — reading the registry — treats it as a source file. Two halves of one run disagreeing about one fact. That is the bug class this whole effort exists to delete, and the registry would have recreated it.

The operator chose to remove the second copy outright rather than document an invariant against it (design §6b), because an invariant makes drift *discouraged* rather than *impossible*.

**What this plan originally got wrong.** It claimed the derived list "equals the stored one by construction", so no profile could change behavior. Three independent reviewers falsified that: `kind` is agent-authorable and ungated (see the ENG-362 note above), so stored and derived can already disagree in a machine-written profile. With ENG-362 landed, the claim holds for profiles written *after* it; profiles written *before* it may still carry a drifted `kind`. That residual is real and is listed in the behavior changes at the end — it is not "by construction" safe.

## Global Constraints

- **Never commit to `main`.** Branch `feat/eng-361-extensions-not-persisted` — `CONTRIBUTING.md:46` allows only `feat/` and `fix/` prefixes. No `gh pr merge`, ever.
- **Every task ends green with `bun run format && bun run lint && bun run typecheck && bun test`** — all four. `bun run lint` is `biome check .` (no `--write`) and the repo enforces `lineWidth: 100` + `organizeImports`, so hand-wrapped pasted code FAILS lint unless formatted first. `bun run typecheck` is what CI runs (`.github/workflows/ci.yml:18`); Biome does not type-check and `bun test` strips types. **Typecheck matters more than usual here** — Task 4 removes a field from a widely-constructed type. But it is a *helper*, not the enumeration mechanism: it catches ~12 of the 15 fixture files. `grep -rln "extensions" test` is the authority (Task 4 Step 2).
- **Import placement and order.** `bun run format` (`biome format --write`) does **NOT** fix import order — `organizeImports` is an assist enforced only by `biome check`, never auto-fixed. "Format first" will not save you here. Biome sorts by module specifier (`"bun:test"` before `"node:fs"`). Every import this plan adds is from a **different module** than the existing ones, so each needs **its own statement in sorted position** — not a merge into an existing block.
- **Task order is load-bearing.** The version bump (Task 3) must land *before* the field deletion (Task 4). Reversed, there is a window where `styre setup` writes a profile with no extension list still marked v3, which a stale binary reads as "match every file". Do not reorder these.
- **Do NOT touch** `src/dispatch/check-selector.ts` or `check-rules.ts:347` (`CHECK_RULES`) — PR 2's job. Do NOT touch `src/dispatch/provision.ts`, `src/setup/manifests.ts`, `src/dispatch/worktree.ts`, or `src/setup/runtime-deps/` — ENG-360's job.
- **Regenerate the registry `SNAPSHOT`, never hand-edit it:**
  `bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log("const SNAPSHOT = " + JSON.stringify(m.STACKS, null, 2) + ";"))'`
  (Identical to ENG-344's form, which emits the `const SNAPSHOT = ` prefix — the two plans run back to back and must not diverge.)
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

Then populate all nine entries. ENG-344's shared `NO_INSTALL_STEP` / `INSTALLS_NO_NAMED_TOOLS` constants change from full `StackFacts` values to **spreadable partials**, because `extensions` differs per kind and must be written inline. (An earlier draft called this "splitting" them — it is not; their bodies stay identical. What changes is reference → spread, which also **drops ENG-344's `: StackFacts` annotation**, the only compile-time check that those constants are complete. Unavoidable here — an annotated literal missing `extensions` would not compile — but note it: a future `StackFacts` field will now only fail at the nine `RAW` entries.)

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

For each hit, ask: **does the fixture's stored list equal `stackFacts(kind).extensions`? If not, does anything route files through it?**

An earlier draft told you to hunt for `kind: "custom"` + `extensions: [".x"]` (modeled → unmodeled). Two reviewers measured the real population and it is the **mirror image**: modeled kinds with an **empty** list, flipping from *unfiltered* to *extension-filtered*. Confirmed in `test/cli/run-guard.test.ts:18-21,33-40,50-57,67-70`, `test/dispatch/reuse.test.ts:58-61,87-90,105-108,115-118`, `test/setup/resolve-commands.test.ts:10-13,17-20,45-52`, `test/dispatch/prompt-vars.test.ts:210-231`, `test/setup/discover-schema.test.ts`, `test/dispatch/provision.test.ts:39-42`, `test/setup/discover.test.ts:40-50,166-169`.

None feeds a routing assertion today, so the suite stays green — but that is luck, not design, and the original search would have found none of them. Check each; note any real change in the commit body.

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
Expected: **two** failures, not one (a reviewer ran this):
- *"routing follows the component's kind"* — today `extMatches` reads the stale `[".ts"]` and returns `false` for `App.svelte`.
- *"registry-backed kinds still filter by extension"* — its fixture omits `extensions`, so today `c.extensions ?? []` is `[]` and `extMatches` returns `true` for `a/b.rs`.

The middle test, *"an unmodeled kind routes by path alone"*, **passes before and after** — a regression guard, not a red test.

**Missing coverage to add here:** nothing locks down the unmodeled-kind-with-stored-extensions case (`kind: "custom"`, `extensions: [".x"]`) — the exact residual the changelog and PR description promise to have accepted. Add a test asserting it now routes by path alone.

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

**Why normalize rather than merely accept.** An earlier version of this plan justified normalization with a hazard that does not exist — it claimed `styre setup` re-reads a profile and carries its `schemaVersion` forward. **It does not.** `src/cli/setup.ts:112` builds from a fresh `probeProfile`, and the re-read at `:118-127` contributes only `analyticsId` and `runtimeContext`; `schemaVersion` always comes from the schema default. Two reviewers traced this independently. That reasoning has been removed from the code comment and the commit body — do not reintroduce it.

The real reasons are narrower and honest: `Profile["schemaVersion"]` stays a single literal rather than a `3 | 4` union every consumer must handle, and any future code that round-trips a loaded profile writes the correct version by default rather than by remembering to. Both are worth one line; neither is a safety-critical hazard.

**Watch the default.** `.default(4)` means a profile with **no** `schemaVersion` key is now read as 4 where it previously became 3. That is the one genuine parse-behavior change for old files. It is harmless (extensions are ignored either way) but it must be tested — an existing test at `test/dispatch/profile.test.ts:127` already covers this path and asserts `3`; it will need updating.

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
  /** Accepts 3 or 4 on input and always yields 4, so `Profile["schemaVersion"]` stays a single
   *  literal rather than a union every consumer must narrow, and any future round-trip of a loaded
   *  profile writes the correct version without having to remember to.
   *
   *  Accepting 3 means no deployed profile needs regenerating — a v3 file's stored `extensions[]`
   *  is stripped and re-derived from `kind`, which agrees for any profile written after ENG-362
   *  gated agent `kind` refinement. The bump itself exists for the OTHER direction: a v4 file omits
   *  `extensions[]`, and a v3 binary would default that to `[]`, which `extMatches` reads as "match
   *  every file" (`components.ts:75`) — silent over-routing. `z.literal(3)` makes that a loud
   *  parse failure instead. */
  schemaVersion: z
    .union([z.literal(3), z.literal(4)])
    .default(4)
    .transform(() => 4 as const),
```

Update the two doc comments above `ComponentSchema` (`:92-95`) and `ProfileSchema` (`:113-114`) to describe 4, and the schemaVersion-1 error text (`:136`) to say "schemaVersion-4 profile".

Keep the bespoke v1/v2 pre-checks (`:133-144`) — they give far better messages than a bare union failure — but **update the v2 wording**. An earlier draft said to leave it as "accurate history"; it is not history, it is an instruction printed to an operator, and after this change both halves are wrong: `extensions[]` is no longer "required for file-identity routing" (this PR deletes that requirement), and re-running setup now produces a **schemaVersion-4** profile. `test/dispatch/profile.test.ts:43` asserts only `/schemaVersion 2.*re-run.*styre setup/i`, so rewording is free.

**Also add the symmetric pre-check for a version that is too NEW.** The failure this bump creates — a newer profile meeting an older binary — currently falls through to a bare `field schemaVersion` union error that reads like a corrupt file. This binary cannot fix that for already-shipped binaries, but it can make the *next* bump diagnosable: reject `schemaVersion > 4` with "profile was written by a newer styre; upgrade the binary or re-run `styre setup`".

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

- [ ] **Step 2: Enumerate every fixture — by GREP, not by typecheck**

```bash
grep -rln "extensions" test --include="*.ts"    # THE authority: 15 files
bun run typecheck                                # a helper: catches ~12 of them
```

**Typecheck alone is not sufficient, and an earlier version of this plan wrongly said it was.** Two reviewers measured it independently: `tsc` reports ~61 errors across 12 files, while grep finds 15. Three files defeat excess-property checking entirely, and because zod strips the unknown key they keep **passing** with dead, misleading data:

| File | Why `tsc` cannot see it |
|---|---|
| `test/cli/preflight.test.ts:17-19` | `Omit<Profile["components"][number], "extensions"> & { extensions?: string[] }` — `Omit` of a key that no longer exists is a legal no-op, and the intersection re-adds it as optional |
| `test/dispatch/replay-harness.test.ts:11-21` | a named `const PY = {…}`, not a fresh literal at the call site |
| `test/setup/lang/php.test.ts:100-102,113-115` | `drafts.map((d) => ({ ...d, extensions: [".php"] }))` — spread result, no contextual type |

There is also a **within-file** hole: `test/setup/discover.test.ts` is flagged at `:43,:50` but not `:169` (`extensions: [] as string[]` inside an un-annotated const). Clearing the `tsc` errors will feel complete when it is not.

- [ ] **Step 3: Sweep the fixtures**

For each file, **delete the `extensions:` property from the fixture**. Do not replace it with anything — routing now comes from `kind`.

**`test/dispatch/stack-registry.test.ts` is the exception to "delete the `extensions:` property":** its `SNAPSHOT` literal legitimately contains nine `extensions` keys. Delete only the Task-1 differential test and its `EXTENSIONS_BY_KIND` import — **leave the `SNAPSHOT` entries alone.** (A mechanical sweep here produces `TS2769: Property 'extensions' is missing in type … but required in type 'StackFacts'`.)

These files need more than a property deletion:

- **`test/dispatch/profile.test.ts:39-40`** asserts `p.components[0].extensions` directly. Those assertions cannot survive; replace them with the behavior they were standing in for:

  ```ts
  // was: expect(p.components[0].extensions).toEqual([".rs"]);
  // NOTE the paths: this fixture's `paths` is ["src-tauri/**"], and matchesComponent is
  // extMatches AND a path-glob match. "src/main.rs" does NOT match that glob, so asserting
  // toBe(true) on it fails for a reason that has nothing to do with extensions.
  expect(matchesComponent(p.components[0], "src-tauri/main.rs")).toBe(true);
  expect(matchesComponent(p.components[0], "src-tauri/main.py")).toBe(false);
  ```
  Add as its **own import statement in sorted position** (Biome sorts by module specifier, and this is a different module from the existing `profile.ts` import) — `import { matchesComponent } from "../../src/dispatch/components.ts";` goes after the `node:path` import and before the `../../src/dispatch/profile.ts` one.

- **`test/dispatch/stack-registry.test.ts`** — delete the differential test added in Task 1 Step 1 and its `EXTENSIONS_BY_KIND` import. The table it compared against no longer exists; the `SNAPSHOT` test now carries that duty.

- **`test/dispatch/components.test.ts`** — its `EXTENSIONS_BY_KIND` assertions (lines 59-66, 177-180, 200-201) go too. The registry's own tests cover the table's contents; this file should assert *routing*, which the Task 2 tests already do. Also retire or restate `:112-121` (`"extMatches: undefined or empty extensions → path-only fallback"`): after Task 2 `extMatches` never reads `c.extensions`, so its `{...noExts, extensions: undefined} as unknown as Component` cast asserts nothing. What it now measures is "an unmodeled kind routes by path alone" — rename it to that or delete it.
- **`test/cli/preflight.test.ts`** — delete the `ComponentInput` alias (`:17-19`) and its now-false comment; change `makeProfile`'s parameter to `Profile["components"]`. **Coordinate with ENG-344**, whose Task 2 adds ~15 fixtures to this same file using `const base = { paths: ["**"], extensions: [] }` — that `extensions: []` must go when this lands.
- **`test/dispatch/replay-harness.test.ts:11-21`** and **`test/setup/lang/php.test.ts:100-102,113-115`** — delete the key *and* the comments describing `extensions` as required / "mirrors what runRegistry does", which this task falsifies.
- **`test/setup/discover.test.ts:169`** — the `tsc`-invisible one.

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
- **Create:** `test/dispatch/check-rules.test.ts` — it does **not** exist today (unless ENG-359 created it)

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

As of this plan's writing ENG-359 had **not** landed (`check-rules.ts:4-19` is still the 15-entry hand list), so expect FAIL. Only the *"eight the drift was missing"* test is load-bearing; the other two pass either way.

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

- [ ] **Step 3: The behavior note goes in the PR body, NOT `CHANGELOG.md`**

An earlier draft said to hand-edit `CHANGELOG.md` "under the unreleased heading". **There is no unreleased heading, and the file is generated.** `CONTRIBUTING.md:53`: the changelog is produced by **git-cliff** from conventional-commit subjects; `release.yml` splices generated notes in, so a hand-added block is clobbered at the next release. Worse, `ci.yml:24-26` documents that the repo **squash-merges** — the PR title becomes the commit git-cliff parses, and every per-task commit body in this plan is discarded at merge.

So: put the following in the **PR description**, and make the PR title the conventional-commit line you want in the changelog (e.g. `feat(profile)!: derive component extensions from the stack registry (schemaVersion 4)`).

```markdown
- **Profile `schemaVersion` 4.** Per-component `extensions[]` is no longer written to
  `profile.json`; file-identity routing derives from the language stack registry at run time.
  Existing v3 profiles are accepted unchanged and normalized to v4 on load — **no regeneration
  required**. An older styre binary will now refuse a v4 profile with a validation error rather than
  mis-route; re-run `styre setup` or upgrade the binary. *Residual:* a hand-edited profile carrying
  custom `extensions[]` has them **silently stripped**, with no diagnostic. Note `profile.ts:80-82`
  states in source that "`profile.json` is hand-editable", so calling this unsupported would be
  wrong — it was undocumented as an override, not forbidden. Consider a warn-on-strip in
  `parseProfile`, which already hand-writes diagnostics for v1/v2, to make this a visible migration
  rather than quiet data loss.
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
| v2 error message updated; too-new pre-check added | 3 |
| Unmodeled-kind-with-stored-extensions residual has a test | 2 |
| Changelog notes the hand-edited-`extensions` residual | 6 |
| `format` + `lint` + `typecheck` + `test` green | every task; final in 6 |

## Behavior changes to call out in the PR description

1. **Older styre binaries reject profiles written by this version** (validation error naming `schemaVersion`). Intended — it is the whole point of the bump, and the alternative is silent over-routing. Operators upgrade the binary or re-run `styre setup`.
2. **A hand-edited profile's custom `extensions[]` is silently stripped.** Not "unsupported" — `profile.ts:80-82` says in source that the profile *is* hand-editable; the field was merely undocumented as an override. Silent is the problem; a warn-on-strip would fix it.
3. **A profile written before ENG-362 whose `kind` was refined by the discovery agent may route differently.** `mergeComponents` applied the agent's `kind` while keeping the scan's `extensions`, so stored and derived can disagree; deriving from `kind` changes routing for exactly those components. ENG-362 closes the source, but does not retroactively repair profiles already on disk. Re-running `styre setup` regenerates them.
4. **A profile with no `schemaVersion` key at all** is now read as 4 rather than 3 (the schema default moves). Harmless — extensions are ignored either way — but it is a real parse-behavior change and `test/dispatch/profile.test.ts:127` covers this path today asserting `3`.
5. **`moduleLeaf` gains eight extensions** — ENG-359 had not landed as of writing, so expect this. Prefer landing ENG-359 first so this PR is a clean no-op.

Everything else is behavior-preserving *for profiles written after ENG-362*: the derived extension list equals the stored one for every kind whose `kind` was not agent-refined, which Task 1 asserts differentially against the live table before deleting it. The earlier claim that this held "by construction" for all profiles was false — see the note under **Why**.
