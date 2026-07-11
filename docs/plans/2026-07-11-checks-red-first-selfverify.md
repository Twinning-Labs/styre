# checks:dispatch self-verifies RED-first + better authoring guidance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `checks:dispatch` from submitting *vacuous* acceptance checks (tests that pass on the still-broken code) by letting the author RUN its own test and confirm it fails before submitting, plus sharpening the authoring and re-author guidance.

**Architecture:** Two coupled changes. (1) **Capability:** give `checks:dispatch` the same *scoped* `Bash` the `implement:dispatch` agent gets — restricted to the profile's declared runner commands, never bare shell — so it can execute its candidate test. (2) **Prompt/feedback:** flip the prompt's "you do NOT run anything" into "run it and prove it fails RED-first, for the right reason," add discriminating-assertion guidance for numeric/data bugs, and strengthen the vacuous-check re-author feedback. styre still independently re-runs every check as ground truth (`ac-check-red-first`) — the self-run only lets the agent self-correct instead of burning a loopback.

**Tech Stack:** TypeScript + Bun. Tool allowlists in `src/dispatch/tool-allowlists.ts` (`allowlistFor` scopes `Bash(<cmd>:*)`); the checks handler in `src/dispatch/handlers.ts`; prompt text `prompts/checks.md`; re-author feedback `src/dispatch/checks-feedback.ts`.

## Global Constraints

- **Scoped, never bare, Bash.** `checks:dispatch` Bash MUST be scoped to `realRunnerCommands(profile.components)` via the existing `allowlistFor` mechanism; with no runners, the `Bash` token is dropped entirely (agent keeps Write/Edit, no shell) — identical to `implement:dispatch`.
- **Ground truth unchanged.** The agent still does NOT report a verdict; the runner's `ac-check-red-first` execution remains the source of truth. The self-run is only for the agent to self-correct.
- **No new sidecar field / schema change.** `ChecksOutputSchema` is untouched.
- Full suite (`bun test`), `bun run typecheck`, `bun run lint` stay green.

---

### Task 1: Scoped Bash capability for checks:dispatch

**Files:**
- Modify: `src/dispatch/tool-allowlists.ts` (add `Bash` to the checks list; extend `allowlistFor` scoping to `checks:dispatch`)
- Modify: `src/dispatch/handlers.ts` (pass `runnerCommands` in the checks:dispatch spec; fix the "no Bash" comment)
- Test: `test/dispatch/tool-allowlists.test.ts`

**Interfaces:**
- Consumes: `realRunnerCommands(components: Component[]): string[]` (already imported in handlers.ts) and the existing `allowlistFor(handlerKey, { runnerCommands })`.
- Produces: `allowlistFor("checks:dispatch", { runnerCommands })` now returns scoped `Bash(<cmd>:*)` entries (or drops Bash when runners is empty).

- [ ] **Step 1: Write the failing allowlist tests**

Append to `test/dispatch/tool-allowlists.test.ts` (mirror the existing `implement:dispatch` scoping tests in that file):

```ts
test("checks:dispatch gets Bash scoped to the runner commands (never bare)", () => {
  const tools = allowlistFor("checks:dispatch", { runnerCommands: ["pytest", "npm test"] });
  expect(tools).toContain("Bash(pytest:*)");
  expect(tools).toContain("Bash(npm test:*)");
  expect(tools).not.toContain("Bash"); // never bare, unscoped Bash
  expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Write", "Edit"]));
});

test("checks:dispatch drops Bash entirely when there are no runner commands", () => {
  const tools = allowlistFor("checks:dispatch", { runnerCommands: [] });
  expect(tools.some((t) => t.startsWith("Bash"))).toBe(false);
  expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Write", "Edit"]));
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test test/dispatch/tool-allowlists.test.ts`
Expected: FAIL — checks:dispatch currently has no `Bash` and `allowlistFor` only scopes `implement:dispatch`, so the bare list (no `Bash*`) is returned.

- [ ] **Step 3: Add Bash to the checks allowlist + extend the scoping**

In `src/dispatch/tool-allowlists.ts`, change the checks line:
```ts
  "checks:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
```
and extend the scoping condition in `allowlistFor` so it also covers checks:
```ts
  if (handlerKey === "implement:dispatch" || handlerKey === "checks:dispatch") {
    const runners = [...new Set((opts?.runnerCommands ?? []).map((c) => c.trim()).filter(Boolean))];
    const bash = runners.map((c) => `Bash(${c}:*)`);
    // runners=[] ⇒ flatMap yields nothing for the "Bash" token → Bash dropped entirely, never bare
    return tools.flatMap((t) => (t === "Bash" ? bash : [t]));
  }
```
Also update the file's top comment that says the scoping is `implement:dispatch`-only to mention both steps.

- [ ] **Step 4: Pass runnerCommands from the checks handler**

In `src/dispatch/handlers.ts`, in the `checks:dispatch` dispatch spec (the `runAgentDispatch(... { handlerKey: "checks:dispatch", ... })` call), add:
```ts
      runnerCommands: realRunnerCommands(deps.profile.components),
```
and change the preceding comment `Dispatch the plan-blind author (no Bash; commits via CL-COMMIT → sha).` to `Dispatch the plan-blind author (scoped Bash to run/confirm its own RED-first checks; commits via CL-COMMIT → sha).`

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `bun test test/dispatch/tool-allowlists.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/tool-allowlists.ts src/dispatch/handlers.ts test/dispatch/tool-allowlists.test.ts
git commit -m "feat(dispatch): scoped Bash for checks:dispatch (self-run its RED-first checks)"
```

---

### Task 2: Prompt + feedback — run-and-verify RED-first, discriminating assertions

**Files:**
- Modify: `prompts/checks.md` (flip "do not run"; add discriminating-assertion guidance)
- Modify: `src/dispatch/checks-feedback.ts` (strengthen the vacuous-check re-author feedback)
- Test: `test/dispatch/checks-prompt.test.ts`, `test/dispatch/checks-feedback.test.ts`

**Interfaces:**
- Consumes: `CHECKS_TEMPLATE` (raw `prompts/checks.md`) and `checksFeedback(db, ticketId)`.
- Produces: no new symbols; prompt/feedback text only.

- [ ] **Step 1: Write the failing content tests**

Append to `test/dispatch/checks-prompt.test.ts`:
```ts
test("checks prompt requires the author to run its check and confirm it fails RED-first", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  expect(t).toMatch(/run .*(check|test)/); // must instruct running it
  expect(t).toMatch(/fail/); // confirm it FAILS on current code
  expect(t).toContain("vacuous"); // name the failure mode it prevents
  // still no self-reported verdict — the runner is ground truth
  expect(t).toContain("do not report a verdict");
});
```

Append to `test/dispatch/checks-feedback.test.ts` (this file already seeds a `checks` loopback event with vacuous findings — mirror its existing setup; assert the strengthened wording):
```ts
test("checksFeedback tells the re-author the prior check passed on broken code and to run it", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "checks",
    routeTo: "checks",
    signature: "checks:vacuous",
    payload: { findings: [{ acId: 3, reason: "passed on clean HEAD" }] },
  });
  const out = checksFeedback(db, ticketId).toLowerCase();
  db.close();
  expect(out).toContain("passed"); // it passed when it should have failed
  expect(out).toMatch(/run .*(it|check|test)/); // instruct running to confirm RED
});
```
(If `appendEvent`/`makeTestDb` are not already imported in `checks-feedback.test.ts`, add them from `../../src/db/repos/event-log.ts` and `../helpers/db.ts`, matching `design-feedback.test.ts`.)

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test test/dispatch/checks-prompt.test.ts test/dispatch/checks-feedback.test.ts`
Expected: FAIL — the current prompt says "you do NOT run anything" (no run/vacuous language) and the feedback lacks the "run it" instruction.

- [ ] **Step 3: Update the prompt — run-and-confirm-RED + discriminating assertions**

In `prompts/checks.md`, replace the rule bullet:
```markdown
- You do NOT run anything and you do NOT report a verdict — the runner executes your checks. Report only
  what you wrote.
```
with:
```markdown
- **Run each check you write and CONFIRM it FAILS on the current (unfixed) code before you finish.** Use
  the detected test command for the matching stack. A check that PASSES right now is *vacuous* — it is not
  testing the criterion — so if it passes, or fails only for a trivial reason (import/syntax/collection
  error rather than the asserted behavior), fix it until it fails *because the criterion is unmet*. You
  still do NOT report a verdict — the runner re-runs your checks as the source of truth; you run them only
  to prove they are genuinely RED-first.
- **For a numeric, data-shape, or algorithmic criterion, assert the SPECIFIC correct value the fixed code
  must produce** (the one that differs from the current wrong output) — never a property that holds
  regardless of the fix. If you cannot state the exact expected value, read the code/docs until you can.
```

- [ ] **Step 4: Strengthen the re-author feedback**

In `src/dispatch/checks-feedback.ts`, update the returned string so it (a) states the prior check passed on the still-broken code, and (b) tells the agent to run its new check and confirm it fails. Replace the final `return` template with:
```ts
  return `## Prior check feedback (re-author to actually exercise the AC)\n\nA prior authored check PASSED on the current broken code — it is vacuous and did not test the criterion. Write a check that FAILS on the code as it is now, and RUN it to confirm it fails for the RIGHT reason (the asserted behavior, not an import/collection error) before finishing:\n${lines.join("\n")}`;
```

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `bun test test/dispatch/checks-prompt.test.ts test/dispatch/checks-feedback.test.ts`
Expected: PASS.

- [ ] **Step 6: Full green check**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add prompts/checks.md src/dispatch/checks-feedback.ts test/dispatch/checks-prompt.test.ts test/dispatch/checks-feedback.test.ts
git commit -m "fix(dispatch): checks author runs its own RED-first check + sharper authoring/feedback"
```

---

## Self-Review

**1. Spec coverage:** The vacuous-check root cause (agent submits blind because it has no Bash) is fixed by Task 1 (scoped Bash) + Task 2 (prompt instructs run-and-confirm-RED). Authoring quality is addressed by the discriminating-assertion guidance; the correction loop by the strengthened `checksFeedback`. styre's ground-truth `ac-check-red-first` is untouched.

**2. Placeholder scan:** No TBD/vague steps; all edits carry exact text and commands.

**3. Type consistency:** No signature changes. `allowlistFor(handlerKey, { runnerCommands })` and `realRunnerCommands(components)` are used exactly as defined. No schema/sidecar change. The scoping reuses the proven `implement:dispatch` mechanism verbatim.
