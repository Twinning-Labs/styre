import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { listActiveByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { insertSignal } from "../db/repos/ground-truth-signal.ts";
import { type CoarseResult, binaryFor, frameworkFor } from "./check-selector.ts";
import { runCheckForRed } from "./checks-run.ts";
import { impactedComponents } from "./components.ts";
import type { Component } from "./profile.ts";
import { resolvePythonInterpreter } from "./provision.ts";
import type { CmdRunner } from "./reuse.ts";

export type GateOutcome = "green" | "gated-red" | "advisory-red" | "disposition" | "error";
export interface RerunResult {
  stillRed: number[]; // ac ids: a gated (assertion/absence) check that did NOT flip green
  advisory: number[]; // ac ids: an environmental check still red (report, don't block)
  ran: Array<{ acId: number; acCheckId: number; coarse: CoarseResult; outcome: GateOutcome }>;
}

async function rerunOne(
  p: RerunParams,
  testPath: string | null,
  selector: string,
): Promise<CoarseResult> {
  if (testPath === null) return "error";
  const comp = impactedComponents(p.components, [testPath])[0];
  const fw = comp ? frameworkFor(comp) : null;
  if (!comp || !fw) return "error";
  let interp: string | undefined;
  if (fw === "pytest") {
    // PATH-dependent (FIX 5c): resolves python3/python from $PATH, same as checks:dispatch. The
    // re-provisioned interpreter (any venv/conda activation the implement/provision step performed)
    // must be on PATH here, or this throws and the check fails closed (counted as still-red, never
    // a false-pass).
    try {
      interp = resolvePythonInterpreter();
    } catch {
      return "error";
    }
  }
  const res = await runCheckForRed({
    framework: fw,
    binary: binaryFor(fw, { interp }),
    runArgs: selector,
    cwd: join(p.worktreePath, comp.dir ?? ""),
    timeoutMs: p.timeoutMs,
    run: p.run,
  });
  // selected-none post-implement = the check no longer selects (identity lost) → NOT green.
  return res.coarse === "selected-none" ? "error" : res.coarse;
}

interface RerunParams {
  db: Database;
  ticketId: number;
  components: Component[];
  worktreePath: string;
  headSha: string;
  timeoutMs: number;
  run?: CmdRunner;
}

/** §4: re-run each ACTIVE authored check on the IMPLEMENTED HEAD (not the frozen authoring env;
 *  superseded/re-authored-away checks don't gate — `listAcChecks` = listActiveByTicket). Gate on the
 *  frozen M3 red_class: assertion/absence must be green else gated; environmental → advisory;
 *  dispositions don't gate; NULL red_class AND NULL disposition = loud error. Records a separate
 *  `ac-check-post-implement` signal per check (distinct from red_class; M5 writes its own too). */
export async function rerunAcChecks(p: RerunParams): Promise<RerunResult> {
  const stillRed: number[] = [];
  const advisory: number[] = [];
  const ran: RerunResult["ran"] = [];
  for (const check of listAcChecks(p.db, p.ticketId)) {
    if (check.red_class === null && check.disposition === null) {
      throw new Error(
        `verify gate: ac_check ${check.id} (ac ${check.ac_id}) has neither red_class nor disposition — an unresolved check cannot gate`,
      );
    }
    if (check.disposition !== null) {
      ran.push({ acId: check.ac_id, acCheckId: check.id, coarse: "green", outcome: "disposition" });
      continue; // satisfied / not-expressible → M6 surfaces; does not gate
    }
    const coarse = await rerunOne(p, check.test_path, check.selector);
    let outcome: GateOutcome;
    if (check.red_class === "environmental") {
      outcome = "advisory-red";
      if (coarse !== "green") advisory.push(check.ac_id);
    } else if (coarse === "green") {
      outcome = "green";
    } else {
      outcome = "gated-red";
      stillRed.push(check.ac_id);
    }
    ran.push({ acId: check.ac_id, acCheckId: check.id, coarse, outcome });
    insertSignal(p.db, {
      ticketId: p.ticketId,
      signalType: "ac-check-post-implement",
      result: coarse === "green" ? "pass" : "fail",
      branchHeadSha: p.headSha,
      detail: {
        acCheckId: check.id,
        acId: check.ac_id,
        coarse,
        redClass: check.red_class,
        outcome,
      },
    });
  }
  return { stillRed, advisory, ran };
}
