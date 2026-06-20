import { homedir } from "node:os";
import { join } from "node:path";

/** XDG state dir for Styre's persistent DB — macOS + Linux both use XDG here (build-operations §3.1). */
export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "styre");
}

/** Default path of the single SoT database. */
export function defaultDbPath(): string {
  return join(stateDir(), "styre.db");
}
