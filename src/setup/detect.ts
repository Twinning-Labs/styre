import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** Detect the package manager from a lockfile; default npm. */
export function detectPackageManager(repoDir: string): PackageManager {
  if (existsSync(join(repoDir, "bun.lock")) || existsSync(join(repoDir, "bun.lockb"))) return "bun";
  if (existsSync(join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoDir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The verify check-types setup knows how to wire from package.json scripts. */
const KNOWN_SCRIPTS = ["test", "build", "lint", "typecheck"];

/** Probe runnable commands from a Node repo's package.json scripts. Returns {} for non-Node repos
 *  (no package.json) — a valid, command-less profile the operator can fill in. Add a stack by adding
 *  a branch here (Cargo.toml, pyproject.toml, Makefile, …). */
export function detectCommands(repoDir: string): Record<string, string> {
  const pkgPath = join(repoDir, "package.json");
  if (!existsSync(pkgPath)) return {};
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return {}; // malformed package.json → no commands (degraded, not fatal)
  }
  const pm = detectPackageManager(repoDir);
  const commands: Record<string, string> = {};
  for (const name of KNOWN_SCRIPTS) {
    if (typeof scripts[name] === "string") commands[name] = `${pm} run ${name}`;
  }
  return commands;
}

/** Triggers that put a check-run on a PR's head sha — the only thing styre ever polls.
 *  `push` counts because styre pushes the branch before opening the PR. Deliberately excluded:
 *  `release`/`schedule`/`workflow_dispatch` (never fire on a PR head) and `merge_group` (targets a
 *  temp ref styre never polls, since styre never merges). */
const PR_HEAD_TRIGGERS = new Set(["push", "pull_request", "pull_request_target"]);

/** Does this workflow ever produce a check-run on a PR head? Handles all three YAML shapes:
 *  `on: push`, `on: [push, pull_request]`, and `on:\n  pull_request:\n    branches: [main]`.
 *
 *  Unparseable YAML returns TRUE (fail safe). Guessing "none" would make styre skip CI
 *  verification entirely and call a PR ready with no ground truth behind it; guessing "github"
 *  merely costs a wait. Prefer the annoying failure to the silent one.
 *
 *  Note `Bun.YAML` follows the YAML 1.2 core schema, so the bare key `on` stays the string "on"
 *  rather than parsing as boolean `true` (the classic YAML 1.1 Actions footgun). There is a test
 *  pinning that behaviour. */
function triggersOnPrHead(body: string): boolean {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(body);
  } catch {
    return true;
  }
  if (!doc || typeof doc !== "object") return false;
  const on = (doc as Record<string, unknown>).on;
  if (typeof on === "string") return PR_HEAD_TRIGGERS.has(on);
  if (Array.isArray(on)) return on.some((t) => typeof t === "string" && PR_HEAD_TRIGGERS.has(t));
  if (on && typeof on === "object") {
    return Object.keys(on).some((k) => PR_HEAD_TRIGGERS.has(k));
  }
  return false;
}

/** "github" if the repo has ≥1 GitHub Actions workflow that can report a check on a PR head, else
 *  "none". ("external" is not detectable — operator supplies it via --checks.)
 *
 *  ENG-340: the trigger check is load-bearing, not a nicety. A repo whose only workflow is
 *  `on: release` has workflow files but can never report a check-run on a PR head, so probing it as
 *  "github" makes the merge gate wait out the entire checks budget and then escalate — on every
 *  ticket, forever, with a true-but-useless "checks did not report" reason.
 *
 *  Known limitation: `branches:`/`paths:` filters are NOT evaluated. Those are per-PR (a docs-only
 *  ticket can get zero checks in a repo whose next ticket gets full CI), so no static repo-level
 *  value can express them — that is the grace-period verdict's job, not the probe's. */
export function detectChecksSystem(repoDir: string): "github" | "none" {
  const wfDir = join(repoDir, ".github", "workflows");
  if (!existsSync(wfDir)) return "none";
  try {
    const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    for (const f of files) {
      let body: string;
      try {
        body = readFileSync(join(wfDir, f), "utf8");
      } catch {
        continue;
      }
      if (triggersOnPrHead(body)) return "github";
    }
    return "none";
  } catch {
    return "none";
  }
}
