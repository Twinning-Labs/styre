# The Styre ticket template

How to write a Linear ticket that styre can carry from `design` to `pr-ready` without a human.

This document is **code-grounded**: every rule traces to a mechanism in `src/` or `prompts/`, cited
inline. It is not a style guide — it describes what the machine actually reads, and what happens to
you when it reads something it can't use.

---

## 1. What styre actually reads

Start here. Most ticket-writing instincts are wrong until you internalise this.

The entire ticket contract is six fields (`src/integrations/ticket-source.ts:6-13`):

```ts
export interface IngestedTicket {
  ident: string;
  title: string;
  description: string | null;
  typeLabel: TypeLabel;   // "Bug" | "Feature" | "Improvement"
  externalId: string | null;
  url: string | null;
}
```

Three of those you don't write (`ident`, `externalId`, `url`). **You control exactly three things:
the title, the description, and one label.**

There is **no `styre_config` block**. No context-files list, no structured scope block, no "Ready for
Agent" trigger. Those appear in `build-operations.md` §4/§5 but were explicitly deferred to the
commercial Control Plane and are **not built in OSS and not planned for it**
(`docs/architecture/brainstorm.md:426`). If you write a `styre_config` block into a ticket, nothing
reads it. Runtime policy lives in `--config`/RuntimeConfig (`src/config/runtime-config.ts:9-40`).

The ticket is fetched **once**, at trigger. `fetchTicket` is ingestion-only and must never be called
from the control loop (`src/integrations/issue-tracker.ts:17-19`) — the loop reads the SoT, never the
tracker. **Editing a ticket mid-run changes nothing.**

### Where each field goes

| Prompt | What it sees of your ticket |
|---|---|
| `design` | ident, title, **description** |
| `checks` | ident, title, **the parsed ACs** (`- ac_id=N: text`) |
| `design:extract` | ident, title (reads the *plan*) |
| `design:review` | ident, title |
| `implement` | ident + work-unit fields only |
| `review` | ident, title |

Mapped from `src/dispatch/prompt-vars.ts`. Two consequences drive this whole document.

**`description` reaches exactly one prompt: `design`** (`designVars`, prompt-vars.ts:84-100). Every
downstream step consumes the *plan*, not your ticket. Design is a one-way funnel: ambiguity that
survives it is unrecoverable, because no later step can go back and re-read what you meant.

**The checks author is plan-blind and sees only your AC text** (`checksVars`, prompt-vars.ts:213;
`prompts/checks.md:5-7` — *"you are NOT given the implementation plan"*). It gets the AC string, the
detected stacks, and nothing else. **Every AC must stand alone.** An AC reading "the message states
the true post-state" is unverifiable — the author cannot see the prose defining "true post-state".

Note what appears in *every* row above: **title**. It is the only ticket text every step sees. Write
it as a standalone claim, not a label.

---

## 2. The template

Copy this. `- [ ]` lines are parsed; everything else is prose read by the design agent.

```markdown
## What

<1-3 sentences: the change, in the imperative. Name the file(s) and symbol(s) you know.
If you know the current code, quote the offending lines with a file:line ref.>

## Why

<The evidence. Ground truth beats assertion: a run id, a transcript quote, a failing command,
a captured SoT, a measured percentage. If you assert a defect, prove it here.
Also record the defences you considered and why they're dead — this stops the design agent
re-deriving a rejected option.>

## Scope

**IN**

* <bullet — no checkbox! see §4.1>
* <Only to the precision your evidence supports. Investigated it? Name files and symbols.
  Haven't? Describe the outcome and let design find the files — a plausible wrong guess
  is worse than saying nothing. See §4.2.>

**OUT**

* <what this ticket explicitly does not do, and why — a sibling ticket, a rejected design,
  a conscious deferral. Always writable: it's a decision, not a discovery.
  Name the sibling ticket if there is one.>

## Acceptance criteria

- [ ] <self-contained, observable, specific — see §3. Each line becomes one test file.>
- [ ] `bun test`, `tsc --noEmit`, and `bun run lint` all pass.

## Refs

* <sibling tickets, design docs, code refs with file:line, ground-truth artifacts>
```

Set exactly one label: **`Bug`**, **`Feature`**, or **`Improvement`**.

---

## 3. Acceptance criteria: the part that decides success

### The parser

`src/dispatch/ac-checklist.ts` is the *entire* description-parsing surface of styre. One regex:

```ts
const TASK_ITEM_RE = /^\s*[-*+]\s+\[[ xX]\]\s+(\S.*?)\s*$/;
```

- Every GFM task-list item → **one AC** → **one authored test file**.
- **No task items → the whole description becomes one coarse AC** (`source: "whole-description"`).
  This is the worst outcome available to you: one unfocused check standing in for the whole ticket.
  **Always write a checklist.**
- Empty/whitespace/null description → **zero ACs**; the checks step has nothing to author.

### Each AC must be self-contained

The checks author sees your AC text and nothing else (§1) — not the What, Why, Scope, or sibling ACs.

| Don't | Do |
|---|---|
| `The message states the true post-state.` | `For a new-file offender, the message states the file was created and has since been removed, and instructs the agent not to search for it.` |
| `Handle the error case.` | `parseFoo("") returns [] rather than throwing.` |
| `Provision runs first.` | `For a ticket entering design, nextStepKey returns provision before design:dispatch.` |

### Each AC must name an observable output, with a specific value

This is `prompts/checks.md`'s explicit bar (:26-30, :37-39):

> **Assert the criterion's *observable output*, not just that the surface responded.** … A
> status-code-only or existence-only assertion (e.g. `assert resp.status == 201` with no check of the
> body) is too weak: a stub that returns `201 {}` would pass it. Make the assertion one a stub cannot
> satisfy without doing the work.

> For a numeric, data-shape, or algorithmic criterion, assert the SPECIFIC correct value the fixed
> code must produce — never a property that holds regardless of the fix.

An AC naming no observable output **cannot** produce a non-vacuous check. That failure is not silent
— it costs you the run.

### The adjudication classes — the real scoring rubric

`checks:classify` labels every authored check (`src/dispatch/adjudicate-schema.ts:6-14`,
`prompts/checks-classify.md:8-25`): three red classes, three green-on-HEAD dispositions, plus `weak`
— a transient surface-only flag that is never persisted. This table is the most useful thing in this
document: it is effectively the grading rubric your AC phrasing is scored against.

| Class | Meaning | Outcome | Triggering AC phrasing |
|---|---|---|---|
| **`assertion`** | Failed assertion ran against genuinely-executed behavior on an existing surface. | ✅ **the goal** | Names an observable value on a surface that exists |
| `absence` | Fails only because the surface doesn't exist yet. *"Named bias, not ground truth."* | ⚠️ weak signal | "Add endpoint X" with no stated output contract |
| **`weak`** | Surface exists and ran, but the assertion is surface-only — *"a check a trivial stub could satisfy"*. | ❌ **re-author** | "returns 200", "the function exists" |
| **`vacuous`** | Green on clean HEAD; doesn't actually exercise the AC. | ❌ **re-author** | Vague / untestable-as-written |
| `already-satisfied` | Green on HEAD; the AC is genuinely already met. | ✅ pass | Restates current behavior |
| `not-expressible` | Qualitative AC with no natural red state. *"NEVER fold this into satisfied."* | ✅ pass | "code should be maintainable/readable" |
| `environmental` | Couldn't meaningfully run (missing dep, broken fixture). | advisory | — |

**`weak` and `vacuous` are the two that cost you a re-author round, and both are caused by an AC that
names a *surface* rather than an *output*.** Two consecutive re-author rounds on the same AC and the
ticket **escalates to a human** (`REAUTHOR_ESCALATE_CAP = 2`, `src/daemon/checks-verdict.ts:28`).

> **The failure chain to memorise:** vague AC → surface-only check → classified `weak`/`vacuous` →
> re-author → re-author → **escalate**. A woolly checkbox is not a small cost; it is the most common
> way a ticket ends in a human's lap.

### Every AC must be red→green expressible

`checks:dispatch` is **unconditional** — every ticket runs it, and each AC must yield a test that
**fails on current code for the right reason** (`prompts/checks.md:5-7`, :31-36 — a failure from an
import/collection error rather than the asserted behavior doesn't count).

`not-expressible` is a legitimate terminal pass, not a failure — but it hinges on an LLM judgement
biased toward `vacuous`. Don't lean on it. For a genuinely non-behavioral ticket (pure refactor,
docs, coverage), expect friction — a known open gap, scoped in **ENG-290**.

### Include the gate line

End the checklist with the project's actual gate:

```markdown
- [ ] `bun test`, `tsc --noEmit`, and `bun run lint` all pass.
```

---

## 4. Sharp edges

### 4.1 A checkbox anywhere is an acceptance criterion

`parseAcChecklist` scans **the whole description**. It has no concept of a "section". A `- [ ]` in
your Scope block becomes an AC, gets a test file authored against it, and is gated on.

**Rule: `- [ ]` appears under `## Acceptance criteria` and nowhere else.** Use `*` bullets everywhere
else — that's why the template's Scope block uses `*`.

Related parser behaviours:

- **Indentation is ignored** — nested task items flatten to peers. There is no AC hierarchy.
- **`[x]` and `[ ]` are identical.** Pre-checking a box does not skip it.
- **All-or-nothing for ACs**: once any task item matches, only task items become ACs. (Your prose is
  still read by `design` — it just contributes no ACs.)
- A bare `- [ ]` with no text doesn't match, and silently drops you to whole-description mode.

### 4.2 What "scope" means — and how much of it you're expected to know

"Scope" names four different things in styre. Only one is authored by you, and it is the only one
with no enforcement:

| "Scope" | Derived from | Enforced? |
|---|---|---|
| **Ticket Scope IN/OUT** (this template's section) | you, as prose | ❌ no parser exists |
| **Commit scope guard** (`commit-scope.ts`) | the agent's own sidecar declaration + path rules | ✅ hard — reject-and-retry |
| **Scope reconciliation** (`completeness.ts`) | the *plan's* `files_to_touch` | ✅ deterministic under/over |
| **Reviewer `scope` finding** (`review.md:10-13`) | LLM judgement against the *plan* | ⚠️ soft |

Your Scope section has exactly one causal path:

> design reads your Scope prose → design writes `files_to_touch` → *that* becomes enforceable.

It is upstream persuasion that only becomes machine-enforced once design launders it into the plan.
**Nothing ever checks your Scope block against the delivered diff.** OSS has no ticket-declared scope
lock — the SaaS's candidate context-files were specified as *advisory input to design*, *"not a hard
scope lock"* (`build-operations.md:204-205`), and even that isn't built.

#### You are not expected to know the files in advance

`design:dispatch` holds `Read, Grep, Glob, WebSearch, WebFetch` (`tool-allowlists.ts:11`) and is told
(`prompts/design.md:8-10`):

> Before planning, read the files, tests, config, and docs this ticket will touch. **Do not guess
> file paths**, APIs, command names, or test strategy the repo can answer — ground the plan in what
> you actually find.

**Naming files is design's job, not yours.** The hard gate — `validateExtraction`
(`extract-schema.ts:100-140`), *"every planned unit must name ≥1 file"* — applies to the **plan**
design produces after reading the repo, **not to your ticket**. A ticket that names no file paths at
all can pass extraction cleanly.

#### Guessing is worse than silence

`design-review.md:29` is explicit that a named path is barely checked:

> Named file paths are specific and plausible (the gate only checks that ≥1 file is named, **not that
> it exists or is the right one**).

So a confidently wrong file path in your ticket pollutes design's grounding and survives into the
plan unchallenged. Write file paths **only to the precision your evidence supports.**

#### The practical split

- **Scope OUT — always write it.** It is a *decision*, not a discovery. You can say "don't touch the
  daemon" or "don't add an `rm` capability" without knowing anything about the code. It costs nothing,
  needs no investigation, and is your only defence against scope creep. Name the sibling ticket that
  owns the excluded work.
- **Scope IN — write it only to the precision you've earned.** If you've investigated (a bench run, an
  audit, a transcript), name the files and quote the lines: ENG-341 and ENG-332 are precise *because*
  they were written after that work. If you haven't, describe the **outcome you want** and let design
  find the files. An honest "I don't know which files" beats a plausible wrong guess.

Don't list the *test* that proves an AC — `checks:dispatch` authors and names that file itself
(`prompts/design-extract.md:27`).

### 4.3 Ticket size changes the pipeline

Track sizing is **plan-derived, not ticket-derived** (`src/dispatch/track-sizing.ts`) — but your
scoping produces the plan:

- Plan yields **≥2 work units → `full` track** → gets the upfront plan review (`design:review`).
- Plan yields **1 unit → `fast` track → skips plan review entirely.**

A ticket scoped to a single trivial unit trades away its design review. Usually the right trade for a
genuine 4-line change (ENG-332 is the model) — but don't scope a *subtle* change to one unit and
expect the plan to get reviewed.

(With `complexityGrading` enabled — **off by default**, `runtime-config.ts:13` — `combineTrack` uses
`overall >= 5 || units >= 5` instead.)

### 4.4 A richer ticket never buys a shorter pipeline

`build-operations.md:195-205` rejects a "pre-scoped skips design" track outright:

> A SaaS-fed ticket carries more context … but the harness's **design stage always runs,
> full-strength** … There is **no "pre-scoped" track**.

Detail improves the *plan*. It never skips a step.

### 4.5 The label does almost nothing

`typeLabel` is derived from label names, case-insensitively, first match wins, **defaulting to
`Feature`** (`ticket-source.ts:20-26`). It affects **exactly one thing**: the branch prefix — `Bug` →
`fix/`, else `feat/` (`ticket-source.ts:29-31`). It reaches **no prompt**. It does not affect track,
checks, review, or scope. Set it correctly, then stop thinking about it.

### 4.6 One ticket, one concern

Two unrelated concerns in one description produce a plan that satisfies both partially. Split them.
ENG-332 is the exemplar — split out of ENG-331 *because* it was independently shippable in ~4 lines.
Refs is how you keep split tickets coherent.

---

## 5. Why the prose sections still matter

The ACs are what gets tested, but `design` reads the **whole description** — and design is where the
plan is born.

**What** anchors the plan. **Why** is load-bearing in a way that's easy to underestimate: the design
agent will re-derive rejected options unless you kill them explicitly. ENG-332's Why does this well —
it names the one candidate defence for the current ordering and proves it dead from code, so the plan
can't relitigate it.

`prompts/design.md:21-25` demands **requirements traceability**:

> List each acceptance criterion / explicit requirement from the ticket, and name the work unit(s)
> that satisfy it. If a requirement is intentionally out of scope, say so and why. **An unmapped
> requirement is a completeness gap the reviewer will catch.**

Note "acceptance criterion **/ explicit requirement**": a requirement stated only in prose is still
traceable. Prose requirements are real — they're just not *tested*, because only checklist items
become ACs. **If it must be verified, it goes in the checklist.**

But be precise about how much that traceability block buys you, because the reviewer that checks it
is working blind — see §5.1.

### 5.1 The design reviewer cannot see your ticket

`design-review.md:5` tells the plan reviewer to read *"the plan, the ticket requirements, and the
codebase"*, and `:25` asks it to *"cross-check the plan's Requirements-traceability block against the
ticket (nothing extra, nothing missing)"*.

It cannot. `designReviewVars` (`prompt-vars.ts:198`) passes only `ident`, `title`, and `slug` —
**not `description`**. Its tools are `[Read, Grep, Glob]` (`tool-allowlists.ts:19`), worktree-only,
with no issue-tracker access by design (capability isolation, move 4). The ticket description is
never written into the worktree. The reviewer has no path to your ticket text.

What it actually reads is the plan's traceability block — which is *design's own transcription* of
your requirements. So it can verify the block is **internally consistent** (every requirement listed
maps to a unit), but it cannot verify **fidelity** (that the list is complete). If design silently
drops a requirement, the block won't mention it, and the reviewer cannot know.

**Consequence for you:** "the reviewer will catch an unmapped requirement" holds only for
requirements design already noticed. A requirement design misses is missed silently by both. The
defence is not the reviewer — it's the checklist: an AC becomes a `acceptance_criterion` row and an
authored check that must go red, entirely independently of whether design ever mentioned it. **That
is the only mechanism that survives design forgetting about it.**

(This looks like a genuine defect rather than an intended design — the prompt asks for a check the
substrate makes impossible, and it sits under a "ground truth over self-report" invariant. Worth a
ticket; not one this document can fix.)

---

## 6. Pre-flight checklist

Before handing a ticket to `styre run`:

- [ ] Title is a standalone claim — every step sees it, and nothing else of your ticket.
- [ ] Exactly one label: `Bug` / `Feature` / `Improvement`. (Absent → `Feature` → `feat/` prefix.)
- [ ] The description has a real `- [ ]` checklist. (No checklist = one coarse whole-description AC.)
- [ ] **No `- [ ]` outside `## Acceptance criteria`.**
- [ ] Every AC is readable and verifiable **with the rest of the ticket covered up**.
- [ ] Every AC names an observable output and, where applicable, its specific expected value.
- [ ] No AC would be satisfied by a trivial stub (that's `weak` → re-author).
- [ ] Every AC would fail on today's code.
- [ ] The gate line (`bun test`, `tsc --noEmit`, `bun run lint`) is the last AC.
- [ ] Any file path you named, you have actually verified. (Naming none is fine — design reads the
      repo. A wrong path is worse than no path.)
- [ ] Scope OUT is present and names the sibling ticket for anything excluded.
- [ ] Why cites ground truth, and kills the obvious rejected alternatives.
- [ ] One concern.

---

## 7. Worked reference

**ENG-341** (`fix(dispatch): out-of-scope rejection must describe the real post-state`) is the best
full-size exemplar in the project:

- **What** quotes the offending code with a `file:line` ref.
- **Why** proves the defect from a transcript (*"I can't use `rm`…"*), quantifies the cost (40-47% of
  messages are permission-denial churn), and cites the artifacts directory.
- **Scope IN** uses `*` bullets — zero checkboxes outside the AC block.
- **Scope OUT** names five things it won't do, each with a reason and a sibling ticket.
- Its ACs are individually self-contained and observable — *"For a tracked-edit offender the message
  states the file still exists and the edit was reverted"* is testable with the rest of the ticket
  covered up. That's the bar.

**ENG-332** is the small-ticket exemplar: a ~4-line change, one work unit, fast track, with a Why
longer than the change because it proves the reorder is safe.
