import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
