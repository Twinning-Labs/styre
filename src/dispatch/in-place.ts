import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonImportName } from "../setup/lang/python.ts";
import { runCommand } from "../util/run-command.ts";
import type { Profile } from "./profile.ts";
import {
  SOURCE_CHECK_SCRIPT,
  SOURCE_CHECK_SCRIPT_NAME,
  isValidImportName,
  resolvePythonInterpreter,
} from "./provision.ts";

type GitRun = (args: string[], cwd: string) => string;
const defaultGit: GitRun = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

export function discoverRepoRoot(cwd: string = process.cwd(), git: GitRun = defaultGit): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error(
      `--in-place: no git repo at the working directory ${cwd}; launch with WORKDIR / docker -w set to the checkout.`,
    );
  }
}

/** Repo-scoped disposability signal: a REGULAR file <repoPath>/.styre-disposable. Defense-in-depth
 *  against misuse, NOT proof (a mount/hook/commit could forge it — see the design doc). */
export function assertInPlaceMarker(repoPath: string): void {
  const m = join(repoPath, ".styre-disposable");
  if (!existsSync(m) || !lstatSync(m).isFile()) {
    throw new Error(
      `--in-place refused: no .styre-disposable marker (regular file) at ${repoPath}; refusing to mutate a checkout that may be owned.`,
    );
  }
}

/** Refuse in-place unless a .styre-disposable marker (regular file) is present AND there is no
 *  un-committed tracked work. Untracked files (e.g. an editable env's `.so`/`.egg-info` residue)
 *  must NOT trip this — `--untracked-files=no` excludes them from the dirty check by design. */
export function assertInPlaceSafe(repoPath: string, git: GitRun = defaultGit): void {
  assertInPlaceMarker(repoPath);
  if (git(["status", "--porcelain", "--untracked-files=no"], repoPath) !== "") {
    throw new Error(`--in-place refused: ${repoPath} has uncommitted tracked changes.`);
  }
  console.error(
    `IN-PLACE: mutating ${repoPath} on a branch (HEAD ${git(["rev-parse", "--short", "HEAD"], repoPath)}).`,
  );
}

/** Assert the active env's <pkg> for EACH python component resolves UNDER that component's own
 *  dir — else fail fast, so in-place never degrades into provision's editable-remediation
 *  recompile. Mirrors how `provision` derives per-component identity (`join(worktreePath, c.dir)`,
 *  see `src/dispatch/handlers.ts`): a multi-python profile with a component in a subdir must be
 *  checked on ITS OWN dir, not just the repo root — checking only the root left subdir components
 *  unchecked (whole-branch review I-1). */
export async function assertInPlaceIdentity(
  repoPath: string,
  profile: Profile,
  run: typeof runCommand = runCommand,
): Promise<void> {
  const pythonComponents = profile.components.filter((c) => c.kind === "python");
  if (pythonComponents.length === 0) return;
  let interp: string;
  try {
    interp = resolvePythonInterpreter();
  } catch {
    return; // no python → nothing to assert here
  }
  for (const component of pythonComponents) {
    const componentDir = join(repoPath, component.dir ?? "");
    const importName = pythonImportName(componentDir);
    if (importName === undefined || !isValidImportName(importName)) continue; // can't derive → skip THAT component (reuse just won't fire for it)
    const scriptDir = mkdtempSync(join(tmpdir(), "styre-inplace-"));
    try {
      const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
      writeFileSync(scriptPath, SOURCE_CHECK_SCRIPT);
      const res = await run(`${interp} "${scriptPath}" "${importName}" "${componentDir}"`, {
        cwd: componentDir,
        timeoutMs: 60_000,
      });
      if (res.exitCode !== 0) {
        throw new Error(
          `--in-place: the active environment's '${importName}' (component '${component.name}') is not installed against ${componentDir} (source-check exit ${res.exitCode}). In-place requires the editable env to target the repo root.`,
        );
      }
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  }
}
