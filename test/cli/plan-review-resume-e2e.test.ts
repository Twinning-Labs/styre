import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stepRow } from "../../src/daemon/design-graph.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getInput } from "../../src/db/repos/ticket-input.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import type { ScriptFinding } from "../helpers/design-script.ts";
import { git } from "../helpers/design-steps.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** What `dumpPark` wrote beside the paused run. */
const transcriptOf = (h: DesignHarness) =>
  JSON.parse(readFileSync(join(h.checkpointDir(), "transcript.json"), "utf8")) as {
    transcript: string;
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
