/** Creds the daemon holds and must NOT leak into any subprocess it spawns (capability isolation,
 *  move-4: agents get no ambient LINEAR_API_KEY / GITHUB_TOKEN; the worktree is their only surface).
 *
 *  This boundary covers BOTH (a) the agent CLI itself and (b) the verify-time project commands the
 *  daemon runs against **agent-authored** worktree code (`runCommand`). (b) is the load-bearing one:
 *  the implement agent writes the source/tests that verify then executes, so running those under the
 *  daemon's full env would hand an agent's product the daemon's tokens — the exfiltration hole the
 *  scrub exists to close. Neither the agent CLI nor build/test needs these creds. */
export const AGENT_ENV_DENYLIST = ["LINEAR_API_KEY", "GITHUB_TOKEN"];

/** A curated env for a daemon-spawned subprocess: the parent env minus the daemon-held creds (and
 *  minus undefined values). Denylist, not allowlist, so the subprocess keeps whatever else it needs
 *  (PATH, the `claude` CLI's own auth, the project toolchain, …). */
export function agentEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v !== undefined && !AGENT_ENV_DENYLIST.includes(k)) out[k] = v;
  }
  return out;
}
