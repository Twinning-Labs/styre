import complexityGradeTemplate from "../../prompts/design-complexity-grade.md" with {
  type: "text",
};
import designExtractTemplate from "../../prompts/design-extract.md" with { type: "text" };
import designReviewTemplate from "../../prompts/design-review.md" with { type: "text" };
import designTemplate from "../../prompts/design.md" with { type: "text" };
import implementTemplate from "../../prompts/implement.md" with { type: "text" };
import reviewTemplate from "../../prompts/review.md" with { type: "text" };
import type { WorkUnitRow } from "../db/repos/work-unit.ts";
import { commandFor, impactedComponents } from "./components.ts";
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

export const DESIGN_TEMPLATE = designTemplate;
export const DESIGN_REVIEW_TEMPLATE = designReviewTemplate;
export const DESIGN_COMPLEXITY_GRADE_TEMPLATE = complexityGradeTemplate;
export const EXTRACT_TEMPLATE = designExtractTemplate;
export const IMPLEMENT_TEMPLATE = implementTemplate;
export const REVIEW_TEMPLATE = reviewTemplate;

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
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    description: ticket.description ?? "",
    slug: profile.slug,
    stack: "",
    detected_stacks: detectedStacksVar(profile),
    ...profile.promptVars,
    ...runtimeVars(profile),
  };
}

export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: WorkUnitRow,
  profile: Profile,
  feedback = "",
): Record<string, string> {
  const files: string[] = unit.files_to_touch ? JSON.parse(unit.files_to_touch) : [];
  const impacted = impactedComponents(profile.components, files);
  const source = impacted.length > 0 ? impacted : profile.components;
  const testCommands = source
    .map((c) => commandFor(c, "test"))
    .filter((c): c is string => c !== undefined);
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: testCommands.join(" && "),
    stack: "",
    feedback,
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
