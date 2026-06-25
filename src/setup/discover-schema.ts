import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Component } from "../dispatch/profile.ts";

/** What the read-only discovery agent proposes. Refines the deterministic skeleton. */
export const DiscoverSchema = z.object({
  components: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
      commands: z.record(z.string(), z.string()).default({}),
    }),
  ),
  repoCommands: z.record(z.string(), z.string()).default({}),
});
export type Discovery = z.infer<typeof DiscoverSchema>;

/** Reconcile agent proposal against the deterministic scan. The scan is authoritative on which
 *  components exist (matched by name); the agent refines kind, paths, and commands of those it
 *  recognizes. Agent-only components (not in the scan) are dropped — the scan anchors existence;
 *  the agent does not invent stacks. A scan component the agent didn't mention survives as-is. */
export function mergeComponents(scan: Component[], proposed: Component[]): Component[] {
  const byName = new Map(proposed.map((p) => [p.name, p]));
  return scan.map((s) => {
    const p = byName.get(s.name);
    if (!p) return s;
    // Agent may refine paths but cannot widen a component via an UNANCHORED glob (one starting with
    // `*`/`**` — e.g. `**`, `*`, `**/*.ts`, `*/**` — which matches broadly across the tree and would
    // run the component's commands on every diff + widen the implement Bash scope). Keep only globs
    // anchored to a literal first path segment. The scan's workspace anchors are always preserved.
    const agentPaths = p.paths.filter((g) => !/^\*/.test(g.trim()));
    return {
      name: s.name,
      kind: p.kind || s.kind,
      paths: [...new Set([...s.paths, ...agentPaths])],
      commands: { ...s.commands, ...p.commands },
      ...(s.testFilePattern ? { testFilePattern: s.testFilePattern } : {}),
    };
  });
}

/** True if the command's program resolves (typo/missing-tool probe only — NOT correctness, NOT
 *  safety). For an `npm run X`, checks the script exists in the cwd package.json; otherwise checks
 *  the binary on PATH. (`readFileSync`/`join` imported at the top of the file.) */
export function probeCommandExists(repoDir: string, command: string): boolean {
  const trimmed = command.trim();
  const npmRun = trimmed.match(/^npm run ([\w:-]+)/);
  if (npmRun) {
    try {
      // NOTE: Bun.file(...).text() is ASYNC (empirically confirmed) — MUST use sync readFileSync here.
      const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
      return Boolean(pkg.scripts?.[npmRun[1]]);
    } catch {
      return false;
    }
  }
  const bin = trimmed.split(/\s+/)[0];
  return Bun.spawnSync(["sh", "-c", `command -v ${bin}`], { cwd: repoDir }).success;
}
