import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listByAc } from "../db/repos/ac-check.ts";
import { signalForAcCheck } from "../db/repos/ground-truth-signal.ts";
import { type CheckExecutionPlan, resolveCheckExecution } from "./check-execution.ts";
import type { CoarseOrNone } from "./check-selector.ts";
import { type CheckRunResult, runCheckExecution } from "./checks-run.ts";
import type { Component } from "./profile.ts";
import { resolvePythonInterpreter } from "./provision.ts";
import type { CmdRunner } from "./reuse.ts";

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  return { ok: res.success, out: res.stdout.toString().trim() };
}

/** §5.2: the ticket's frozen clean-HEAD baseline for an AC = the ORIGINAL (first, lowest-id) check's
 *  `ac-check-red-first` sha, authored PRE-implement at the design-time clean HEAD. NOT
 *  `signalForAcCheck` on a re-author (authored at implemented HEAD → the cross-wiring trap). Null when
 *  the AC has no check or the original has no red-first signal. */
export function baselineShaForAc(db: Database, acId: number): string | null {
  const rows = listByAc(db, acId); // ORDER BY id → [0] is the original generation
  const original = rows[0];
  if (!original) return null;
  return signalForAcCheck(db, original.id)?.row.branch_head_sha ?? null;
}

export interface ReplayParams {
  repoPath: string;
  baselineSha: string;
  components: Component[];
  testFile: string;
  testName: string;
  /** The re-author's committed check content, overlaid onto the baseline (absent at that sha). */
  content: string;
  timeoutMs: number;
  run?: CmdRunner;
}

/** §5.2 clean-HEAD replay harness (the RED-first oracle for a re-author). Checks out the frozen
 *  baseline sha in a TEMP DETACHED worktree, overlays the re-author's check content (which does not
 *  exist at that sha — a bare checkout would give selected-none/error), runs the single check in the
 *  component dir, and returns the coarse bucket. Ground truth via `interpretRunOutput` — never the
 *  agent's word. The CALLER applies the predicate `coarse == red` installs; green/selected-none/error
 *  reject. Any harness fault (git/framework/interp) returns `error` → caller rejects (fails closed,
 *  never a false install). The temp worktree is always removed. */
export async function replayCheckEvidence(
  p: ReplayParams,
): Promise<(CheckRunResult & { plan: CheckExecutionPlan }) | null> {
  let plan: CheckExecutionPlan;
  try {
    plan = resolveCheckExecution({
      components: p.components,
      testFile: p.testFile,
      testName: p.testName,
    });
    if (plan.framework === "pytest")
      plan = resolveCheckExecution({
        components: p.components,
        testFile: p.testFile,
        testName: p.testName,
        interp: resolvePythonInterpreter(),
      });
  } catch {
    return null;
  }

  const wt = mkdtempSync(join(tmpdir(), "styre-baseline-wt-"));
  try {
    const added = git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath);
    if (!added.ok) return null;
    // Overlay the re-author content at the SAME repo-relative path (absent at the baseline sha).
    const target = join(wt, p.testFile);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, p.content);

    const result = await runCheckExecution({
      plan,
      worktreePath: wt,
      timeoutMs: p.timeoutMs,
      run: p.run,
    });
    return { ...result, plan };
  } finally {
    git(["worktree", "remove", "--force", wt], p.repoPath);
    try {
      rmSync(wt, { recursive: true, force: true });
    } catch {
      /* worktree remove already cleaned it */
    }
  }
}

export async function replayCheckAtBaseline(p: ReplayParams): Promise<CoarseOrNone> {
  return (await replayCheckEvidence(p))?.coarse ?? "error";
}
