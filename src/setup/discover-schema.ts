import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ComponentRoleEnum } from "../dispatch/profile.ts";
import type { Component } from "../dispatch/profile.ts";

/** What the read-only discovery agent proposes. Refines the deterministic skeleton. */
export const DiscoverSchema = z.object({
  components: z.array(
    z.object({
      name: z.string().min(1),
      /** Free-text stack description. Replaces the agent-authored `kind` (ENG-399): the prompt
       *  asked for "a precise free-text stack label" while every consumer switched on a closed
       *  set, so a good description (`browser-extension`) became an invalid discriminator. */
      label: z.string().min(1).optional(),
      /** ENG-425. What the component IS to the repo — the one judgment the agent could already
       *  make but had nowhere to put. Optional: an agent that says nothing leaves the scan's
       *  default (`primary`) in place, which is the pre-ENG-425 behaviour. */
      role: ComponentRoleEnum.optional(),
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
    const agentPaths = p.paths.filter((g) => {
      const t = g.trim();
      return !/^\*/.test(t) && !t.split("/").includes(".."); // no unanchored glob, no traversal segment
    });
    return {
      name: s.name,
      // SCAN-AUTHORITATIVE (ENG-399). `kind` is the runtime discriminator for `frameworkFor`,
      // `isComponentReady` and `EXTENSIONS_BY_KIND`; an agent value outside the closed set
      // silently disables all three. The agent's description is carried in `label` instead.
      kind: s.kind,
      // ENG-425. AGENT-AUTHORABLE, unlike `kind`, and deliberately so: `kind` is a runtime
      // discriminator a wrong value silently disables, whereas `role` only ever REMOVES a
      // component from the run — and a removal is reported on stderr and in the PR, so a wrong
      // one is visible rather than silent. The scan still anchors existence; this classifies
      // what the scan found. An agent that says nothing leaves the scan's `primary`.
      role: p.role ?? s.role,
      ...(p.label ? { label: p.label } : {}),
      paths: [...new Set([...s.paths, ...agentPaths])],
      commands: { ...s.commands, ...p.commands },
      ...(s.testFilePattern ? { testFilePattern: s.testFilePattern } : {}),
      extensions: s.extensions,
      // prepare is scan-authoritative (agent-unauthorable — not in DiscoverSchema); carry it verbatim.
      ...(s.prepare !== undefined ? { prepare: s.prepare } : {}),
      // dir is scan-authoritative (agent-unauthorable — not in DiscoverSchema); carry it verbatim.
      ...(s.dir !== undefined ? { dir: s.dir } : {}),
    };
  });
}

/** Package managers whose bare `<mgr> <word>` form usually means "run the script <word>". */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Subcommands that are the MANAGER's own, not a package.json script. `<mgr> <builtin>` is valid
 *  whenever the manager exists, so it must not be judged against the script list. Deliberately
 *  narrow: anything not listed is treated as a script name and must actually exist, which is the
 *  direction that catches typos. */
const RUNNER_BUILTINS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["install", "i", "ci", "add", "exec", "x", "publish", "pack", "link", "audit"]),
  pnpm: new Set(["install", "i", "add", "dlx", "exec", "publish", "pack", "link", "audit"]),
  yarn: new Set([
    "install",
    "add",
    "dlx",
    "exec",
    "publish",
    "pack",
    "link",
    "audit",
    "workspaces",
  ]),
  // `bun test` is bun's OWN test runner, not a script — listing it here keeps it from being
  // rejected on repos that have no "test" script.
  bun: new Set(["install", "i", "add", "x", "create", "test", "publish", "link"]),
};

/** npm maps these bare subcommands onto same-named package.json scripts. */
const NPM_SCRIPT_ALIASES = new Set(["test", "start", "stop", "restart"]);

/** Directories a repo's own tooling lives in but `command -v` never sees, because they are not
 *  on PATH as this probe invokes it. */
const LOCAL_BIN_DIRS = ["node_modules/.bin", ".venv/bin", "venv/bin", ".tox/bin", "bin"];

/**
 * The package.json script `command` invokes, or null when it is the manager's own subcommand
 * (or not a manager invocation at all).
 */
function scriptNameFor(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  const [mgr, first, second] = parts;
  if (!mgr || !first || !SCRIPT_RUNNERS.has(mgr)) return null;
  if (first === "run") return second ?? null;
  if (mgr === "npm") return NPM_SCRIPT_ALIASES.has(first) ? first : null;
  return RUNNER_BUILTINS[mgr]?.has(first) ? null : first;
}

function hasScript(repoDir: string, name: string): boolean {
  try {
    // NOTE: Bun.file(...).text() is ASYNC (empirically confirmed) — MUST use sync readFileSync.
    const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
    return Boolean(pkg.scripts?.[name]);
  } catch {
    return false; // absent or malformed package.json — no script to find
  }
}

function onPath(repoDir: string, bin: string): boolean {
  return Bun.spawnSync(["sh", "-c", 'command -v "$1"', "sh", bin], { cwd: repoDir }).success;
}

function inLocalBin(repoDir: string, bin: string): boolean {
  return LOCAL_BIN_DIRS.some((dir) => existsSync(join(repoDir, dir, bin)));
}

/**
 * True if the command's program resolves (typo/missing-tool probe only — NOT correctness, NOT
 * safety).
 *
 * ENG-414: this was wrong in BOTH directions, and every cell of the 2026-09-11 bench matrix lost
 * gates to it. It special-cased `^npm run` and otherwise ran `command -v <first token>`, so:
 *
 *   - `pnpm run lint` was accepted whenever `pnpm` existed, script or not — a typo'd script name
 *     sailed through.
 *   - `tsc --noEmit`, `jest`, `eslint`, `pytest` were REJECTED, because a repo's own tooling lives
 *     in `node_modules/.bin` or a virtualenv, neither of which is on PATH as this probe invokes
 *     it. styre then ran with fewer ground-truth gates than the repo actually supports:
 *     "python: no check command — styre cannot ground-truth-check this stack."
 *
 * Now: a manager script invocation (any of npm/pnpm/yarn/bun, with or without `run`) is checked
 * against the script list; the manager's own subcommands are checked as a binary; and a bare
 * program resolves from PATH *or* the repo's local bin directories.
 *
 * Still only a probe. It answers "could this run at all", never "is this the right command".
 */
export function probeCommandExists(repoDir: string, command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const script = scriptNameFor(trimmed);
  if (script !== null) return hasScript(repoDir, script);

  const bin = trimmed.split(/\s+/)[0];
  if (!bin) return false;
  return onPath(repoDir, bin) || inLocalBin(repoDir, bin);
}
