import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { listActiveByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { signalForAcCheck } from "../db/repos/ground-truth-signal.ts";
import { fileContentAt } from "./worktree.ts";

export interface IntegrityViolation {
  acId: number;
  acCheckId: number;
  path: string;
  reason: "check-file-modified" | "conftest-modified" | "missing-authoring-sha";
}

/** The conftest.py paths from the check file's directory up to (and including) the repo root.
 *  Freezing these closes the dominant autouse-fixture transitive-tamper vector (§7). A conftest that
 *  never existed (null at both shas) is not a violation; one that appeared or changed is. */
function conftestChain(testPath: string): string[] {
  const out: string[] = [];
  let dir = dirname(testPath);
  while (dir && dir !== "." && dir !== "/") {
    out.push(join(dir, "conftest.py"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out.push("conftest.py"); // repo-root conftest
  return [...new Set(out)];
}

/** §2b integrity gate: every ACTIVE ac_check's test file (and any conftest.py in its dir chain) must
 *  be byte-identical between its checks:dispatch authoring sha and the verify HEAD. A difference means
 *  implement rewrote the check it is gated by. Superseded (re-authored-away) checks are NOT frozen —
 *  only the live generation gates. Reads both versions with `fileContentAt` (git show <sha>:<path>) —
 *  added-only check files (M2 §5.1) make a whole-file freeze clean. */
export function checkIntegrityViolations(
  db: Database,
  ticketId: number,
  worktreePath: string,
  headSha: string,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  for (const check of listAcChecks(db, ticketId)) {
    if (check.test_path === null) continue;
    const authoringSha = signalForAcCheck(db, check.id)?.row.branch_head_sha ?? null;
    if (authoringSha === null) {
      violations.push({
        acId: check.ac_id,
        acCheckId: check.id,
        path: check.test_path,
        reason: "missing-authoring-sha",
      });
      continue;
    }
    if (
      fileContentAt(authoringSha, check.test_path, worktreePath) !==
      fileContentAt(headSha, check.test_path, worktreePath)
    ) {
      violations.push({
        acId: check.ac_id,
        acCheckId: check.id,
        path: check.test_path,
        reason: "check-file-modified",
      });
    }
    for (const conftest of conftestChain(check.test_path)) {
      if (
        fileContentAt(authoringSha, conftest, worktreePath) !==
        fileContentAt(headSha, conftest, worktreePath)
      ) {
        violations.push({
          acId: check.ac_id,
          acCheckId: check.id,
          path: conftest,
          reason: "conftest-modified",
        });
      }
    }
  }
  return violations;
}
