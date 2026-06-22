import complexityGradeTemplate from "../../prompts/design-complexity-grade.md" with {
  type: "text",
};
import designExtractTemplate from "../../prompts/design-extract.md" with { type: "text" };
import designReviewTemplate from "../../prompts/design-review.md" with { type: "text" };
import designTemplate from "../../prompts/design.md" with { type: "text" };
import implementTemplate from "../../prompts/implement.md" with { type: "text" };
import reviewTemplate from "../../prompts/review.md" with { type: "text" };
import type { Profile } from "./profile.ts";

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
    ...profile.promptVars,
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
    ...profile.promptVars,
  };
}

export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: { seq: number; kind: string; title: string | null },
  profile: Profile,
  feedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: profile.commands.test ?? "",
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
