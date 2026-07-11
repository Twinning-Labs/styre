# checks:dispatch scratch-prevention + new_files declaration (prompt parity) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `checks:dispatch` agent the same scratch-prevention instruction and `new_files` declaration mechanism the `implement` agent already has, so the per-step commit-scope reject-and-retry (PR #70) has an escape hatch instead of wedging when the checks author leaves an undeclared scratch file.

**Architecture:** Prompt-only. The code side already landed in PR #70 — `ChecksOutputSchema.new_files` exists (`src/dispatch/checks-schema.ts`) and `checksScope` already commits `checksAuthored[].test_file ∪ new_files` and rejects any other new file (`src/dispatch/commit-scope.ts`). The only gap is `prompts/checks.md`: it documents only `checksAuthored`, so the agent can neither *declare* a genuine new helper nor is it told to *delete* scratch. This plan adds that guidance and a content test mirroring the existing `test/dispatch/checks-prompt.test.ts`.

**Tech Stack:** TypeScript + Bun. Prompts are Markdown files imported as text (`prompts/*.md`), exported as `CHECKS_TEMPLATE` from `src/dispatch/prompt-vars.ts`. Tests run with `bun test`.

## Global Constraints

- The guidance is **literal prompt text only** — do NOT introduce a new `{{slot}}`. `new_files` appears only as a literal JSON field in the example sidecar; no `prompt-vars.ts` / `render-prompt.ts` change is permitted (a new unfilled `{{slot}}` would break `renderPrompt`).
- Mirror the wording already proven in `prompts/implement.md` (its "Reporting the files you created" block): "Do NOT leave throwaway, debug, or reproduction files… The commit is REJECTED if it contains any file you did not declare."
- The checks author's test files are ALREADY declared via `checksAuthored[].test_file` — `new_files` is for genuine **non-test** helpers only (a fixture / `conftest.py`) and test files must NOT be repeated there (matches the `ChecksOutputSchema.new_files` doc-comment).
- Full suite (`bun test`), `bun run typecheck`, and `bun run lint` must stay green.

---

### Task 1: Add scratch-prevention + new_files guidance to the checks prompt

**Files:**
- Modify: `prompts/checks.md` (add one rule bullet after line 24; extend the sidecar example + report paragraph at lines 36–45)
- Test: `test/dispatch/checks-prompt.test.ts` (add one content test)

**Interfaces:**
- Consumes: `CHECKS_TEMPLATE` (exported from `src/dispatch/prompt-vars.ts` — the raw text of `prompts/checks.md`).
- Produces: nothing new for other code; the behavioral contract (`checksScope` commits `checksAuthored ∪ new_files`, rejects the rest) is unchanged and already tested in `test/dispatch/commit-scope.test.ts`.

- [ ] **Step 1: Write the failing content test**

Append to `test/dispatch/checks-prompt.test.ts`:

```ts
test("checks prompt forbids leftover scratch files and offers a new_files declaration escape hatch", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  // Anti-scratch instruction (mirrors implement.md) — so a reject-and-retry can be resolved by deleting scratch.
  expect(t).toMatch(/throwaway|reproduction|scratch/);
  expect(t).toContain("reject"); // the commit is REJECTED if it contains an undeclared new file
  // Declaration escape hatch for a genuine non-test helper.
  expect(t).toContain("new_files");
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun test test/dispatch/checks-prompt.test.ts`
Expected: the new test FAILS (current `checks.md` contains neither "new_files" nor a scratch/throwaway/reproduction instruction). The pre-existing "observable" test still passes.

- [ ] **Step 3: Add the scratch-prevention rule bullet**

In `prompts/checks.md`, immediately AFTER the existing bullet that ends line 24 (`…Report only\n  what you wrote.`) and BEFORE the blank line preceding `## Acceptance criteria`, add:

```markdown
- **Do NOT leave throwaway, debug, or reproduction files behind.** If you write a scratch script to
  understand the bug or try out an assertion, delete it before you finish. The commit is REJECTED if it
  contains any NEW file you did not declare — your check files (listed in `checksAuthored` via
  `test_file`) plus any genuine non-test helper (listed in `new_files`, below) — and you will have to
  redo this step.
```

- [ ] **Step 4: Add `new_files` to the sidecar example and the report paragraph**

Replace the sidecar example block (lines 36–42) so it includes `new_files`:

````markdown
```styre-sidecar
{
  "checksAuthored": [
    { "ac_id": 7, "test_file": "api/tests/styre_checks/ENG-1_ac7_test.py", "test_name": "test_health_returns_200" }
  ],
  "new_files": []
}
```
````

Then replace the final report paragraph (lines 44–45) with:

```markdown
Report, per check: the acceptance-criterion `ac_id` it targets, the repo-relative `test_file` you created,
and the `test_name` (function/case name) you wrote. Report no selector and no result. If — and only if — a
check genuinely needs a NEW non-test helper (a fixture / `conftest.py`), list its repo-relative path in
`new_files`; your test files are already declared via `test_file` and must NOT be repeated there. Otherwise
leave `new_files` empty.
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun test test/dispatch/checks-prompt.test.ts`
Expected: both tests PASS.

- [ ] **Step 6: Full green check**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass. (No behavior changed; the `new_files: []` addition to the example matches `ChecksOutputSchema`'s default, so no parsing/handler test regresses.)

- [ ] **Step 7: Commit**

```bash
git add prompts/checks.md test/dispatch/checks-prompt.test.ts
git commit -m "fix(dispatch): give checks:dispatch scratch-prevention + new_files guidance"
```

---

## Self-Review

**1. Spec coverage:** The single requirement — extend `prompts/checks.md` with (a) a scratch-prevention instruction and (b) the `new_files` declaration mechanism, so the reject-and-retry has an escape hatch — is covered by Task 1 (rule bullet in Step 3, sidecar + report in Step 4). The content test (Step 1) asserts both halves.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every step carries exact text and exact commands.

**3. Type consistency:** No new types or signatures. `new_files` matches the existing `ChecksOutputSchema.new_files: z.array(z.string()).default([])`. `CHECKS_TEMPLATE` is the exact import already used by `test/dispatch/checks-prompt.test.ts`. No `{{slot}}` added, so `renderPrompt`'s slot-checking is unaffected.
