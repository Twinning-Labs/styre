/** The feature branch for a ticket: an explicit branch_name wins; else `<prefix>/<ident>`
 *  (prefix defaults to "feat"; Bug tickets use "fix" via branch_prefix). */
export function branchNameFor(ticket: {
  ident: string;
  branch_name: string | null;
  branch_prefix: string | null;
}): string {
  if (ticket.branch_name) {
    return ticket.branch_name;
  }
  return `${ticket.branch_prefix ?? "feat"}/${ticket.ident}`;
}
