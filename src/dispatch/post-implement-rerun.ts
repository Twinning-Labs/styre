import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { listActiveByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { insertSignal, signalForAcCheck } from "../db/repos/ground-truth-signal.ts";
import type { CmdRunner } from "../util/run-command.ts";
import { CheckExecutionPlanSchema } from "./check-execution.ts";
import { type CoarseResult, frameworkFor, launcherFor } from "./check-selector.ts";
import { runCheckExecution, runCheckForRed } from "./checks-run.ts";
import { impactedComponents } from "./components.ts";
import { blockerPersists } from "./env-blocker.ts";
import type { Component } from "./profile.ts";
import { resolvePythonInterpreter } from "./provision.ts";

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
  executionPlan: unknown,
): Promise<{
  coarse: CoarseResult;
  rawOutput: string;
  command?: string;
  exitCode?: number | null;
  executionPlan?: unknown;
  environment?: import("../testing/environment-schema.ts").EnvironmentObservation;
}> {
  if (executionPlan !== undefined) {
    const parsed = CheckExecutionPlanSchema.safeParse(executionPlan);
    if (!parsed.success || parsed.data.testFile !== testPath || parsed.data.runArgs !== selector)
      return {
        coarse: "error",
        rawOutput: "invalid or inconsistent persisted test execution plan; re-author the check",
      };
    const res = await runCheckExecution({
      plan: parsed.data,
      components: p.components,
      worktreePath: p.worktreePath,
      timeoutMs: p.timeoutMs,
      run: p.run,
    });
    return {
      environment: res.environment,
      command: res.command,
      exitCode: res.exitCode,
      executionPlan: parsed.data,
      coarse: res.coarse === "selected-none" ? "error" : res.coarse,
      rawOutput: [res.reason, res.rawOutput].filter(Boolean).join("\n"),
    };
  }
  if (testPath === null) return { coarse: "error", rawOutput: "" };
  const comp = impactedComponents(p.components, [testPath])[0];
  const fw = comp ? frameworkFor(comp) : null;
  if (!comp || !fw) return { coarse: "error", rawOutput: "" };
  // Legacy root checks retain their historical invocation. Nested paths and module-only
  // Django checks cannot be safely reinterpreted; require re-authoring rather than guessing.
  if (comp.testEnvironment || comp.dir || fw === "django-runtests" || fw === "mocha")
    return {
      coarse: "error",
      rawOutput: "legacy check lacks an exact execution plan; re-author the check",
    };
  let interp: string | undefined;
  if (fw === "pytest") {
    // PATH-dependent (FIX 5c): resolves python3/python from $PATH, same as checks:dispatch. The
    // re-provisioned interpreter (any venv/conda activation the implement/provision step performed)
    // must be on PATH here, or this throws and the check fails closed (counted as still-red, never
    // a false-pass).
    try {
      interp = resolvePythonInterpreter();
    } catch {
      return { coarse: "error", rawOutput: "" };
    }
  }
  const res = await runCheckForRed({
    framework: fw,
    // MUST match the red-first executor in checks:dispatch. Using the bare binary here made
    // the post-implement re-run fail with `sh: 1: jest: not found` on
    // darkreader__darkreader-7241 while the SAME check passed through `npm test --`: jest lives
    // in node_modules/.bin, reachable only via the package manager's script environment. The
    // check was recorded still-red at HEAD and the run escalated, though the fix was correct.
    binary: launcherFor(comp, fw, { interp }),
    runArgs: selector,
    cwd: join(p.worktreePath, comp.dir ?? ""),
    timeoutMs: p.timeoutMs,
    run: p.run,
  });
  // selected-none post-implement = the check no longer selects (identity lost) → NOT green.
  const coarse = res.coarse === "selected-none" ? "error" : res.coarse;
  return { coarse, rawOutput: res.rawOutput };
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
    const execution = await rerunOne(
      p,
      check.test_path,
      check.selector,
      signalForAcCheck(p.db, check.id)?.detail.executionPlan,
    );
    const { coarse, rawOutput } = execution;
    let outcome: GateOutcome;
    if (check.red_class === "environmental" && coarse === "green") {
      // The environment recovered and the check passes — nothing to caveat, nothing to gate.
      outcome = "advisory-red";
    } else if (check.red_class === "environmental") {
      // ENG-424 hole 2. `red_class` is frozen at RED-first time, so a check adjudicated
      // `environmental` used to stay advisory no matter WHAT it failed with later — including a
      // genuine assertion failure once the environment recovered. A stale label was silently
      // shielding a real red.
      //
      // Re-deriving the class here is not an option: `coarse` cannot tell "ran and failed" from
      // "could not start" (django's `No module named pytest` exits 1, bucketed `red`, exactly
      // like a failed assertion), and re-running `classifyPrior` would overrule the adjudicator
      // on the very output it already judged. So ask the answerable question instead — is the
      // blocker that WAS adjudicated still there? If yes the class still fits; if it is gone
      // while the check is still red, this is a different failure and must gate.
      const redFirstOutput = signalForAcCheck(p.db, check.id)?.detail.rawOutput ?? "";
      if (blockerPersists(redFirstOutput, rawOutput)) {
        outcome = "advisory-red";
        advisory.push(check.ac_id);
      } else {
        outcome = "gated-red";
        stillRed.push(check.ac_id);
      }
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
        ...execution,
        acCheckId: check.id,
        acId: check.ac_id,
        coarse,
        redClass: check.red_class,
        outcome,
        rawOutput, // FIX I2: the arbiter's evidence — the actual failure trace, not just the coarse bucket.
      },
    });
  }
  return { stillRed, advisory, ran };
}
