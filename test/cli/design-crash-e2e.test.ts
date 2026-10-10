// test/cli/design-crash-e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentManifest } from "../../src/daemon/design-digests.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness } from "../helpers/design-harness.ts";
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

/** Run the crash driver until it reaches `point` of `step`, then SIGKILL it through its own handle.
 *  The child is claimed with ownChild at once (the preload's end of run check sees it), bounds
 *  itself (crash-resume.ts), and has a 60 s deadline here. Its run keeps a styre-wt-* root in the
 *  shared temp root (TMPDIR is passed on), and a project command it ran may leave its styre-cmd-*
 *  folder there (PR #156): SIGKILL lets no exit check remove it, and only a later sweep would.
 *  Both are tracked for removal, so the preload's temp guard sees nothing left. */
async function crashChild(h: DesignHarness, step: string, point: Point): Promise<void> {
  const dir = makeTempDir("styre-crash-");
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
    }),
  );
  const log = join(dir, "stderr.log");
  const drive = async () => {
    const child = Bun.spawn([process.execPath, DRIVER, specPath], {
      env: {
        ...process.env,
        XDG_STATE_HOME: h.stateRoot,
        XDG_CONFIG_HOME: h.configRoot,
        STYRE_TELEMETRY: "0",
      },
      stdout: "ignore",
      stderr: Bun.file(log), // a file, so a full pipe can never stall the child before its crash point
    });
    ownChild(child);
    const deadline = Date.now() + 60_000;
    try {
      while (!existsSync(readyFile)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          const why = existsSync(log) ? readFileSync(log, "utf8") : "";
          throw new Error(`crash driver did not reach ${point} of ${step}: ${why}`);
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
          expect(await h.fresh()).toBe(75); // design done; paused at checks:dispatch
          // provision runs no agent; design:size runs one only once its edit turns grading on, so its
          // fresh run wrote no dispatch row to compare against
          const agent = row.stepKey !== "provision" && row.stepKey !== "design:size";
          const before = agent ? dispatches(h, row.stepKey) : 0;
          const generation = h.read((db, id) => getByKey(db, id, row.stepKey)?.generation ?? -1);
          EDITS[row.stepKey](h);
          await crashChild(h, row.stepKey, point);
          // the child stopped where it said: the step invalidated once, then mid run, committed, or
          // not yet started
          const atCrash = h.read((db, id) => getByKey(db, id, row.stepKey));
          expect(atCrash?.generation).toBe(generation + 1);
          expect(atCrash?.status).toBe(
            point === "before-commit"
              ? "running"
              : point === "after-commit"
                ? "succeeded"
                : "pending",
          );
          const endedAtCrash = atCrash?.ended_at;
          expect(await h.resume()).toBe(75); // the next resume finishes design again
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
            // one invalidation of the crashed step, whatever the crash point
            const invalidations = listEvents(db, id).filter(
              (e) =>
                e.reason === "invalidated" &&
                (JSON.parse(e.payload_json ?? "{}").stepKeys as string[]).includes(row.stepKey),
            );
            expect(invalidations.length).toBe(1);
          });
          if (point === "after-commit") {
            // committed before the crash: never run again for the same inputs
            expect(endedAtCrash).toBeTruthy();
            expect(h.read((db, id) => getByKey(db, id, row.stepKey)?.ended_at)).toBe(endedAtCrash);
          }
          if (agent) {
            const ran = dispatches(h, row.stepKey) - before;
            // before-commit: the uncommitted success is redone once; otherwise exactly one run
            expect(ran).toBe(point === "before-commit" ? 2 : 1);
          }
        },
        CRASH_TEST_TIMEOUT_MS,
      );
    }
  }
});
