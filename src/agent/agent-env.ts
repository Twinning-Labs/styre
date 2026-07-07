/** Creds the daemon holds and must NOT leak into a daemon-spawned subprocess (capability isolation,
 *  move-4). Two policies: the agent CLI keeps the selected provider's key (Anthropic *or* OpenAI —
 *  it needs it to authenticate); verify-time project commands (`runCommand`) do NOT — they run
 *  agent-authored worktree code, so the stricter `verifyEnv` also strips EVERY provider's key (F4).
 *  NOTE: this is a denylist of the daemon's named creds; verify still inherits any OTHER env secret
 *  (AWS_*, NPM_TOKEN, CI vars) — the real boundary for the broad secret surface is environment
 *  isolation (Docker), see the M-A residual risks. */
export const AGENT_ENV_DENYLIST = ["LINEAR_API_KEY", "GITHUB_TOKEN"];
// F4 (DEC-CX-6): strip EVERY provider's agent key from verify — agent-authored code runs there.
export const VERIFY_ENV_DENYLIST = [
  ...AGENT_ENV_DENYLIST,
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
];

function scrub(
  parentEnv: Record<string, string | undefined>,
  denylist: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v !== undefined && !denylist.includes(k)) out[k] = v;
  }
  return out;
}

/** Env for the agent CLI spawn: parent minus Linear/GitHub (keeps the provider's auth key). */
export function agentEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  return scrub(parentEnv, AGENT_ENV_DENYLIST);
}

/** Env for verify-time project commands: also strips every provider's auth key. */
export function verifyEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  return scrub(parentEnv, VERIFY_ENV_DENYLIST);
}
