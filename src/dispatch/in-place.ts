import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Refuse in-place unless (detached HEAD OR .styre-disposable marker) AND no un-committed tracked
 *  work. Untracked files (e.g. an editable env's `.so`/`.egg-info` residue) must NOT trip this —
 *  `--untracked-files=no` excludes them from the dirty check by design. */
export function assertInPlaceSafe(repoPath: string, git: GitRun = defaultGit): void {
  const detached = git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath) === "HEAD";
  const marker = existsSync(join(repoPath, ".styre-disposable"));
  if (!detached && !marker) {
    throw new Error(
      `--in-place refused: ${repoPath} is on a named branch and has no .styre-disposable marker; refusing to mutate a checkout that may be owned (use a detached HEAD or write .styre-disposable).`,
    );
  }
  if (git(["status", "--porcelain", "--untracked-files=no"], repoPath) !== "") {
    throw new Error(`--in-place refused: ${repoPath} has uncommitted tracked changes.`);
  }
  console.error(
    `IN-PLACE: styre will mutate ${repoPath} on a branch (HEAD ${git(["rev-parse", "--short", "HEAD"], repoPath)}).`,
  );
}

/** Assert the active env's <pkg> for each python component resolves UNDER repoPath — else fail
 *  fast, so in-place never degrades into provision's editable-remediation recompile. */
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
  const importName = pythonImportName(repoPath);
  if (importName === undefined || !isValidImportName(importName)) return; // can't derive → skip (reuse just won't fire)
  const scriptDir = mkdtempSync(join(tmpdir(), "styre-inplace-"));
  try {
    const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
    writeFileSync(scriptPath, SOURCE_CHECK_SCRIPT);
    const res = await run(`${interp} "${scriptPath}" "${importName}" "${repoPath}"`, {
      cwd: repoPath,
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `--in-place: the active environment's '${importName}' is not installed against the repo root ${repoPath} ` +
          `(source-check exit ${res.exitCode}). In-place requires the editable env to target the repo root.`,
      );
    }
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}
