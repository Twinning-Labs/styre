import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "./profile.ts";

/** One `prepare` install command to run, resolved against the worktree. */
export interface ProvisionAction {
  component: string;
  command: string;
  cwd: string;
}

/** Is this component's dependency install already complete? Node/sveltekit: a **completed**
 *  `node_modules` (marker `node_modules/.package-lock.json`, written by npm/yarn on success —
 *  review F6; a bare/partial `node_modules/` dir is NOT sufficient). Python + unknown kinds:
 *  always re-install; correctness is assured by the post-install source check (Task 5). */
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  if (kind === "node" || kind === "sveltekit") {
    return existsSync(join(compAbsDir, "node_modules", ".package-lock.json"));
  }
  return false;
}

/** Plan the `provision` step's install actions: one per prepare-bearing, not-yet-ready
 *  component. A component with no `prepare` is skipped (graceful degradation — never a hard
 *  fail at run-start). */
export function planProvision(components: Component[], worktreePath: string): ProvisionAction[] {
  const out: ProvisionAction[] = [];
  for (const c of components) {
    if (!c.prepare) continue;
    const cwd = join(worktreePath, c.dir ?? "");
    if (isComponentReady(c.kind, cwd)) continue;
    out.push({ component: c.name, command: c.prepare, cwd });
  }
  return out;
}
