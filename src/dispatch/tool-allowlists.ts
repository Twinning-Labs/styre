/** Per-step tool allowlists (capability isolation, move 4 / control-loop §4). Tool-NAME sets
 *  passed to `claude -p --allowed-tools`. NO outward tools anywhere (no gh/git push/Linear/curl);
 *  the worktree is the only writable surface. */
const READ_ONLY = ["Read", "Grep", "Glob"];

// `implement:dispatch`'s Bash is scoped at dispatch time to the unit's impacted component runners
// (see `allowlistFor`); when no runners resolve (empty or all-unavailable profile) the `Bash`
// token is dropped entirely — the agent keeps Write/Edit but has no shell access.
const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": [...READ_ONLY, "Write", "Edit", "WebSearch", "WebFetch"],
  "implement:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
  "docs:revise": [...READ_ONLY, "Write", "Edit"],
  "design:extract": [...READ_ONLY],
  "design:size": [...READ_ONLY],
  "design:review": [...READ_ONLY],
  review: [...READ_ONLY],
  "merge:pr-ensure": [...READ_ONLY],
  "setup:enrich": [...READ_ONLY],
};

/** Resolve the tool allowlist for a step. For `implement:dispatch`, bare `Bash` is replaced with
 *  `Bash(<cmd>:*)` entries scoped to the unit's impacted component runners (control-loop S2:
 *  "profile's kind-appropriate runners only … no arbitrary Bash"). Defense-in-depth atop the
 *  scrubbed verify env: an agent can't stage and invoke arbitrary commands outside the declared
 *  runners. With no runner commands (empty runners or all-unavailable profile), the `Bash` token
 *  is dropped entirely — never bare unscoped Bash. */
export function allowlistFor(handlerKey: string, opts?: { runnerCommands?: string[] }): string[] {
  const tools = ALLOWLISTS[handlerKey];
  if (tools === undefined) {
    throw new Error(`allowlistFor: no tool allowlist for handlerKey '${handlerKey}'`);
  }
  if (handlerKey === "implement:dispatch") {
    const runners = [...new Set((opts?.runnerCommands ?? []).map((c) => c.trim()).filter(Boolean))];
    const bash = runners.map((c) => `Bash(${c}:*)`);
    // runners=[] ⇒ flatMap yields nothing for the "Bash" token → Bash dropped entirely, never bare
    return tools.flatMap((t) => (t === "Bash" ? bash : [t]));
  }
  return [...tools];
}
