import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listByAc } from "../db/repos/ac-check.ts";
import { signalForAcCheck } from "../db/repos/ground-truth-signal.ts";
import {
  type CoarseOrNone,
  binaryFor,
  buildCheckSelector,
  frameworkFor,
} from "./check-selector.ts";
import { runCheckForRed } from "./checks-run.ts";
import { impactedComponents } from "./components.ts";
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
export async function replayCheckAtBaseline(p: ReplayParams): Promise<CoarseOrNone> {
  const comp = impactedComponents(p.components, [p.testFile])[0];
  const fw = comp ? frameworkFor(comp) : null;
  if (!comp || !fw) return "error";

  let interp: string | undefined;
  if (fw === "pytest") {
    try {
      interp = resolvePythonInterpreter();
    } catch {
      return "error";
    }
  }

  const wt = mkdtempSync(join(tmpdir(), "styre-baseline-wt-"));
  try {
    const added = git(["worktree", "add", "--detach", wt, p.baselineSha], p.repoPath);
    if (!added.ok) return "error";
    // Overlay the re-author content at the SAME repo-relative path (absent at the baseline sha).
    const target = join(wt, p.testFile);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, p.content);

    const sel = buildCheckSelector(fw, { testFile: p.testFile, testName: p.testName });
    const res = await runCheckForRed({
      framework: fw,
      binary: binaryFor(fw, { interp }),
      runArgs: sel.runArgs,
      // EXECUTOR NOTE (M3, non-blocking): this mirrors production `rerunOne`
      // (post-implement-rerun.ts) exactly — `cwd: join(wt, comp.dir ?? "")` is correct only when the
      // impacted component's `dir` is the repo root (empty). Both the harness's component selection
      // (`impactedComponents(...)[0]`) and this cwd join carry that same pre-existing single-root
      // assumption; they are not a new hazard this plan introduces, but if a future change adds a
      // non-root component, both `rerunOne` and this harness would need to pick the SAME component the
      // check actually lives under, or every replay will run in the wrong cwd and silently reject
      // (never a false install, but a false escalate). Keep the two in lockstep.
      cwd: join(wt, comp.dir ?? ""),
      timeoutMs: p.timeoutMs,
      run: p.run,
    });
    // FIX M2: return CoarseOrNone directly (includes "selected-none") — no widen-then-cast dance. The
    // caller (Task 6's reauthorCheckWrong) compares `=== "red"`, so every non-red value — green,
    // selected-none, error — rejects by construction; this signature change doesn't touch that.
    return res.coarse;
  } finally {
    git(["worktree", "remove", "--force", wt], p.repoPath);
    try {
      rmSync(wt, { recursive: true, force: true });
    } catch {
      /* worktree remove already cleaned it */
    }
  }
}
