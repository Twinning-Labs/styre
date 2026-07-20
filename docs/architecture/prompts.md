# Prompts

`prompts/` holds the agent instruction templates — the behavioral surface of every LLM-backed step.
Editing a prompt changes what an agent is told to do; it is the highest-leverage editable artifact
in the repo after the code itself. This file is the map.

## How prompts are wired

- **Compiled into the binary.** Each `prompts/*.md` is imported as **text** via a Bun import
  attribute — `import designTemplate from "../../prompts/design.md" with { type: "text" }`
  (`src/dispatch/prompt-vars.ts`; the setup prompts are imported in `src/setup/discover.ts` and
  `src/setup/enrich.ts`). The `declare module "*.md"` shim lives in `src/md.d.ts`. There is no
  runtime file read — the built binary is self-contained.
- **Rendered by substitution.** `renderPrompt` (`src/dispatch/render-prompt.ts`) replaces every
  `{{name}}` placeholder from a variables bag. **A placeholder with no value is a hard failure**
  (`{ ok: false, missing }`) — a CL-PROFILE error the runner escalates, never a silently blank
  prompt.
- **Variables are assembled per step** in `src/dispatch/prompt-vars.ts` (e.g. `checksVars`,
  `designReviewVars`). The profile's `promptVars` map is spread **last** into every bag, so an
  operator can inject or override any computed variable from `profile.json`.

## The templates

Ten run-loop prompts + two setup prompts. The tier column is the model tier the step runs on
(`src/agent/tiers.ts`); "cold" means a fresh-context agent with no prior transcript.

| File | Step | Tier | What it instructs |
|---|---|---|---|
| `design.md` | `design:dispatch` | deep | Fused brainstorm + plan: produce the design/plan doc for the ticket. |
| `design-extract.md` | `design:extract` | cheap | Decompose the plan into `work_unit` rows (forced structured output). |
| `design-complexity-grade.md` | `design:size` | cheap | The cold complexity grader (coupling / blast-radius / difficulty) used when `complexityGrading` is on; chooses fast vs full track. |
| `design-review.md` | `design:review` | deep | Cold semantic plan-quality gate (full-track only). |
| `implement.md` | `implement:wuN:dispatch` | standard (deep on loopback) | Write the code and its tests for one work unit. |
| `checks.md` | `checks:dispatch` | standard | Derive acceptance criteria and author RED-first AC tests. |
| `checks-classify.md` | `checks:classify` | standard | Classify red-first check traces (red classes / green-on-HEAD dispositions / `weak`). |
| `checks-arbitrate.md` | `checks:arbitrate` | deep | Two-way blame on a still-red gate: `code-wrong` vs `check-wrong`. |
| `review.md` | `review` | deep | Independent cold-context code review → review findings. |
| `docs-revise.md` | `docs:revise` | cheap | Ticket-level documentation sync, within the `docs:revise` writable allowlist. |
| `setup-discover.md` | `styre setup` | — | Agent refinement of detected components/commands during setup. |
| `setup-enrich.md` | `styre setup` | — | Agent enrichment of the profile's runtime context during setup. |

For the step catalog, guards, and loopbacks these prompts sit inside, see
[`control-loop.md`](control-loop.md). For the model tiers, see [`configuration.md`](configuration.md).

## Editing a prompt

- Keep every `{{placeholder}}` that the step's variables function supplies, and don't introduce a
  new placeholder without adding its value in `src/dispatch/prompt-vars.ts` — an unsupplied
  placeholder fails the step.
- Prompts are covered by the test suite (`test/dispatch/`); run `bun test` after edits.
- A prompt change is a behavior change: note it in the PR and the `CHANGELOG`.
