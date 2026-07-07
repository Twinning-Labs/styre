/** Where an acceptance criterion came from: an explicit GFM task-list item, or the
 *  whole ticket description used as a single coarse AC when no checklist is present. */
export type AcSource = "checklist" | "whole-description";

export interface ParsedAc {
  text: string;
  source: AcSource;
}

/** A GFM task-list item: optional indent, a `-`, `*`, or `+` bullet, a `[ ]`/`[x]`/`[X]`
 *  checkbox, then at least one non-space char of text. The text is captured (group 1). */
const TASK_ITEM_RE = /^\s*[-*+]\s+\[[ xX]\]\s+(\S.*?)\s*$/;

/** Deterministically parse a ticket description into acceptance criteria (no LLM).
 *  Each GFM task-list item is one AC (`source: "checklist"`). If the description has
 *  NO task-list items, the whole trimmed description is a single AC
 *  (`source: "whole-description"`) — synthesis into finer ACs is deferred to the M2
 *  check-author. An empty/whitespace-only/null description yields no ACs. */
export function parseAcChecklist(description: string | null): ParsedAc[] {
  if (description === null || description.trim() === "") return [];
  const items: ParsedAc[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = line.match(TASK_ITEM_RE);
    if (m) items.push({ text: m[1].trim(), source: "checklist" });
  }
  if (items.length > 0) return items;
  return [{ text: description.trim(), source: "whole-description" }];
}
