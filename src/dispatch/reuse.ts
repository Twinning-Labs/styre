import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonImportName } from "../setup/lang/python.ts";
import { runCommand } from "../util/run-command.ts";
import type { Component } from "./profile.ts";
import {
  SOURCE_CHECK_SCRIPT,
  SOURCE_CHECK_SCRIPT_NAME,
  isValidImportName,
  resolvePythonInterpreter,
} from "./provision.ts";

export type CmdRunner = typeof runCommand;

const SOURCE_CHECK_TIMEOUT_MS = 60 * 1000;
const COLLECT_TIMEOUT_MS = 3 * 60 * 1000; // collection imports test modules; bounded well under a full run

/** Is a python env already provably ready to reuse for `test`, without reinstalling? True iff
 *  BOTH: (a) `import <importName>` resolves to a file under `absCwd` (the same worktree-source
 *  check `provision` runs post-install — Task 5's `SOURCE_CHECK_SCRIPT`, run from a fresh tempdir
 *  OUTSIDE the worktree so CPython's sys.path[0] can't false-pass a shadowed copy), AND (b)
 *  `pytest --collect-only` exits 0 (pytest itself + all its configured plugins are importable and
 *  every test module collects cleanly). An undefined/invalid `importName` is never "trust it" —
 *  it is a hard `false`. Reuse only when PROVEN. */
export async function pythonEnvReady(
  absCwd: string,
  importName: string | undefined,
  interp: string,
  run: CmdRunner = runCommand,
): Promise<boolean> {
  if (importName === undefined || !isValidImportName(importName)) return false;
  const scriptDir = mkdtempSync(join(tmpdir(), "styre-reuse-")); // OUTSIDE the worktree (Fix A)
  try {
    const scriptPath = join(scriptDir, SOURCE_CHECK_SCRIPT_NAME);
    writeFileSync(scriptPath, SOURCE_CHECK_SCRIPT);
    const src = await run(`${interp} "${scriptPath}" "${importName}" "${absCwd}"`, {
      cwd: absCwd,
      timeoutMs: SOURCE_CHECK_TIMEOUT_MS,
    });
    if (src.exitCode !== 0) return false;
    const collect = await run(`${interp} -m pytest --collect-only -q`, {
      cwd: absCwd,
      timeoutMs: COLLECT_TIMEOUT_MS,
    });
    return collect.exitCode === 0;
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

/** Resolve the actual command to run for a `test`-type gate: for a python component whose env is
 *  PROVEN ready (`pythonEnvReady`), skip the detected/configured command (e.g. `tox`, which would
 *  reinstall) and run pytest directly via the resolved interpreter — the reuse win. Every other
 *  case (non-python component, non-`test` checkType, no interpreter on PATH, or a probe that
 *  fails/can't be proven) returns `detectedCommand` unchanged — never a silent behavior change
 *  when reuse isn't proven safe. */
export async function reuseAwareTestCommand(
  c: Component,
  checkType: string,
  detectedCommand: string,
  absCwd: string,
  run: CmdRunner = runCommand,
): Promise<string> {
  if (checkType !== "test" || c.kind !== "python") return detectedCommand;
  let interp: string;
  try {
    interp = resolvePythonInterpreter();
  } catch {
    return detectedCommand;
  }
  const importName = pythonImportName(absCwd);
  if (await pythonEnvReady(absCwd, importName, interp, run)) return `${interp} -m pytest`;
  return detectedCommand;
}
