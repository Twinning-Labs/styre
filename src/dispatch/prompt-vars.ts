import checksArbitrateTemplate from "../../prompts/checks-arbitrate.md" with { type: "text" };
import checksClassifyTemplate from "../../prompts/checks-classify.md" with { type: "text" };
import checksTemplate from "../../prompts/checks.md" with { type: "text" };
import complexityGradeTemplate from "../../prompts/design-complexity-grade.md" with {
  type: "text",
};
import designExtractTemplate from "../../prompts/design-extract.md" with { type: "text" };
import designReviewTemplate from "../../prompts/design-review.md" with { type: "text" };
import designTemplate from "../../prompts/design.md" with { type: "text" };
import docsReviseTemplate from "../../prompts/docs-revise.md" with { type: "text" };
import implementTemplate from "../../prompts/implement.md" with { type: "text" };
import reviewTemplate from "../../prompts/review.md" with { type: "text" };
import type { WorkUnitRow } from "../db/repos/work-unit.ts";
import { commandFor, impactedComponents } from "./components.ts";
import { DOC_PATHS_HINT } from "./docs-paths.ts";
import type { Component, Profile } from "./profile.ts";

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

/** The `{{detected_stacks}}` prompt value: the component summary, or an explicit no-detect note so
 *  the prompt's stack guidance still reads sensibly on repos `styre setup` could not classify. */
function detectedStacksVar(profile: Profile): string {
  return profile.components.length > 0
    ? stackSummary(profile.components)
    : "(no stacks auto-detected — infer the stack(s) and their build/test commands from the repo and its CI)";
}

function runtimeVars(profile: Profile): Record<string, string> {
  const rc = profile.runtimeContext;
  return {
    runtime_topology: rc.topology.type,
    runtime_topology_detail: rc.topology.detail,
    runtime_data_presence: rc.data.presence,
    runtime_data_detail: rc.data.detail,
    runtime_data_migration_tool: rc.data.migrationTool ?? "",
    runtime_caching_presence: rc.caching.presence,
    runtime_caching_detail: rc.caching.detail,
    runtime_observability_presence: rc.observability.presence,
    runtime_observability_detail: rc.observability.detail,
    runtime_config_secrets_presence: rc.configSecrets.presence,
    runtime_config_secrets_detail: rc.configSecrets.detail,
    runtime_documentation_presence: rc.documentation.presence,
    runtime_documentation_detail: rc.documentation.detail,
    runtime_release_mechanism: rc.releasePackaging.mechanism,
    runtime_release_detail: rc.releasePackaging.detail,
  };
}

export const CHECKS_TEMPLATE = checksTemplate;
export const CHECKS_CLASSIFY_TEMPLATE = checksClassifyTemplate;
export const CHECKS_ARBITRATE_TEMPLATE = checksArbitrateTemplate;
export const DESIGN_TEMPLATE = designTemplate;
export const DESIGN_REVIEW_TEMPLATE = designReviewTemplate;
export const DESIGN_COMPLEXITY_GRADE_TEMPLATE = complexityGradeTemplate;
export const EXTRACT_TEMPLATE = designExtractTemplate;
export const IMPLEMENT_TEMPLATE = implementTemplate;
export const REVIEW_TEMPLATE = reviewTemplate;
export const DOCS_REVISE_TEMPLATE = docsReviseTemplate;

export function extractVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    detected_stacks: detectedStacksVar(profile),
    ...profile.promptVars,
    ...runtimeVars(profile),
  };
}

export function designVars(
  ticket: { ident: string; title: string | null; description: string | null },
  profile: Profile,
  reviewFeedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    description: ticket.description ?? "",
    slug: profile.slug,
    stack: "",
    detected_stacks: detectedStacksVar(profile),
    review_feedback: reviewFeedback,
    ...profile.promptVars,
    ...runtimeVars(profile),
  };
}

export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: WorkUnitRow,
  profile: Profile,
  feedback = "",
  authoredChecks: { test_path: string | null }[] = [],
  gateFeedbackText = "",
  reviewFeedbackText = "",
): Record<string, string> {
  const files: string[] = unit.files_to_touch ? JSON.parse(unit.files_to_touch) : [];
  const impacted = impactedComponents(profile.components, files);
  const source = impacted.length > 0 ? impacted : profile.components;
  const testCommands = source
    .map((c) => commandFor(c, "test"))
    .filter((c): c is string => c !== undefined);
  const paths = authoredChecks.map((c) => c.test_path).filter((p): p is string => p !== null);
  const authored_checks =
    paths.length === 0
      ? ""
      : `## Acceptance checks (make these pass — do NOT edit the check files)\n\nThese test files encode this ticket's acceptance criteria. Read them and write code so they pass. You MUST NOT edit, weaken, or delete them (the runner freezes them and fails the gate on any change):\n${paths.map((p) => `- ${p}`).join("\n")}\n\nThese checks are authored separately and will read **red** when you run your project test command until you build the feature — that red is expected and is not a bug you introduced. Turn them green by implementing the work, never by touching the check files. They are **not** the tests listed under "Files this unit produces" — those are yours to write.`;
  // Channel A — the unit's declared scope, surfaced so completeness never grades implement against a
  // list it was never shown (STYRE-7 Fix B). Presented as a FLOOR, not a cage: completeness hard-gates
  // only under-delivery; over-delivery is advisory/reviewer-judged (brainstorm A3), so implement may
  // touch other files the work needs. Self-contained section (empty ⇒ no orphan header in implement.md).
  const files_to_touch =
    files.length === 0
      ? ""
      : `## Files this unit produces (your obligation)\n\nCreate or change **at least** these files — this is what "done" is checked against. Any product or regression tests listed here are **yours to write** (distinct from the frozen \`styre_checks/\` acceptance checks). You may touch other files if the work genuinely needs it — scope is reviewed, not enforced here.\n\n${files.map((f) => `- ${f}`).join("\n")}`;
  const test_plan =
    unit.test_plan && unit.test_plan.trim() !== ""
      ? `## How this unit is tested\n\n${unit.test_plan}`
      : "";
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: testCommands.join(" && "),
    stack: "",
    feedback,
    authored_checks,
    files_to_touch,
    test_plan,
    gate_feedback: gateFeedbackText,
    review_feedback: reviewFeedbackText,
    ...profile.promptVars,
  };
}

export function reviewVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    ...profile.promptVars,
  };
}

/** Prompt vars for `docs:revise` — mirrors `reviewVars` (Bash-less, reads the worktree + plan) plus
 *  the allowed-doc-paths hint, kept in lockstep with the `docScope` commit scope's `isDocPath`. */
export function docsVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    ...profile.promptVars,
    doc_paths: DOC_PATHS_HINT,
  };
}

export function complexityGradeVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  units: { kind: string }[],
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    unit_count: String(units.length),
    unit_kinds: units.map((u) => u.kind).join(", "),
    ...profile.promptVars,
  };
}

export function designReviewVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    ...profile.promptVars,
  };
}

/** Prompt vars for the plan-blind `checks:dispatch` author (M2 design §3): the ticket's acceptance
 *  criteria (each by its DB `id`, which the agent echoes as `ac_id`) + the detected stacks/test-commands.
 *  Deliberately NOT the implementation plan — the step is plan-blind. */
export function checksVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  acs: { id: number; text: string }[],
  feedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    detected_stacks: detectedStacksVar(profile),
    acceptance_criteria: acs.map((a) => `- ac_id=${a.id}: ${a.text}`).join("\n"),
    checks_feedback: feedback,
    ...profile.promptVars,
  };
}

/** One check the adjudicator must classify: its AC text, the authored test, the coarse RED-first
 *  bucket, and the recorded trace it judges from (never re-run). */
export interface AdjudicateItem {
  acCheckId: number;
  acText: string;
  testPath: string | null;
  testName: string;
  coarse: string;
  rawOutput: string;
}

/** Prompt vars for the `checks:classify` adjudicator (§5). Renders each check as a labeled block with
 *  its recorded trace; the agent echoes `ac_check_id` back in its sidecar. Read-only, plan-blind. */
export function adjudicateVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  items: AdjudicateItem[],
): Record<string, string> {
  const blocks = items
    .map(
      (it) =>
        `### ac_check_id=${it.acCheckId} (coarse: ${it.coarse})\n` +
        `Acceptance criterion: ${it.acText}\n` +
        `Test: ${it.testPath ?? "(no path)"} :: ${it.testName}\n` +
        `Recorded RED-first output:\n\`\`\`\n${it.rawOutput || "(empty)"}\n\`\`\``,
    )
    .join("\n\n");
  return {
    ident: ticket.ident,
    title: ticket.title ? ` — ${ticket.title}` : "",
    slug: profile.slug,
    checks_to_classify: blocks,
    ...profile.promptVars,
  };
}

/** One still-red check the `checks:arbitrate` adjudicator must blame: the AC text, the check's
 *  source at the implemented HEAD, and its recorded post-implement trace (never re-run). */
export interface ArbitrateItem {
  acCheckId: number;
  acText: string;
  testPath: string | null;
  testName: string;
  coarse: string;
  /** The recorded post-implement trace (ac-check-post-implement detail rawOutput, or the gate re-run). */
  trace: string;
  /** The check's source at the implemented HEAD (fileContentAt). */
  source: string;
}

/** Prompt vars for the `checks:arbitrate` adjudicator (M5): the AC text, check source, and recorded
 *  post-implement trace per still-red check. Read-only; the agent never re-runs. */
export function arbitrateVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  items: ArbitrateItem[],
): Record<string, string> {
  const blocks = items
    .map(
      (it) =>
        `### ac_check_id=${it.acCheckId} (coarse: ${it.coarse})\n` +
        `Acceptance criterion: ${it.acText}\n` +
        `Test: ${it.testPath ?? "(no path)"} :: ${it.testName}\n` +
        `Check source:\n\`\`\`\n${it.source || "(unavailable)"}\n\`\`\`\n` +
        `Recorded post-implement trace:\n\`\`\`\n${it.trace || "(empty)"}\n\`\`\``,
    )
    .join("\n\n");
  return {
    ident: ticket.ident,
    title: ticket.title ? ` — ${ticket.title}` : "",
    slug: profile.slug,
    checks_to_arbitrate: blocks,
    ...profile.promptVars,
  };
}
