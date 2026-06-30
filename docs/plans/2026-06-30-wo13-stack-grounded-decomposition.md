# WO-13: Stack-grounded design & extract decomposition — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL — use **superpowers:subagent-driven-development** (or **superpowers:executing-plans**) to implement this plan. Steps use checkbox (`- [ ]`) syntax. TDD: write the failing test, see it fail, implement, see it pass, then lint + typecheck + full suite, then commit.

**Goal:** make the **design** and **extract** phases aware of the stacks `styre setup` already detected. Today the planner is **stack-blind** — `profile.components` are never shown to the design/extract agent, so a multi-stack monorepo ticket is decomposed by pure agent guesswork (freeze §9 item 8). This plan injects a structured **detected-stacks summary** into the `design` and `design-extract` prompts so the planner uses the *real* stacks (and their kinds) instead of generic guesses.

**Scope (single task, after independent review):** WO-13 ships **only the prompt grounding** — the cheap, high-value, reliable half. The originally-planned **extract-time advisories** (cross-stack coupling signal + off-stack-kind warning) are **deferred to WO-5/M-D** — see "Why the advisories are deferred" below. This plan is **additive**: no schema change, no new gate, no change to how units are dispatched or persisted.

**Architecture:** a pure `stackSummary(components)` helper + a new `detected_stacks` prompt var threaded through `designVars`/`extractVars`, rendered by a new `{{detected_stacks}}` block in `prompts/design.md` and `prompts/design-extract.md`.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome. Commands: `bun test` · `bun run lint` (`biome check .`) · `bun run typecheck` (`tsc --noEmit`). Bare `biome`/`tsc` are NOT on PATH — use the `bun run` scripts.

## Why a new `{{detected_stacks}}` placeholder (not the existing `{{stack}}`)

The work order said "fill the empty `{{stack}}` slot." That's almost right but misses one thing: in `designVars` the literal `stack: ""` is followed by `...profile.promptVars`, and a profile's `promptVars` **can** carry a `stack` key (the `prompt-vars.test.ts` fixture sets `promptVars: { stack: "Bun + SQLite" }`, and `styre setup` populates a stack display string). So `{{stack}}` is the **human/setup free-text note**; reusing it for the structured component list would clobber that note. A dedicated `{{detected_stacks}}` var is non-colliding and leaves `{{stack}}` untouched. (Confirmed correct by the scope reviewer.)

## Why the advisories are deferred (independent-review finding)

The first draft added two extract-time advisories. The review killed both for *now*:

- **Cross-stack coupling signal — unreliable until WO-5.** It would compute coupling via `impactedComponents` (folder-glob). But today's detectors emit `paths: ["**"]` for Go/Python/JVM/non-workspace-Rust (`go.ts:14`, `python.ts:33`, `jvm.ts`, `rust.ts`). A bare `["**"]` matches *every* file, so in a polyglot repo with two root stacks the coupling check fires on **every** unit (≈100% false positive); excluding `["**"]` instead makes it silently **miss** coupling whenever one side is a `["**"]` stack. There is no honest folder-glob answer — the signal is only computable once **WO-5 file-identity** maps each file to exactly one stack. Since **Milestone M-D already depends on WO-5**, the coupling signal lands there, not here.
- **Off-stack-kind warning — noisy & redundant.** It cried wolf on `backend`/`frontend` (the prompt's own example kinds) and `ui`/`test`/`e2e` (legitimate roles). Task 1's prompt injection already steers `kind` toward real stacks up front, so a post-hoc validator is redundant. The work order's item-2 is phrased as "warn when kind isn't a detected stack **or** files span multiple stacks" — the **prompt grounding satisfies the guide-kind intent** without a noisy gate.

Net: WO-13 = prompt grounding. The "validate/guide `kind` + coupling signal" task moves to **WO-5/M-D** (tracked in the work order).

## Global Constraints

- **Additive / behavior-preserving:** no `ComponentSchema`/`ProfileSchema`/`work_unit` change; nothing persisted changes. The only observable delta is richer `design`/`design-extract` prompts.
- **Existing suites stay green:** `test/dispatch/prompt-vars.test.ts`, `design-vars.test.ts`, `render-prompt.test.ts`. These assert "every placeholder in the template is present in the vars" (`prompt-vars.test.ts:35-37, 75-77, 87-89`) — `renderPrompt` returns `ok:false` for a placeholder **absent from vars** (`render-prompt.ts:22-24`; the `?? ""` on line 26 only covers an in-vars-but-`undefined` value). So adding `{{detected_stacks}}` to a template **requires** adding `detected_stacks` to the corresponding vars; this plan does both, and the existing "resolves every placeholder" tests are the regression guard. TDD ordering: add the var (Step 3) before the template block (Step 4) so no existing test transiently goes red.
- **Empty-components safety.** A repo with no detected stacks (`profile.components == []`) yields a `detected_stacks` **no-detect note** (a var-level fallback added during the overall review — `stackSummary` itself still returns `""`), so the prompt's stack guidance still reads sensibly; never an error.

---

### Task 1 — feed detected stacks into the design + extract prompts

**Files:**
- Modify: `src/dispatch/prompt-vars.ts` (add `stackSummary`; add `detected_stacks` to `designVars` + `extractVars`)
- Modify: `prompts/design.md`, `prompts/design-extract.md` (add the `{{detected_stacks}}` block)
- Test: `test/dispatch/prompt-vars.test.ts` (add cases)

**Interfaces:**
- Produces: `export function stackSummary(components: Component[]): string` — one line per component (`name`, `kind`, `paths`, and the `test` command when present); `""` when no components.
- `designVars(...)` and `extractVars(...)` gain `detected_stacks: stackSummary(profile.components)`. `designVars`'s existing `stack: ""` line is **kept** (behavior preserved — `promptVars` may still override it).

- [x] **Step 1: Write the failing tests** (append to `test/dispatch/prompt-vars.test.ts`; it already imports `Component` from `profile.ts` and a block from `prompt-vars.ts` — fold `stackSummary` into that existing import, don't add a duplicate line):

```ts
const COMPS: Component[] = [
  { name: "go", kind: "go", paths: ["**"], commands: { test: "go test ./..." } },
  { name: "frontend", kind: "sveltekit", paths: ["src/**", "static/**", "package.json"], commands: { test: "npm run test" } },
];

test("stackSummary is empty for no components; lists kind/name/paths/test otherwise", () => {
  expect(stackSummary([])).toBe("");
  const s = stackSummary(COMPS);
  expect(s).toContain("go");
  expect(s).toContain("sveltekit");
  expect(s).toContain("go test ./...");
  expect(s).toContain("src/**");
});

test("designVars + extractVars carry detected_stacks from the profile components", () => {
  const profile = parseProfile({ slug: "d", targetRepo: "/t", components: COMPS });
  const dv = designVars({ ident: "ENG-1", title: "T", description: "b" }, profile);
  const ev = extractVars({ ident: "ENG-1", title: "T" }, profile);
  expect(dv.detected_stacks).toBe(stackSummary(COMPS));
  expect(ev.detected_stacks).toBe(stackSummary(COMPS));
  expect(dv.detected_stacks).toContain("sveltekit");
  expect(dv.stack).toBe(""); // {{stack}} (free-text note) unchanged; no promptVars.stack in this fixture
});

test("detected_stacks is empty when the profile has no components", () => {
  const profile = parseProfile({ slug: "d", targetRepo: "/t" });
  expect(extractVars({ ident: "E", title: "T" }, profile).detected_stacks).toBe("");
});
```

- [x] **Step 2: Run — FAIL** (`stackSummary` undefined; `detected_stacks` undefined). `bun test test/dispatch/prompt-vars.test.ts`

- [x] **Step 3: Implement** in `src/dispatch/prompt-vars.ts` (`commandFor` is already imported from `./components.ts`; add `import type { Component } from "./profile.ts"` — `Profile` is already imported there):

```ts
/** One line per detected component for the `{{detected_stacks}}` prompt slot: name, kind, paths,
 *  and the test command when known. Empty string when there are no components (renders blank). */
export function stackSummary(components: Component[]): string {
  return components
    .map((c) => {
      const test = commandFor(c, "test");
      const paths = c.paths.join(", ");
      return `- ${c.name} (kind: ${c.kind}) — paths: ${paths}${test ? `; test: ${test}` : ""}`;
    })
    .join("\n");
}
```
Add `detected_stacks: stackSummary(profile.components)` to the returned object of **both** `designVars` and `extractVars` (keep every existing key, including `designVars`'s `stack: ""`).

- [x] **Step 4: Add the prompt blocks.** In `prompts/design.md`, after the existing `Project stack notes: {{stack}}` line, add:

```markdown
## Detected stacks (from `styre setup` — ground truth)

{{detected_stacks}}

When a work unit is specific to one of these stacks, use that stack's **kind** as the unit `kind`
(e.g. `go`, `sveltekit`) rather than a generic label. Cross-cutting kinds (`docs`, `config`,
`migration`) remain valid. If a unit must change files in **more than one** of these stacks, say so
explicitly in the plan — it is a cross-stack change the build system will need to verify carefully.
```
In `prompts/design-extract.md`, add the same `## Detected stacks …` block immediately before the `For each work unit decide:` list, and amend the `**kind**` bullet to: *"the work type — **prefer one of the project's detected stacks above** when the unit is stack-specific (e.g. `go`, `sveltekit`); otherwise a role like `docs`, `config`, `migration`."* (Leave the example sidecar JSON's `"kind": "backend"` as a shape example — it is not validated, and no advisory flags it.)

- [x] **Step 5: Run — PASS** + full suite. The existing "resolves every placeholder" tests for `DESIGN_TEMPLATE` and `EXTRACT_TEMPLATE` are the guard that `detected_stacks` is wired into both vars. `bun test && bun run lint && bun run typecheck`.
- [x] **Step 6: Commit** — `git commit -m "feat(design): feed detected stacks into design + extract prompts (WO-13)"`

---

## Self-review notes (author)

- **Sub-problem #4 coverage (WO-13 slice):** item 1 (feed components into the planner) → Task 1, shipped. Item 2 (validate/guide `kind` + the coupling signal) → **deferred to WO-5/M-D** per the independent review (folder-glob `["**"]` makes coupling uncomputable pre-file-identity; the off-stack warning is redundant given Task 1). The work order tracks the deferral.
- **Why no advisory now:** documented above ("Why the advisories are deferred"). Shipping a ≈100%-false-positive coupling signal or a cry-wolf kind warning would erode trust in the diagnostic; the prompt grounding delivers the actual WO-13 value (the planner stops ignoring the detected stacks).
- **`{{detected_stacks}}` vs `{{stack}}`:** deliberate — `{{stack}}` carries a real `promptVars`-fed note; a separate placeholder avoids clobbering it (scope reviewer confirmed).
- **Empty-components & legacy repos:** the change degrades to an empty block — safe where `setup` detected nothing.
- **Behavior preservation:** no persisted artifact changes; the only delta is richer prompts. Existing `prompt-vars`/`design-vars`/`render-prompt` suites must pass unchanged (Step 5 verifies).
- **Out of scope (M-D, and now also the deferred WO-13 advisories):** attaching files/siblings/contract to the *implement* prompt, coupled-cluster=one-context, the dependency-graph blast-radius, the implicit-contract design gate, and the cross-stack coupling signal (which becomes reliable only with WO-5 file-identity).
