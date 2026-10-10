import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stepRow } from "../../src/daemon/design-graph.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getInput } from "../../src/db/repos/ticket-input.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import * as door from "../../src/util/process/door.ts";
import { __resetSignalsForTests } from "../../src/util/process/signals.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import type { ScriptFinding } from "../helpers/design-script.ts";
import { git } from "../helpers/design-steps.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  if (door.isStopping()) {
    // never leave a stop flag or the run's stop listeners to the next test
    door.__resetForTests();
    __resetSignalsForTests();
  }
});

/** After a run unwound from an in process stop (the script's `interruptAt`): what the stop handler
 *  would have done (release the run lock, R7; during a stop the run code leaves the lock and its
 *  stop listeners in place), and a fresh door and fresh listeners, since the next resume is a new
 *  process. Nothing is signalled: the listeners this process installed are only removed. */
function afterStop(h: DesignHarness): void {
  rmSync(join(h.checkpointDir(), "run.lock"), { force: true });
  door.__resetForTests();
  __resetSignalsForTests();
}

/** What `dumpPark` wrote beside the paused run. */
const transcriptOf = (h: DesignHarness) =>
  JSON.parse(readFileSync(join(h.checkpointDir(), "transcript.json"), "utf8")) as {
    transcript: string;
    stepKey: string | null;
    generation: number | null;
    manifest: Record<string, string> | null;
  };
const PARTIAL = "partial output written before the session limit";

/** The parked design:dispatch's manifest holds its declared inputs, each the snapshot row's own
 *  digest (checked against the rows, never against currentManifest itself). */
function expectDispatchManifest(h: DesignHarness, manifest: Record<string, string> | null): void {
  const row = stepRow("design:dispatch");
  if (!row) throw new Error("design:dispatch is not a table step");
  const names = [...row.inputs({ complexityGrading: false })].sort();
  expect(names.length).toBeGreaterThan(0);
  expect(Object.keys(manifest ?? {}).sort()).toEqual(names);
  h.read((db, id) => {
    for (const n of names)
      expect(`${n} ${manifest?.[n]}`).toBe(`${n} ${getInput(db, id, n)?.digest}`);
  });
}

const blocking: ScriptFinding = {
  severity: "critical",
  category: "feasibility",
  location: "plan:Unit 1",
  rationale: "FIX-THE-PLAN",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: null,
};

test(
  "a budget pause in the regenerated design:dispatch after a plan review redesign resumes and dispatches it (C2)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      planFindings: (n: number) => (n === 1 ? [blocking] : []),
    };
    // review 1 blocks, the redesign regenerates design:dispatch, and that dispatch pauses
    const paused = { ...script, parkAt: "design:dispatch" as const, parkOnCall: 2 };
    expect(await h.fresh({ script: paused })).toBe(75);
    expect(h.calls.counts["design:dispatch"]).toBe(2);
    // dumpPark recorded the parked step's generation (1: the redesign's) and its inputs
    const tj = transcriptOf(h);
    expect(tj.transcript).toContain(PARTIAL);
    expect(tj.stepKey).toBe("design:dispatch");
    expect(tj.generation).toBe(1);
    expectDispatchManifest(h, tj.manifest);
    expect(await h.resume({ script })).toBe(75); // design finishes; the checks pause follows
    expect(h.calls.counts["design:dispatch"]).toBe(3); // the paused dispatch ran again
    const dispatchPrompts = h.calls.prompts.filter((p) => p.step === "design:dispatch");
    expect(dispatchPrompts[2]?.prompt).toContain(PARTIAL); // same step, generation and inputs
    expect(dispatchPrompts[2]?.prompt).toContain("FIX-THE-PLAN"); // generation 1's feedback
    expect(h.calls.counts["design:review"]).toBe(2); // the new plan was reviewed
    h.read((db, id) => {
      expect(getByKey(db, id, "design:dispatch")?.status).toBe("succeeded");
      const escalations = listEvents(db, id).filter((e) => e.kind === "escalated");
      expect(escalations.some((e) => (e.reason ?? "").includes("plan-review"))).toBe(false);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a gate stop resumed on a host missing a required suite's tools pauses once, and the edited plan is redesigned next (ruling 2026-10-09)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    h.editProfile((p) => {
      (p.components as unknown[]).push({
        name: "lib",
        kind: "ruby",
        paths: ["vendor-lib/**"],
        commands: { build: "lib-build", test: "lib-test", check: "lib-check" },
        testPolicy: { suite: "required" },
      });
    });
    const plan = (n: number) => `Plan body, version ${n}`;
    // every review returns the same blocking finding: one redesign, then the stop at the gate
    const stuck = { plan, planFindings: () => [blocking] };
    expect(await h.fresh({ script: stuck })).toBe(75);
    expect(h.calls.counts["design:dispatch"]).toBe(2);

    // resume 1, HEAD unchanged, on a host without lib's tools: the verdict stops the run at the
    // gate again inside the resume transaction, and the toolchain pause adds nothing to it
    h.probe = (_dir, cmd) => !cmd.startsWith("lib-");
    expect(await h.resume({ script: stuck })).toBe(75);
    h.read((db, id) => {
      expect(listPending(db, id).filter((x) => x.signal_type === "human_resume")).toHaveLength(1);
      const events = listEvents(db, id);
      const since = events.slice(events.findLastIndex((e) => e.kind === "resumed") + 1);
      expect(since.filter((e) => e.kind === "escalated")).toHaveLength(1);
      expect(since.some((e) => e.reason === "toolchain-missing")).toBe(true); // the gap is on record
    });

    // the operator installs the tools and edits the plan, then resumes with --accept-head
    h.probe = () => true;
    writeFileSync(
      join(h.repoDir, "docs", "plans", "eng-1-plan.md"),
      "---\nlinear: ENG-1\n---\n\nEdited by the operator\n",
    );
    git(h.repoDir, ["commit", "-q", "-am", "operator edits the plan"]);
    const clean = { plan, planFindings: () => [] };
    expect(await h.resume({ acceptHead: true, script: clean })).toBe(75); // the checks pause
    expect(h.calls.counts["design:dispatch"]).toBe(3); // redesigned from the gate
    h.read((db, id) => {
      const loopbacks = listEvents(db, id).filter((e) => e.kind === "loopback");
      expect(loopbacks.at(-1)?.signature).toBe("review:operator-plan-head-changed");
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a carryover whose step's inputs changed while the run was paused is dropped, with a note naming them (spec §6.5)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    expect(await h.fresh({ script: { parkAt: "design:dispatch" } })).toBe(75);
    expect(h.calls.counts["design:dispatch"]).toBe(1);
    const tj = transcriptOf(h);
    expect(tj.generation).toBe(0);
    expectDispatchManifest(h, tj.manifest);

    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.resume({ script: {} })).toBe(75); // design finishes; the checks pause follows
    expect(h.calls.counts["design:dispatch"]).toBe(2);
    const resumed = h.calls.prompts.filter((p) => p.step === "design:dispatch")[1]?.prompt ?? "";
    expect(resumed).toContain("You are designing ticket"); // the paused dispatch's own prompt
    expect(resumed).not.toContain(PARTIAL);
    h.read((db, id) => {
      const notes = listEvents(db, id)
        .filter((e) => e.reason === "carryover-dropped")
        .map((e) => JSON.parse(e.payload_json ?? "{}") as Record<string, unknown>);
      expect(notes).toEqual([
        { event: "carryover-dropped", stepKey: "design:dispatch", changed: ["profile.promptVars"] },
      ]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a transcript from an earlier generation is never carried over, even with the same step and unchanged inputs (spec §6.5)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      planFindings: (n: number) => (n === 1 ? [blocking] : []),
    };
    // design:dispatch call 1 (generation 0) pauses: transcript.json is written for generation 0
    expect(await h.fresh({ script: { ...script, parkAt: "design:dispatch" } })).toBe(75);
    expect(transcriptOf(h).generation).toBe(0);
    // the resume reruns it with the carryover (call 2), review 1 blocks, the redesign regenerates
    // design:dispatch (generation 1), and a stop lands while that dispatch (call 3) runs
    await expect(
      h.resume({ script: { ...script, interruptAt: "design:dispatch", interruptOnCall: 3 } }),
    ).rejects.toBeInstanceOf(door.RunInterrupted);
    afterStop(h);
    expect(h.calls.counts["design:dispatch"]).toBe(3);
    h.read((db, id) => {
      const step = getByKey(db, id, "design:dispatch");
      expect(step?.status).toBe("running");
      expect(step?.generation).toBe(1);
    });
    // a stop writes no transcript: the generation 0 file is still there, its inputs unchanged
    const stale = transcriptOf(h);
    expect(stale.generation).toBe(0);
    expect(stale.transcript).toContain(PARTIAL);
    expectDispatchManifest(h, stale.manifest);

    expect(await h.resume({ script })).toBe(75); // design finishes; the checks pause follows
    const prompts = h.calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain(PARTIAL); // generation 0's own rerun got it
    expect(prompts[3]).toContain("FIX-THE-PLAN"); // generation 1, run again after the stop
    expect(prompts[3]).not.toContain(PARTIAL); // but never generation 0's partial output
    h.read((db, id) => {
      // not this dispatch's carryover at all (another generation): withheld without a note
      expect(listEvents(db, id).filter((e) => e.reason === "carryover-dropped")).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a transcript is never given to another step parked later: a stop during design:review after a design:dispatch pause (spec §6.5)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    expect(await h.fresh({ script: { parkAt: "design:dispatch" } })).toBe(75);
    expect(transcriptOf(h).stepKey).toBe("design:dispatch");
    // the resume finishes design:dispatch, extract and size, and a stop lands during design:review
    await expect(
      h.resume({ script: { interruptAt: "design:review", interruptOnCall: 1 } }),
    ).rejects.toBeInstanceOf(door.RunInterrupted);
    afterStop(h);
    h.read((db, id) => {
      const step = getByKey(db, id, "design:review");
      expect(step?.status).toBe("running");
      expect(step?.generation).toBe(0); // the transcript's generation too: only its step tells
    });
    expect(transcriptOf(h).stepKey).toBe("design:dispatch"); // a stop writes no transcript

    expect(await h.resume({ script: {} })).toBe(75); // design finishes; the checks pause follows
    expect(h.calls.counts["design:review"]).toBe(2);
    const review = h.calls.prompts.filter((p) => p.step === "design:review")[1]?.prompt ?? "";
    expect(review).toContain("You are the independent plan reviewer");
    expect(review).not.toContain(PARTIAL);
    h.read((db, id) => {
      // withheld as not this step's at all: no note that would name design:review's inputs as changed
      expect(listEvents(db, id).filter((e) => e.reason === "carryover-dropped")).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
