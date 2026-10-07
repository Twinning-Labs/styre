import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { listByTicket } from "../db/repos/ground-truth-signal.ts";
import { type BlockingResult, deferCleanup, runBlocking } from "../util/process/door.ts";
import type { CmdRunner } from "../util/run-command.ts";
import {
  type CheckExecutionPlan,
  CheckExecutionPlanSchema,
  provesBehavioralFailure,
} from "./check-execution.ts";
import { type CheckRunResult, runCheckExecution } from "./checks-run.ts";
import type { Component } from "./profile.ts";
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

/** A checkout that writes the whole tree gets a longer bound than a probe (ENG-485 section 5.1). */
function git(args: string[], cwd: string, opts: { tree?: boolean } = {}): { ok: boolean } {
  return {
    ok: runBlocking(["git", ...args], {
      cwd,
      timeoutMs: opts.tree ? TREE_GIT_MS : 30_000,
    }).success,
  };
}

/** Writes a whole tree (`worktree add`) or deletes one (`worktree remove`): on a large repository
 *  this can pass 30 seconds on a healthy disk. */
const TREE_GIT_MS = 120_000;

/** A path as one shell word, so the manual command can be pasted as it is. */
const shellWord = (s: string): string =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

/** Every temporary worktree folder starts with this, directly in the temp folder: the baseline
 *  (`styre-baseline-adv-`), delivered test (`styre-baseline-bind-`) and replay (`styre-baseline-wt-`)
 *  checkouts. */
const TEMP_WORKTREE_PREFIX = "styre-baseline-";

/** The command that finishes the removal by hand, for what is left now. A worktree whose `.git` is
 *  gone (a removal cut short after deleting it) cannot be removed by `git worktree remove`: its
 *  folder is deleted and git's stale entry pruned instead (N2). */
function manualRemoval(repoPath: string, wt: string): string {
  return existsSync(join(wt, ".git"))
    ? `git -C ${shellWord(repoPath)} worktree remove --force ${shellWord(wt)}`
    : `rm -rf ${shellWord(wt)} && git -C ${shellWord(repoPath)} worktree prune`;
}

/** Whether git still lists `wt` as a worktree of the repo. A list that cannot be read counts as
 *  listed, so the removal is tried and its failure said. */
function registered(repoPath: string, wt: string): boolean {
  const r = runBlocking(["git", "worktree", "list", "--porcelain"], {
    cwd: repoPath,
    timeoutMs: 30_000,
    cleanup: true,
  });
  if (!r.success) return true;
  const names = new Set([wt]);
  try {
    names.add(realpathSync(wt));
  } catch {
    /* the folder is gone: git lists the path it was given */
  }
  return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && names.has(l.slice(9)));
}

/** Why a removal failed: a timeout or a signal is named, since neither leaves stderr (N3). */
function failure(r: BlockingResult): string {
  if (r.timedOut) return "timed out";
  if (r.signalCode) return `killed by ${r.signalCode}`;
  return r.stderr.trim().split("\n").join(" ") || `exit ${r.exitCode}`;
}

/** Removes a temporary detached worktree: unregisters it from the target repo, then deletes its
 *  folder. Throws when git cannot remove it, naming the worktree and the command that finishes it
 *  by hand (I2); the folder is then kept, so that command still works. */
function removeTempWorktree(repoPath: string, wt: string): void {
  // With no `.git` file, `worktree add` usually never registered it (refused, or failed), and only
  // the folder is left to delete. git is asked, since a removal cut short can delete `.git` first.
  if (existsSync(join(wt, ".git")) || registered(repoPath, wt)) {
    // `cleanup`: it only releases what the run took, so the door lets it through while a stop is
    // in progress, and the handler cuts its bound to the time it has left.
    const r = runBlocking(["git", "worktree", "remove", "--force", wt], {
      cwd: repoPath,
      timeoutMs: TREE_GIT_MS,
      cleanup: true,
    });
    if (!r.success) {
      throw new Error(
        `git worktree remove --force ${wt} failed (${failure(r)}); remove it with: ${manualRemoval(repoPath, wt)}`,
      );
    }
  }
  rmSync(wt, { recursive: true, force: true });
}

/** The removal of a temporary detached worktree (baseline, delivered test or replay), held with the
 *  door until it is released: the run code releases it in its `finally`, and a stop handler that
 *  ends Styre first makes it itself (m3), so the worktree is never left registered in the target
 *  repo silently. Returns the release. A failure on the release is said on stderr and does not
 *  replace the caller's result; during a stop the handler says it.
 *  `wt` must be a `styre-baseline-*` folder directly in the temp folder, as the call sites make it;
 *  any other path is refused before anything is held, since the removal deletes it (N5). */
export function deferWorktreeRemoval(repoPath: string, wt: string): () => void {
  if (dirname(wt) !== tmpdir() || !basename(wt).startsWith(TEMP_WORKTREE_PREFIX)) {
    throw new Error(
      `refusing to remove ${wt}: a temporary worktree must be a ${TEMP_WORKTREE_PREFIX}* folder directly in ${tmpdir()}`,
    );
  }
  const release = deferCleanup({
    run: () => removeTempWorktree(repoPath, wt),
    manual: () => `remove the worktree ${wt} with: ${manualRemoval(repoPath, wt)}`,
  });
  return () => {
    try {
      release();
    } catch (err) {
      process.stderr.write(
        `styre: could not remove a temporary worktree: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
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
  let removeWorktree: (() => void) | undefined;
  try {
    const wt = mkdtempSync(join(tmpdir(), "styre-baseline-adv-"));
    removeWorktree = deferWorktreeRemoval(p.repoPath, wt);
    if (
      !git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath, {
        tree: true,
      }).ok
    )
      return { ...result, reason: "Baseline checkout could not be prepared." };
    const head = runBlocking(["git", "rev-parse", "HEAD"], { cwd: wt, timeoutMs: 30_000 });
    if (!head.success) return { ...result, reason: "Baseline checkout HEAD could not be read." };
    result.execution = await observeSuiteCommand({
      command: p.command,
      onSettled: p.onSettled,
      sha: head.stdout.trim(),
      cwd: join(wt, p.dir ?? ""),
      timeoutMs: p.timeoutMs,
    });
    return result;
  } catch (error) {
    return { ...result, reason: `Baseline execution unavailable: ${String(error).slice(0, 1000)}` };
  } finally {
    removeWorktree?.();
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
  components?: Component[];
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
  const removeWorktree = deferWorktreeRemoval(p.repoPath, wt);
  try {
    if (
      !git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath, {
        tree: true,
      }).ok
    )
      return { verdict: "unknown", reason: "baseline worktree could not be prepared or executed" };
    const target = join(wt, p.testFile);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(p.sourcePath, "utf8"));
    const execution = await runCheckExecution({
      plan: parsed.data,
      components: p.components,
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
    removeWorktree();
  }
}

export async function deliveredTestBindsAtBaseline(
  p: DeliveredTestParams,
): Promise<BindingVerdict> {
  return (await deliveredTestEvidenceAtBaseline(p)).verdict;
}
