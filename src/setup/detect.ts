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

/** "github" if the repo has ≥1 GitHub Actions workflow file, else "none". ("external" is not
 *  detectable — operator supplies it via --checks.) */
export function detectChecksSystem(repoDir: string): "github" | "none" {
  const wfDir = join(repoDir, ".github", "workflows");
  if (!existsSync(wfDir)) return "none";
  try {
    const hasWorkflow = readdirSync(wfDir).some((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    return hasWorkflow ? "github" : "none";
  } catch {
    return "none";
  }
}
