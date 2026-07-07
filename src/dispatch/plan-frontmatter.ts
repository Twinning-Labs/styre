// src/dispatch/plan-frontmatter.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The `linear:` value from a plan markdown file's leading `---`-fenced frontmatter, or null.
 *  A tiny reader (no YAML dep): only the leading frontmatter block is scanned, so a `linear:`
 *  mention in the plan BODY does not count. */
export function planFrontmatterLinear(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // missing/unreadable
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm === null) return null;
  const line = fm[1].match(/^linear:\s*(\S+)\s*$/m);
  return line ? line[1] : null;
}

/** True iff the given `docs/plans/` dir holds a `.md` whose frontmatter `linear:` equals `ident`
 *  — a plan for THIS ticket exists. False if the dir is absent. */
export function hasTicketPlan(plansDir: string, ident: string): boolean {
  if (!existsSync(plansDir)) return false;
  return readdirSync(plansDir)
    .filter((f) => f.endsWith(".md"))
    .some((f) => planFrontmatterLinear(join(plansDir, f)) === ident);
}
