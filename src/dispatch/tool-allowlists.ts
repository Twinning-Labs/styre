/** Per-step tool allowlists (capability isolation, move 4 / control-loop §4). Tool-NAME sets
 *  passed to `claude -p --allowed-tools`. NO outward tools anywhere (no gh/git push/Linear/curl);
 *  the worktree is the only writable surface. */
const READ_ONLY = ["Read", "Grep", "Glob"];

// `implement:dispatch` and `checks:dispatch` get Bash scoped at dispatch time to the profile's
// declared runner commands (see `allowlistFor`); when no runners resolve (empty or all-unavailable
// profile) the `Bash` token is dropped entirely — the agent keeps Write/Edit but has no shell
// access. `checks:dispatch` uses it to run its own authored checks and confirm they fail RED-first.
const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": [...READ_ONLY, "Write", "Edit", "WebSearch", "WebFetch"],
  "implement:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
  "checks:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
  "checks:classify": [...READ_ONLY],
  "checks:arbitrate": [...READ_ONLY],
  "docs:revise": [...READ_ONLY, "Write", "Edit"],
  "design:extract": [...READ_ONLY],
  "design:size": [...READ_ONLY],
  "design:review": [...READ_ONLY],
  review: [...READ_ONLY],
  "merge:pr-ensure": [...READ_ONLY],
  "setup:enrich": [...READ_ONLY],
  "setup:discover": [...READ_ONLY],
};

/** Resolve the tool allowlist for a step. For `implement:dispatch` and `checks:dispatch`, bare
 *  `Bash` is replaced with `Bash(<cmd>:*)` entries scoped to the profile's runner commands (control-loop S2:
 *  "profile's kind-appropriate runners only … no arbitrary Bash"). Defense-in-depth atop the
 *  scrubbed verify env: an agent can't stage and invoke arbitrary commands outside the declared
 *  runners. With no runner commands (empty runners or all-unavailable profile), the `Bash` token
 *  is dropped entirely — never bare unscoped Bash. */
export function allowlistFor(handlerKey: string, opts?: { runnerCommands?: string[] }): string[] {
  const tools = ALLOWLISTS[handlerKey];
  if (tools === undefined) {
    throw new Error(`allowlistFor: no tool allowlist for handlerKey '${handlerKey}'`);
  }
  if (handlerKey === "implement:dispatch" || handlerKey === "checks:dispatch") {
    const runners = [...new Set((opts?.runnerCommands ?? []).map((c) => c.trim()).filter(Boolean))];
    const bash = runners.map((c) => `Bash(${c}:*)`);
    // runners=[] ⇒ flatMap yields nothing for the "Bash" token → Bash dropped entirely, never bare
    return tools.flatMap((t) => (t === "Bash" ? bash : [t]));
  }
  return [...tools];
}
