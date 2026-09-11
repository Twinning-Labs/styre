import { join } from "node:path";
import { commandFor } from "../dispatch/components.ts";
import type { Component, Profile } from "../dispatch/profile.ts";
import { probeCommandExists } from "../setup/discover-schema.ts";
import { toolchainError } from "./errors.ts";

/** One command the run will execute, tagged with the component + slot it came from. */
export interface ToolProbe {
  component: string;
  label: "prepare" | "build" | "test" | "check";
  command: string;
  cwd: string;
}

/** Enumerate every command whose leading program the run must be able to invoke. For a component
 *  WITH a `prepare` (install step), that is only the `prepare` tool — its `build`/`test`/`check`
 *  tools are install-provided, so provision supplies them (probing them pre-provision false-fails
 *  on a clean checkout). For a component WITHOUT a `prepare` (go/jvm), it is `build`/`test`/`check`
 *  — those are the true preconditions. `cwd` is the component's module root (`targetRepo` + `dir`)
 *  so an `npm run <script>` probe reads the right `package.json`. Pure — no side effects. */
export function collectToolProbes(profile: Profile): ToolProbe[] {
  const probes: ToolProbe[] = [];
  for (const c of profile.components) {
    const cwd = join(profile.targetRepo, c.dir ?? "");
    if (c.prepare) {
      // A component WITH a prepare installs its own build/test/check tools (php's
      // ./vendor/bin/phpunit, python's pytest/tox, node's local bins). Probing those before
      // provision runs would false-fail on a clean checkout — so probe only the prepare tool
      // itself, the one precondition provision cannot provide.
      probes.push({ component: c.name, label: "prepare", command: c.prepare, cwd });
      continue;
    }
    // No prepare (go/jvm): provision installs nothing, so the build/test/check tools ARE the
    // preconditions — this is the coverage the provision-first reorder structurally can't give.
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

/** The detail body for a non-empty missing set: one line per command, naming the
 *  component/slot it belongs to + the missing program, so the operator can install everything
 *  in one pass. The headline and recovery hint are supplied by `toolchainError`, which wraps
 *  this as its `detail` — this function must not duplicate them. */
export function formatMissingTools(missing: MissingCommand[]): string {
  return missing
    .map((m) => `- [${m.component} / ${m.label}] \`${m.command}\`  (missing: ${m.missing})`)
    .join("\n");
}

/** The run's verdict on each component's tooling (ENG-412). */
export interface ToolchainPartition {
  /** Every command whose leading program is not runnable — the full list, for the error body. */
  missing: MissingCommand[];
  /** Components the run must NOT use: at least one required tool is absent. */
  unusable: UnusableComponent[];
  /** The components the run CAN use. A component with no probes at all is usable by
   *  construction — nothing about its tooling is in question. */
  usable: Component[];
  /** True iff tooling is missing AND nothing usable is left — the run could accomplish
   *  nothing, so it must refuse to start (exit 69). */
  fatal: boolean;
}

/** One component the run will skip, and the tools that made it unusable. */
export interface UnusableComponent {
  component: string;
  missing: MissingCommand[];
}

/**
 * Decide, per component, whether the run can use it (ENG-412).
 *
 * WHY THIS IS NOT "any missing tool is fatal". That was the original rule, and on a Python repo
 * carrying a `package.json` — django, and a very common shape — it refused to start at all:
 * the Node detector correctly reports a `frontend` component, its `prepare` is `npm install`,
 * and a SWE-bench Python image has no npm. A pure-Python ticket then died before its first tick
 * over a component it would never touch.
 *
 * The preflight's INSTINCT is right (ENG-332: refuse rather than fail deep in a run); the
 * question it asked was wrong. "Is every component's tooling present?" is not the question that
 * decides whether a run is worth starting. "Can this run accomplish anything?" is. So a missing
 * toolchain disqualifies its own component, and only a run with NO usable component left is
 * fatal — which is still exactly the old behaviour for a single-component repo whose one
 * toolchain is absent.
 *
 * This never silently narrows scope: `unusable` is returned so the caller can say out loud what
 * it is skipping, both on stderr and in the PR. Pure — no side effects.
 */
export function partitionByToolchain(
  profile: Profile,
  probe: (repoDir: string, command: string) => boolean = probeCommandExists,
): ToolchainPartition {
  const missing = preflightToolchain(profile, probe);
  const brokenNames = new Set(missing.map((m) => m.component));
  const unusable: UnusableComponent[] = [...brokenNames].map((component) => ({
    component,
    missing: missing.filter((m) => m.component === component),
  }));
  const usable = profile.components.filter((c) => !brokenNames.has(c.name));
  return { missing, unusable, usable, fatal: missing.length > 0 && usable.length === 0 };
}

/** The stderr/PR sentence for a skipped component: what was skipped and what would fix it. */
export function formatUnusableComponents(unusable: UnusableComponent[]): string {
  return unusable
    .map(
      (u) =>
        `- ${u.component}: skipped — ${u.missing.map((m) => `\`${m.command}\` (missing: ${m.missing})`).join(", ")}`,
    )
    .join("\n");
}

/** What the run decided about its own toolchain: the components it will use, and the ones it
 *  will not. Returned rather than applied in place so the caller can report the loss. */
export interface ToolchainGate {
  /** `profile`, narrowed to the components this machine can actually use. */
  profile: Profile;
  /** Components dropped from that profile, with the tools whose absence dropped them. */
  unusable: UnusableComponent[];
}

/**
 * The run-start toolchain decision (ENG-412), extracted so it is testable without driving a
 * whole run: throws `toolchainError` (exit 69) iff NOTHING is usable, else returns the narrowed
 * profile plus what it dropped.
 *
 * The narrowing is returned as a NEW profile and never written back to disk. What is missing is a
 * property of this machine; the profile describes the repo. Conflating the two would let one
 * host's gaps be mistaken for the project's shape on the next run, on a different machine.
 */
export function applyToolchainGate(
  profile: Profile,
  probe: (repoDir: string, command: string) => boolean = probeCommandExists,
): ToolchainGate {
  const partition = partitionByToolchain(profile, probe);
  if (partition.fatal) {
    throw toolchainError(formatMissingTools(partition.missing));
  }
  if (partition.unusable.length === 0) return { profile, unusable: [] };
  return { profile: { ...profile, components: partition.usable }, unusable: partition.unusable };
}
