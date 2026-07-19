import { join } from "node:path";
import { commandFor } from "../dispatch/components.ts";
import type { Profile } from "../dispatch/profile.ts";
import { probeCommandExists } from "../setup/discover-schema.ts";

/** One command the run will execute, tagged with the component + slot it came from. */
export interface ToolProbe {
  component: string;
  label: "prepare" | "build" | "test" | "check";
  command: string;
  cwd: string;
}

/** Enumerate every command whose leading program the run must be able to invoke: each
 *  component's `prepare` (if any) plus its resolved `build`/`test`/`check`. `cwd` is the
 *  component's module root (`targetRepo` + `dir`) so an `npm run <script>` probe reads the
 *  right `package.json`. Pure — no filesystem or probe side effects. */
export function collectToolProbes(profile: Profile): ToolProbe[] {
  const probes: ToolProbe[] = [];
  for (const c of profile.components) {
    const cwd = join(profile.targetRepo, c.dir ?? "");
    if (c.prepare) {
      probes.push({ component: c.name, label: "prepare", command: c.prepare, cwd });
    }
    for (const label of ["build", "test", "check"] as const) {
      const command = commandFor(c, label);
      if (command) probes.push({ component: c.name, label, command, cwd });
    }
  }
  return probes;
}

/** A command whose leading program is not runnable on this machine. */
export interface MissingCommand {
  component: string;
  label: string;
  command: string;
  /** The program (or npm script) the operator must install/fix. */
  missing: string;
}

/** The human-facing "what's missing" hint for a command: the npm script for an `npm run X`,
 *  else the leading whitespace token (the program `command -v` looks up). */
export function missingHint(command: string): string {
  const npmRun = command.trim().match(/^npm run ([\w:-]+)/);
  if (npmRun) return `npm script "${npmRun[1]}"`;
  return command.trim().split(/\s+/)[0];
}

/** Probe every component command's leading program (faithful — exactly what the run will
 *  execute; no interpreter normalization). Returns the commands that are not runnable (an
 *  empty array means all present). The `probe` seam defaults to the real `probeCommandExists`
 *  and is injected in tests. */
export function preflightToolchain(
  profile: Profile,
  probe: (repoDir: string, command: string) => boolean = probeCommandExists,
): MissingCommand[] {
  const missing: MissingCommand[] = [];
  for (const p of collectToolProbes(profile)) {
    if (!probe(p.cwd, p.command)) {
      missing.push({
        component: p.component,
        label: p.label,
        command: p.command,
        missing: missingHint(p.command),
      });
    }
  }
  return missing;
}

/** The stderr message for a non-empty missing set. Names each command + the component/slot it
 *  belongs to + the missing program, so the operator can install everything in one pass. */
export function formatMissingTools(missing: MissingCommand[]): string {
  const lines = missing.map(
    (m) => `  - [${m.component} / ${m.label}] \`${m.command}\`  (missing: ${m.missing})`,
  );
  return [
    "styre run: cannot start — required commands are not runnable on this machine:",
    ...lines,
    "Install the missing tool(s) and re-run.",
  ].join("\n");
}
