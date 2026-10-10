// test/cli/design-inputs-e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { redesignLoopback } from "../../src/daemon/review-verdict.ts";
import { openDb } from "../../src/db/client.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listFindings } from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { type ScriptFinding, type ScriptStep, unitsOf } from "../helpers/design-script.ts";
import { atStep, driveUntil, makeDesignTicket } from "../helpers/design-steps.ts";

const harnesses: DesignHarness[] = [];
const make = (): DesignHarness => {
  const h = new DesignHarness("in-place");
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const inputInvalidations = (h: DesignHarness): string[] =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "invalidated")
      .map(
        (e) =>
          JSON.parse(e.payload_json ?? "{}") as {
            event: string;
            stepKeys: string[];
            cause: string;
            changed: string[];
          },
      )
      .filter((p) => p.cause === "inputs")
      .flatMap((p) => p.stepKeys),
  );
const AGENT_STEPS: Record<string, ScriptStep | null> = {
  provision: null,
  "design:dispatch": "design:dispatch",
  "design:extract": "design:extract",
  "design:size": "design:size",
  "design:review": "design:review",
};

interface InputCase {
  input: string;
  edit: (h: DesignHarness) => void;
  reruns: string[];
}

const CASES: InputCase[] = [
  {
    input: "profile.components",
    edit: (h) =>
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
    reruns: ["provision", "design:dispatch", "design:extract"],
  },
  {
    input: "profile.promptVars",
    edit: (h) =>
      h.editProfile((p) => {
        p.promptVars = { stack: "ruby", tone: "terse" };
      }),
    reruns: ["design:dispatch", "design:extract", "design:review"],
  },
  {
    input: "profile.runtimeContext",
    edit: (h) =>
      h.editProfile((p) => {
        p.runtimeContext = { ...(p.runtimeContext as object), topology: { type: "web-service" } };
      }),
    reruns: ["design:dispatch", "design:extract"],
  },
  {
    input: "run.nonPrimaryComponents",
    edit: (h) =>
      h.editProfile((p) => {
        p.components = [
          ...(p.components as unknown[]),
          {
            name: "fixture-app",
            kind: "ruby",
            role: "fixture",
            paths: ["fixtures/**"],
            commands: { build: "true", test: "true", check: "true" },
          },
        ];
      }),
    reruns: ["provision"], // the narrowed profile is unchanged; only provision reads the list
  },
  {
    input: "config.complexityGrading",
    edit: (h) =>
      h.editConfig((c) => {
        c.complexityGrading = true;
      }),
    reruns: ["design:size"], // grade 6 keeps the track full, so design:review stays done
  },
];

describe("§8.1: each input reruns exactly its dependants", () => {
  for (const c of CASES) {
    test(
      `${c.input}`,
      async () => {
        const h = make();
        expect(await h.fresh()).toBe(75); // design done; paused at checks:dispatch
        const before = { ...h.calls.counts };
        c.edit(h);
        expect(await h.resume()).toBe(75);
        expect(inputInvalidations(h).sort()).toEqual([...c.reruns].sort());
        for (const [key, agent] of Object.entries(AGENT_STEPS)) {
          if (agent === null) continue;
          // design:size calls an agent only with grading on, which is the one case that reruns it
          expect(h.calls.counts[agent]).toBe(
            c.reruns.includes(key) ? before[agent] + 1 : before[agent],
          );
        }
        // the checks steps are outside the table: never invalidated, no history (E9)
        h.read((db, id) => {
          expect(listStepHistory(db, id).some((r) => r.step_key.startsWith("checks:"))).toBe(false);
        });
      },
      HARNESS_TEST_TIMEOUT_MS,
    );
  }

  test(
    "profile.slug (not editable across a resume: the checkpoint folder is keyed by it)",
    async () => {
      const t = makeDesignTicket();
      await driveUntil(t, atStep("checks:dispatch"));
      captureSnapshot(t.db, t.ticketId, {
        profile: { ...t.profile, slug: "renamed" },
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: t.config,
      });
      await driveUntil(t, atStep("checks:dispatch"));
      const invalidated = listEvents(t.db, t.ticketId)
        .filter((e) => e.reason === "invalidated")
        .map((e) => JSON.parse(e.payload_json ?? "{}").stepKeys[0]);
      expect(invalidated).toEqual(["design:dispatch", "design:extract", "design:review"]);
    },
    HARNESS_TEST_TIMEOUT_MS,
  );
});

test(
  "§8.2 (E6): an edit while paused in implement reruns nothing now, says so, and a later redesign picks it up",
  async () => {
    const h = make();
    const script = { units: () => unitsOf(2, { behavioral: false }), parkAt: "implement" as const };
    expect(await h.fresh({ script })).toBe(75); // parked at implement:wu1:dispatch
    const designCalls = () => [
      h.calls.counts["design:dispatch"],
      h.calls.counts["design:extract"],
      h.calls.counts["design:review"],
    ];
    const before = designCalls();
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.resume({ script })).toBe(75); // parks at implement again
    expect(designCalls()).toEqual(before);
    expect(inputInvalidations(h)).toEqual([]);
    const note = h.read((db, id) => listEvents(db, id).find((e) => e.reason === "inputs-changed"));
    expect(JSON.parse(note?.payload_json ?? "{}")).toMatchObject({
      pastDesign: true,
      names: ["profile.promptVars"],
    });
    // a redesign (as code review's plan-defect route would make) returns the run to design
    const db = openDb(h.dbPath()); // foreign keys on, so deleting the units cascades as in a run
    const id = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
    redesignLoopback(db, id, "review:plan-defect", [], null, ["design:dispatch", "design:extract"]);
    db.close();
    expect(await h.resume({ script })).toBe(75);
    expect(inputInvalidations(h)).toContain("design:review"); // the edit took effect in design
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.7: after a redesign, a profile edit and a resume, the next generation gets no stale findings and no carryover",
  async () => {
    const finding = (rationale: string, location: string): ScriptFinding => ({
      severity: "critical",
      category: "feasibility",
      location,
      rationale,
      factors: null,
      deferral_candidate: false,
      work_unit_seq: null,
    });
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      planFindings: (n: number) =>
        n === 1
          ? [finding("ROUND-ONE", "plan:a")]
          : n === 2
            ? [finding("ROUND-TWO", "plan:b")]
            : [],
      parkAt: "design:dispatch" as const,
      parkOnCall: 2, // the generation 1 dispatch, right after the first redesign
    };
    const h = make();
    expect(await h.fresh({ script })).toBe(75); // budget pause, transcript for design:dispatch gen 1
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.resume({ script: { ...script, parkAt: null, parkOnCall: null } })).toBe(75);
    const prompts = h.calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    // call 3: generation 1 resumed. The parked step was never finished, so the edit did not
    // invalidate it: it keeps its generation's findings. But the edit changed one of its inputs, so its
    // partial output from before the pause is withheld, with one note naming the input (spec §6.5).
    expect(prompts[2]).toContain("ROUND-ONE");
    expect(prompts[2]).not.toContain("partial output written before the session limit");
    const dropped = h.read((db, id) =>
      listEvents(db, id)
        .filter((e) => e.reason === "carryover-dropped")
        .map((e) => JSON.parse(e.payload_json ?? "{}") as { stepKey: string; changed: string[] }),
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.stepKey).toBe("design:dispatch");
    expect(dropped[0]?.changed).toContain("profile.promptVars");
    // call 4: generation 2, after the second redesign: only round two, no carryover
    expect(prompts[3]).toContain("ROUND-TWO");
    expect(prompts[3]).not.toContain("ROUND-ONE");
    expect(prompts[3]).not.toContain("partial output written before the session limit");
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.7: a run paused in design:review keeps its carryover when nothing changed",
  async () => {
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      parkAt: "design:review" as const,
      parkOnCall: 1,
    };
    const h = make();
    expect(await h.fresh({ script })).toBe(75); // budget pause in design:review, before it finished
    expect(await h.resume({ script: { ...script, parkAt: null, parkOnCall: null } })).toBe(75);
    const prompts = h.calls.prompts.filter((p) => p.step === "design:review").map((p) => p.prompt);
    expect(prompts[1]).toContain("partial output written before the session limit");
    expect(
      h.read((db, id) => listEvents(db, id).some((e) => e.reason === "carryover-dropped")),
    ).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.7: a run paused in design:review drops its carryover when an edit changes the plan",
  async () => {
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      parkAt: "design:review" as const,
      parkOnCall: 1,
    };
    const h = make();
    expect(await h.fresh({ script })).toBe(75);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" }; // read by design:review, and by design:dispatch, which writes plan version 2
    });
    expect(await h.resume({ script: { ...script, parkAt: null, parkOnCall: null } })).toBe(75);
    const prompts = h.calls.prompts.filter((p) => p.step === "design:review").map((p) => p.prompt);
    expect(prompts[1]).not.toContain("partial output written before the session limit");
    const dropped = h.read((db, id) =>
      listEvents(db, id)
        .filter((e) => e.reason === "carryover-dropped")
        .map((e) => JSON.parse(e.payload_json ?? "{}") as { stepKey: string; changed: string[] }),
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.stepKey).toBe("design:review");
    expect(dropped[0]?.changed).toEqual(expect.arrayContaining(["plan", "profile.promptVars"]));
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.9: an extract invalidated by an edit clears every unit and needs_docs, keeps the plan finding detached, and leaves history",
  async () => {
    const h = make();
    const script = {
      planFindings: () => [
        {
          severity: "minor" as const,
          category: "clarity",
          location: "plan:Unit 1",
          rationale: "name it",
          factors: null,
          deferral_candidate: false,
          work_unit_seq: 1,
        },
      ],
    };
    expect(await h.fresh({ script })).toBe(75);
    h.editProfile((p) => {
      p.runtimeContext = { ...(p.runtimeContext as object), topology: { type: "web-service" } };
    });
    expect(await h.resume({ script })).toBe(75);
    h.read((db, id) => {
      const units = listUnits(db, id);
      expect(units.map((u) => u.seq)).toEqual([1, 2]);
      // made again (work_unit.id is not AUTOINCREMENT, so ids may repeat): the history row below
      // and the detached finding show it
      const planFindings = listFindings(db, id).filter((f) => f.review_kind === "plan");
      expect(planFindings.length).toBe(1); // design:review did not rerun: same plan, same units
      expect(planFindings[0].work_unit_id).toBeNull(); // detached when the units were deleted
      expect(listStepHistory(db, id, "design:extract").length).toBe(1);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
