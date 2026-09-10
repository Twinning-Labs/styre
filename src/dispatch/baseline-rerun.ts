import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listByTicket } from "../db/repos/ground-truth-signal.ts";
import { runCommand } from "../util/run-command.ts";

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

export type BaselineVerdict = "pass" | "fail" | "error" | "unknown";

/**
 * Run `command` at `baselineSha` in a throwaway detached worktree.
 *
 * `unknown` on any harness-side problem (worktree add failed, spawn threw). Never guess: reporting
 * a failure as pre-existing when that was never shown would excuse a real regression, which is the
 * more dangerous of the two errors.
 */
export async function runAtBaseline(p: {
  repoPath: string;
  baselineSha: string;
  command: string;
  dir?: string;
  timeoutMs: number;
}): Promise<BaselineVerdict> {
  let wt: string;
  try {
    wt = mkdtempSync(join(tmpdir(), "styre-baseline-adv-"));
  } catch {
    return "unknown";
  }
  try {
    if (!git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath).ok) return "unknown";
    const run = await runCommand(p.command, {
      cwd: join(wt, p.dir ?? ""),
      timeoutMs: p.timeoutMs,
    });
    if (run.timedOut || run.exitCode === null) return "error";
    return run.exitCode === 0 ? "pass" : "fail";
  } catch {
    return "unknown";
  } finally {
    git(["worktree", "remove", "--force", wt], p.repoPath);
    try {
      rmSync(wt, { recursive: true, force: true });
    } catch {
      /* worktree remove already cleaned it */
    }
  }
}

/**
 * `true` = the failure pre-dates the change, `false` = the change introduced it, `undefined` =
 * could not be established. Note a baseline `error` yields `undefined`, not `true`: a baseline run
 * that could not complete has not shown the failure to be pre-existing.
 */
export function preexistingFrom(verdict: BaselineVerdict): boolean | undefined {
  if (verdict === "fail") return true;
  if (verdict === "pass") return false;
  return undefined;
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
export async function deliveredTestBindsAtBaseline(p: {
  repoPath: string;
  baselineSha: string;
  /** Repo-relative path of the delivered test file. */
  testFile: string;
  /** Absolute path to read the delivered content from (the implemented worktree). */
  sourcePath: string;
  /** `${launcher} ${fileSelector}` — the qualified launcher, so a wrapper's config is kept. */
  command: string;
  dir?: string;
  timeoutMs: number;
}): Promise<BindingVerdict> {
  let wt: string;
  try {
    wt = mkdtempSync(join(tmpdir(), "styre-baseline-bind-"));
  } catch {
    return "unknown";
  }
  try {
    if (!git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath).ok) return "unknown";
    const target = join(wt, p.testFile);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(p.sourcePath, "utf8"));
    const run = await runCommand(p.command, {
      cwd: join(wt, p.dir ?? ""),
      timeoutMs: p.timeoutMs,
    });
    if (run.timedOut || run.exitCode === null) return "unknown";
    // Non-zero at the baseline = the test distinguishes the two revisions = it binds.
    // Zero = it passed WITHOUT the change, so it proves nothing.
    return run.exitCode === 0 ? "does-not-bind" : "binds";
  } catch {
    return "unknown";
  } finally {
    git(["worktree", "remove", "--force", wt], p.repoPath);
    try {
      rmSync(wt, { recursive: true, force: true });
    } catch {
      /* worktree remove already cleaned it */
    }
  }
}
