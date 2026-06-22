/** The vendor-neutral ticket-ingestion contract. A `fetchTicket` read (issue-tracker port) maps a
 *  vendor issue (Linear/JIRA/...) onto this shape ONCE at trigger, to seed the SoT. The control
 *  loop then runs purely off the SoT — the tracker is never read again for control flow. */
export type TypeLabel = "Bug" | "Feature" | "Improvement";

export interface IngestedTicket {
  ident: string;
  title: string;
  description: string | null;
  typeLabel: TypeLabel;
  linearIssueUuid: string | null;
  url: string | null;
}

const TYPE_LABELS: TypeLabel[] = ["Bug", "Feature", "Improvement"];

/** Pick the ticket's type from its label names (case-insensitive); default Feature. Pure. */
export function deriveTypeLabel(labelNames: string[]): TypeLabel {
  const lowered = labelNames.map((n) => n.toLowerCase());
  for (const t of TYPE_LABELS) {
    if (lowered.includes(t.toLowerCase())) return t;
  }
  return "Feature";
}

/** Branch prefix from the type: Bug → fix, else feat (schema CHECK + branch-shape rule). Pure. */
export function branchPrefixFor(t: TypeLabel): "fix" | "feat" {
  return t === "Bug" ? "fix" : "feat";
}
