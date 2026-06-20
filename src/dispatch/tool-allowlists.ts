/** Per-step tool allowlists (capability isolation, move 4 / control-loop §4). Tool-NAME sets
 *  passed to `claude -p --allowed-tools`. NO outward tools anywhere (no gh/git push/Linear/curl);
 *  the worktree is the only writable surface. Fine-grained path scoping (design Write/Edit → docs/**,
 *  implement Bash → profile runners) is layered at the real dispatch + scope-check in M3b. */
const READ_ONLY = ["Read", "Grep", "Glob"];

const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": [...READ_ONLY, "Write", "Edit", "WebSearch", "WebFetch"],
  "implement:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
  "docs:revise": [...READ_ONLY, "Write", "Edit"],
  "design:extract": [...READ_ONLY],
  "design:review": [...READ_ONLY],
  review: [...READ_ONLY],
  "merge:pr-ensure": [...READ_ONLY],
};

export function allowlistFor(handlerKey: string): string[] {
  const tools = ALLOWLISTS[handlerKey];
  if (tools === undefined) {
    throw new Error(`allowlistFor: no tool allowlist for handlerKey '${handlerKey}'`);
  }
  return [...tools];
}
