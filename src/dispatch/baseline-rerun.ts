import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listByTicket } from "../db/repos/ground-truth-signal.ts";
import {
  type CheckExecutionPlan,
  CheckExecutionPlanSchema,
  provesBehavioralFailure,
} from "./check-execution.ts";
import { type CheckRunResult, runCheckExecution } from "./checks-run.ts";
import type { CmdRunner } from "./reuse.ts";
import { type SuiteObservation, observeSuiteCommand } from "./suite-observation.ts";

/**
 * Was an advisory failure already there before this change? (ENG-403)
 *
 * WHY THIS EXISTS. `verify:integration` is advisory by design (M4 §8c), so a failure is reported
 * to the human rather than gating. But the PR said only
 *
 *     ⚠️ The full integration test run FAILED (first failing job: `frontend:build`).
 *
 * which leaves the reviewer unable to tell a regression from an already-broken repo. On
 * darkreader__darkreader-7241 `npm run build` failed identically on the PRISTINE base image — an
 * upstream tslib/rollup-plugin-typescript2 `exports` incompatibility — and the delivered change
 * was a one-line regex anchoring that could not have caused it. styre reported the failure and
 * never established that, so "advisory: a human should look" gave the human nothing to look with.
 *
 * Advisory must not become expensive: the baseline run happens ONLY when the HEAD run failed, so
 * a green advisory costs nothing.
 */

function git(args: string[], cwd: string): { ok: boolean } {
  return { ok: Bun.spawnSync(["git", ...args], { cwd }).success };
}

/**
 * The ticket's pre-implement clean HEAD: the sha the FIRST `ac-check-red-first` ran at, which is
 * authored before any implement dispatch. Null when the ticket has no AC check to anchor on — the
 * caller must then report "not established" rather than assuming either answer.
 */
export function preImplementBaselineSha(db: Database, ticketId: number): string | null {
  for (const s of listByTicket(db, ticketId)) {
    if (s.signal_type === "ac-check-red-first" && s.branch_head_sha) return s.branch_head_sha;
  }
  return null;
}

export interface BaselineObservation {
  version: 1;
  requestedSha: string;
  comparison: "unqualified";
  reason: string;
  execution: SuiteObservation | null;
}

/** A detached checkout is not a qualified equivalent environment. Preserve what ran without
 * claiming that equal exits prove the same failure, or that a passing baseline proves causality. */
export async function runAtBaseline(p: {
  repoPath: string;
  baselineSha: string;
  command: string;
  dir?: string;
  timeoutMs: number;
  onSpawn?: (pid: number) => void;
  onSettled?: () => void;
}): Promise<BaselineObservation> {
  const result: BaselineObservation = {
    version: 1,
    requestedSha: p.baselineSha,
    comparison: "unqualified",
    reason:
      "Baseline dependencies, source binding and test identities have not been qualified for comparison.",
    execution: null,
  };
  let wt: string | undefined;
  try {
    wt = mkdtempSync(join(tmpdir(), "styre-baseline-adv-"));
    if (!git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath).ok)
      return { ...result, reason: "Baseline checkout could not be prepared." };
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: wt });
    if (!head.success) return { ...result, reason: "Baseline checkout HEAD could not be read." };
    result.execution = await observeSuiteCommand({
      command: p.command,
      onSpawn: p.onSpawn,
      onSettled: p.onSettled,
      sha: head.stdout.toString().trim(),
      cwd: join(wt, p.dir ?? ""),
      timeoutMs: p.timeoutMs,
    });
    return result;
  } catch (error) {
    return { ...result, reason: `Baseline execution unavailable: ${String(error).slice(0, 1000)}` };
  } finally {
    if (wt) {
      git(["worktree", "remove", "--force", wt], p.repoPath);
      rmSync(wt, { recursive: true, force: true });
    }
  }
}

export type BindingVerdict = "binds" | "does-not-bind" | "unknown";

/**
 * Does a DELIVERED test actually bind? (ENG-402)
 *
 * WHY THIS EXISTS. styre proves its own acceptance checks bind — `ac-check-red-first` runs them
 * before the change and requires a failure, and `ac-check-classification` requires that failure to
 * be an assertion rather than a collection error. It applies neither to the regression tests the
 * implement stage writes into the repo. On darkreader__darkreader-7241 the AC check carried
 * `red_first_result: red, red_class: assertion`, while the regression test added to
 * `parse.tests.ts` — delivered to the reviewer in the PR — had no such evidence at all.
 *
 * A test that passes at the baseline proves nothing about the change: it would have passed before
 * it too. `expect(true).toBe(true)` is the degenerate case, but an over-mocked or wrongly-scoped
 * test fails the same way and reads as fine.
 *
 * The file is overlaid onto the baseline worktree because a NEW test does not exist at that sha —
 * the same overlay `replay-harness.ts` performs for a re-authored check. For a MODIFIED file this
 * runs the old tests alongside the new one; that is intended, since the delivered file as a whole
 * must distinguish the two revisions.
 */
export interface DeliveredTestParams {
  repoPath: string;
  baselineSha: string;
  /** Repo-relative path of the delivered test file. */
  testFile: string;
  /** Absolute path to read the delivered content from (the implemented worktree). */
  sourcePath: string;
  /** Legacy callers without a plan receive unknown; an arbitrary exit code is not evidence. */
  command?: string;
  dir?: string;
  plan?: CheckExecutionPlan;
  timeoutMs: number;
  run?: CmdRunner;
}

export async function deliveredTestEvidenceAtBaseline(
  p: DeliveredTestParams,
): Promise<{ verdict: BindingVerdict; execution?: CheckRunResult; reason?: string }> {
  const parsed = CheckExecutionPlanSchema.safeParse(p.plan);
  if (!parsed.success || parsed.data.testFile !== p.testFile || parsed.data.testName !== undefined)
    return { verdict: "unknown", reason: "missing or invalid file execution plan" };
  let wt: string;
  try {
    wt = mkdtempSync(join(tmpdir(), "styre-baseline-bind-"));
  } catch (err) {
    return { verdict: "unknown", reason: `baseline execution failed: ${String(err)}` };
  }
  try {
    if (!git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath).ok)
      return { verdict: "unknown", reason: "baseline worktree could not be prepared or executed" };
    const target = join(wt, p.testFile);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(p.sourcePath, "utf8"));
    const execution = await runCheckExecution({
      plan: parsed.data,
      worktreePath: wt,
      timeoutMs: p.timeoutMs,
      run: p.run,
    });
    const verdict = provesBehavioralFailure(parsed.data, execution)
      ? "binds"
      : execution.coarse === "green"
        ? "does-not-bind"
        : "unknown";
    return { verdict, execution };
  } catch (err) {
    return { verdict: "unknown", reason: `baseline execution failed: ${String(err)}` };
  } finally {
    git(["worktree", "remove", "--force", wt], p.repoPath);
    try {
      rmSync(wt, { recursive: true, force: true });
    } catch {
      /* worktree remove already cleaned it */
    }
  }
}

export async function deliveredTestBindsAtBaseline(
  p: DeliveredTestParams,
): Promise<BindingVerdict> {
  return (await deliveredTestEvidenceAtBaseline(p)).verdict;
}
