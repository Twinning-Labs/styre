// test/cli/design-crash-e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentManifest } from "../../src/daemon/design-digests.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listFindings } from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness } from "../helpers/design-harness.ts";
import type { ScriptFinding } from "../helpers/design-script.ts";
import { ownChild } from "../helpers/own-processes.ts";
import { makeTempDir, trackTempEntriesMadeBy } from "../helpers/temp.ts";

const DRIVER = join(import.meta.dir, "../fixtures/design/crash-resume.ts");
/** A fresh run, the child up to its crash point, and the resume after it. */
const CRASH_TEST_TIMEOUT_MS = 120_000;
const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

type Point = "before-commit" | "after-commit" | "after-invalidate";
/** The edit that makes each step rerun on the next resume (in place, so provision reruns only
 *  when its own inputs change). */
const editPromptVars = (h: DesignHarness): void =>
  h.editProfile((p) => {
    p.promptVars = { stack: "ruby", tone: "terse" };
  });
const EDITS: Record<string, (h: DesignHarness) => void> = {
  provision: (h) =>
    h.editProfile((p) => {
      p.components = [
        ...(p.components as unknown[]),
        {
          name: "extra",
          kind: "ruby",
          paths: ["extra/**"],
          commands: { build: "true", test: "true", check: "true" },
        },
      ];
    }),
  "design:dispatch": editPromptVars,
  "design:extract": editPromptVars,
  "design:size": (h) =>
    h.editConfig((c) => {
      c.complexityGrading = true;
    }),
  "design:review": editPromptVars,
};

/** The agent steps each edit makes run again, once (as §8.1 shows for the same edits). The plan
 *  body never changes, so design:review reruns only where it reads the edited input itself. */
const AGENT_STEPS = ["design:dispatch", "design:extract", "design:size", "design:review"] as const;
const RERUNS: Record<string, readonly string[]> = {
  provision: ["design:dispatch", "design:extract"],
  "design:dispatch": ["design:dispatch", "design:extract", "design:review"],
  "design:extract": ["design:dispatch", "design:extract", "design:review"],
  "design:size": ["design:size"],
  "design:review": ["design:dispatch", "design:extract", "design:review"],
};

/** One finding that does not block (minor): every design:review call files it, in the parent's
 *  runs and in the child's, so each committed review round holds exactly one plan finding. */
const PLAN_FINDING: ScriptFinding = {
  severity: "minor",
  category: "clarity",
  location: "plan:intro",
  rationale: "name the module",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: null,
};
const script = { planFindings: () => [PLAN_FINDING] };

/** Dispatch rows written by `step` (agent steps), counted through the dispatch's step id. */
const dispatches = (h: DesignHarness, step: string): number =>
  h.read(
    (db, id) =>
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM dispatch d JOIN workflow_step w ON w.id = d.step_id WHERE d.ticket_id = ? AND w.step_key = ? AND d.outcome = 'clean-success'",
          )
          .get(id, step) as { n: number }
      ).n,
  );
const dispatchCounts = (h: DesignHarness): Record<string, number> =>
  Object.fromEntries(AGENT_STEPS.map((s) => [s, dispatches(h, s)]));

/** Run the crash driver until it reaches `point` of `step`, then SIGKILL it through its own handle.
 *  The child gets a minimal environment: PATH (for git), HOME inside its own temp folder, this
 *  harness's XDG_STATE_HOME and XDG_CONFIG_HOME, this run's TMPDIR, and STYRE_TELEMETRY=0; no
 *  credential of the parent's reaches it. It runs in its temp folder. It is claimed with ownChild at
 *  once (the preload's end of run check sees it), bounds itself (crash-resume.ts), and has a 60 s
 *  deadline here. A project command it ran may leave its styre-cmd-* folder in the shared temp root
 *  (PR #156), and a worktree run its styre-wt-* root: SIGKILL lets no exit check remove them, and
 *  only a later sweep would. Both are tracked for removal, so the preload's temp guard sees nothing
 *  left. */
async function crashChild(h: DesignHarness, step: string, point: Point): Promise<void> {
  const dir = makeTempDir("styre-crash-");
  const home = join(dir, "home");
  mkdirSync(home);
  const readyFile = join(dir, "ready");
  const specPath = join(dir, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      profilePath: h.profilePath,
      configPath: h.configPath,
      ident: h.ident,
      step,
      point,
      readyFile,
      planFindings: [PLAN_FINDING],
    }),
  );
  const log = join(dir, "stderr.log");
  const why = (): string => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const drive = async () => {
    const child = Bun.spawn([process.execPath, DRIVER, specPath], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: tmpdir(),
        XDG_STATE_HOME: h.stateRoot,
        XDG_CONFIG_HOME: h.configRoot,
        STYRE_TELEMETRY: "0",
      },
      stdout: "ignore",
      stderr: Bun.file(log), // a file, so a full pipe can never stall the child before its crash point
    });
    const deadline = Date.now() + 60_000;
    try {
      if (ownChild(child) === null) {
        throw new Error(`crash driver could not be claimed (pid ${child.pid}): ${why()}`);
      }
      while (!existsSync(readyFile)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`crash driver did not reach ${point} of ${step}: ${why()}`);
        }
        await Bun.sleep(50);
      }
    } finally {
      child.kill("SIGKILL"); // this child only, by its own handle
      await child.exited;
    }
  };
  await trackTempEntriesMadeBy("styre-cmd-", () => trackTempEntriesMadeBy("styre-wt-", drive));
}

const rows = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");

describe("§8.8: a child process SIGKILLed at each design step leaves nothing duplicated or stale", () => {
  for (const row of rows) {
    for (const point of ["before-commit", "after-commit", "after-invalidate"] as const) {
      test(
        `${row.stepKey}, ${point}`,
        async () => {
          const h = new DesignHarness("in-place");
          harnesses.push(h);
          expect(await h.fresh({ script })).toBe(75); // design done; paused at checks:dispatch
          const before = dispatchCounts(h);
          const generation = h.read((db, id) => getByKey(db, id, row.stepKey)?.generation ?? -1);
          expect(generation).toBe(0);
          EDITS[row.stepKey](h);
          await crashChild(h, row.stepKey, point);
          // the child stopped where it said: the step invalidated once, then mid run, committed, or
          // not yet started
          const atCrash = h.read((db, id) => ({
            step: getByKey(db, id, row.stepKey),
            units: listUnits(db, id).length,
            track: getTicket(db, id)?.track ?? null,
          }));
          expect(atCrash.step?.generation).toBe(generation + 1);
          expect(atCrash.step?.status).toBe(
            point === "before-commit"
              ? "running"
              : point === "after-commit"
                ? "succeeded"
                : "pending",
          );
          // the step's outputs are cleared by the invalidate transaction itself, and written only by
          // its success transaction: before either rerun commits, nothing of the old round is left
          if (row.stepKey === "design:extract" && point !== "after-commit")
            expect(atCrash.units).toBe(0);
          if (row.stepKey === "design:size" && point !== "after-commit")
            expect(atCrash.track).toBeNull();
          const endedAtCrash = atCrash.step?.ended_at;
          expect(await h.resume({ script })).toBe(75); // the next resume finishes design again
          h.read((db, id) => {
            // no duplicate or partial outputs
            expect(listUnits(db, id).map((u) => u.seq)).toEqual([1, 2]);
            // design finished again (the track stays full): every design step succeeded, and its
            // recorded manifest matches its inputs now
            expect(getTicket(db, id)?.track).toBe("full");
            for (const r of rows) {
              const s = getByKey(db, id, r.stepKey);
              expect(s?.status).toBe("succeeded");
              expect(JSON.parse(s?.input_manifest ?? "null")).toEqual(currentManifest(db, id, r));
            }
            // one invalidation of the crashed step, whatever the crash point: one event, one history
            // row, one generation more than before
            const invalidations = listEvents(db, id).filter(
              (e) =>
                e.reason === "invalidated" &&
                (JSON.parse(e.payload_json ?? "{}").stepKeys as string[]).includes(row.stepKey),
            );
            expect(invalidations.length).toBe(1);
            expect(listStepHistory(db, id, row.stepKey).length).toBe(1);
            expect(getByKey(db, id, row.stepKey)?.generation).toBe(generation + 1);
          });
          if (point === "after-commit") {
            // committed before the crash: never run again for the same inputs
            expect(endedAtCrash).toBeTruthy();
            expect(h.read((db, id) => getByKey(db, id, row.stepKey)?.ended_at)).toBe(endedAtCrash);
          }
          // every agent step ran once more for the edit where it reads the edited input, and never
          // otherwise; the crashed step's uncommitted success (before-commit) is redone once more
          const after = dispatchCounts(h);
          for (const s of AGENT_STEPS) {
            const expected =
              (RERUNS[row.stepKey].includes(s) ? 1 : 0) +
              (s === row.stepKey && point === "before-commit" ? 1 : 0);
            expect({ step: s, ran: after[s] - before[s] }).toEqual({ step: s, ran: expected });
          }
          // plan findings: each committed review round wrote its one finding exactly once; a round
          // the crash cut before its commit wrote none
          const reviewCommits =
            after["design:review"] -
            (row.stepKey === "design:review" && point === "before-commit" ? 1 : 0);
          h.read((db, id) => {
            const plan = listFindings(db, id).filter((f) => f.review_kind === "plan");
            const perDispatch = new Map<string | null, number>();
            for (const f of plan)
              perDispatch.set(f.dispatch_id, (perDispatch.get(f.dispatch_id) ?? 0) + 1);
            expect(plan.length).toBeGreaterThan(0);
            expect([...perDispatch.values()].every((n) => n === 1)).toBe(true);
            expect(plan.length).toBe(reviewCommits);
          });
        },
        CRASH_TEST_TIMEOUT_MS,
      );
    }
  }
});
