import designTemplate from "../../prompts/design.md" with { type: "text" };
import implementTemplate from "../../prompts/implement.md" with { type: "text" };
import type { Profile } from "./profile.ts";

export const DESIGN_TEMPLATE = designTemplate;
export const IMPLEMENT_TEMPLATE = implementTemplate;

export function designVars(
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

export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: { seq: number; kind: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: profile.commands.test ?? "",
    ...profile.promptVars,
  };
}
