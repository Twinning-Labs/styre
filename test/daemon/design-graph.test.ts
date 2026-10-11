import { expect, test } from "bun:test";
import { EXIT } from "../../src/cli/errors.ts";
import {
  DESIGN_TABLE,
  type DesignRow,
  DesignTableError,
  type GateRow,
  type InputName,
  SNAPSHOT_INPUT_NAMES,
  type StepRow,
  TICKET_TEXT_INPUTS,
  assertDesignTable,
  checkDesignTable,
  declaresInput,
  designRouting,
  ensureDesignTableChecked,
  isSnapshotInput,
  isTableStep,
  stepRow,
} from "../../src/daemon/design-graph.ts";

const steps = (t: readonly DesignRow[]) => t.filter((r): r is StepRow => r.kind === "step");
const replace = (key: string, patch: Partial<StepRow>): DesignRow[] =>
  DESIGN_TABLE.map((r) => (r.kind === "step" && r.stepKey === key ? { ...r, ...patch } : r));

test("the shipped table satisfies every rule", () => {
  expect(checkDesignTable(DESIGN_TABLE)).toEqual([]);
});

test("rule 1 refuses an input that is neither a snapshot input nor an earlier output", () => {
  const bad = replace("design:extract", { inputs: () => ["ghost" as InputName] });
  expect(checkDesignTable(bad).join("\n")).toMatch(/rule 1: design:extract reads ghost/);
});

test("rule 2 refuses an output with two producers", () => {
  const bad = replace("design:extract", { produces: ["workUnits", "plan"] });
  expect(checkDesignTable(bad).join("\n")).toMatch(
    /rule 2: plan is produced by design:dispatch and design:extract/,
  );
});

test("rule 3 refuses a step that reads what a later step produces", () => {
  const bad = replace("design:extract", { inputs: () => ["plan", "track"] });
  expect(checkDesignTable(bad).join("\n")).toMatch(
    /rule 3: design:extract reads track, produced later by design:size/,
  );
});

test("rule 4 refuses a step listed twice; the routing is the step rows in table order", () => {
  const dup = [...DESIGN_TABLE, steps(DESIGN_TABLE)[1]];
  expect(checkDesignTable(dup).join("\n")).toMatch(/rule 4: design:dispatch appears twice/);
  expect(designRouting(DESIGN_TABLE)).toEqual([
    "provision",
    "design:dispatch",
    "design:extract",
    "design:size",
    "design:review",
  ]);
});

test("a failed assertion is a StyreError with exit 70 naming the rule and the steps", () => {
  const bad = replace("design:size", { produces: ["track", "workUnits"] });
  try {
    assertDesignTable(bad);
    throw new Error("expected a refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(DesignTableError);
    expect((err as DesignTableError).code).toBe(EXIT.INTERNAL);
    expect(String((err as DesignTableError).detail)).toContain("design:size");
  }
});

test("design:size declares the plan only when grading is on, and declaresInput sees both", () => {
  const size = steps(DESIGN_TABLE).find((r) => r.stepKey === "design:size") as StepRow;
  expect(size.inputs({ complexityGrading: false })).not.toContain("plan");
  expect(size.inputs({ complexityGrading: true })).toContain("plan");
  expect(declaresInput("design:size", "plan")).toBe(true);
  expect(declaresInput("design:dispatch", "workUnits")).toBe(false);
  expect(declaresInput("checks:dispatch", "workUnits")).toBe(false);
});

// Beyond the brief's seven: each case below pins one behaviour the seven leave open.

test("the exit code of a broken table is the literal 70, and every violation is listed", () => {
  expect(EXIT.INTERNAL).toBe(70);
  const bad = replace("design:size", {
    produces: ["track", "workUnits"],
    inputs: () => ["ghost" as InputName],
  });
  let caught: unknown;
  try {
    assertDesignTable(bad);
  } catch (err) {
    caught = err;
  }
  const e = caught as DesignTableError;
  expect(e.code).toBe(70);
  expect(e.name).toBe("DesignTableError");
  expect(e.headline).toBe("the declared design table breaks its own rules");
  expect(String(e.detail)).toContain(
    "rule 2: workUnits is produced by design:extract and design:size",
  );
  expect(String(e.detail)).toContain("rule 1: design:size reads ghost");
  expect(String(e.detail).split("\n").length).toBeGreaterThanOrEqual(2);
});

test("assertDesignTable and ensureDesignTableChecked accept the shipped table", () => {
  expect(() => assertDesignTable()).not.toThrow();
  expect(() => assertDesignTable(DESIGN_TABLE)).not.toThrow();
  expect(() => ensureDesignTableChecked()).not.toThrow();
  expect(() => ensureDesignTableChecked()).not.toThrow();
});

test("rule 3 also refuses a step that reads its own output", () => {
  const bad = replace("design:extract", { inputs: () => ["plan", "workUnits"] });
  expect(checkDesignTable(bad).join("\n")).toMatch(
    /rule 3: design:extract reads workUnits, produced later by design:extract/,
  );
});

test("rules 1 and 3 look at both values of complexityGrading, not only the first", () => {
  const onlyWhenGradingOn = replace("design:size", {
    inputs: (c) => (c.complexityGrading ? (["ghost" as InputName] as const) : ["workUnits"]),
  });
  expect(checkDesignTable(onlyWhenGradingOn).join("\n")).toMatch(/rule 1: design:size reads ghost/);
  const onlyWhenGradingOff = replace("design:size", {
    inputs: (c) => (c.complexityGrading ? ["workUnits"] : ["planFindings"]),
  });
  expect(checkDesignTable(onlyWhenGradingOff).join("\n")).toMatch(
    /rule 3: design:size reads planFindings, produced later by design:review/,
  );
});

test("rule 1 refuses a gate that reads an output no step produces", () => {
  const gate = DESIGN_TABLE.find((r): r is GateRow => r.kind === "gate") as GateRow;
  const bad = DESIGN_TABLE.map((r) => (r === gate ? { ...gate, reads: ["ghost" as never] } : r));
  expect(checkDesignTable(bad).join("\n")).toMatch(
    /rule 1: gate plan-review reads ghost, which no step produces/,
  );
  const noProducer = DESIGN_TABLE.map((r) =>
    r.kind === "step" && r.stepKey === "design:review" ? { ...r, produces: [] } : r,
  );
  expect(checkDesignTable(noProducer).join("\n")).toMatch(
    /rule 1: gate plan-review reads planFindings, which no step produces/,
  );
});

// Task 13: the walk evaluates a gate where it stands and returns its escalation for its step.
const gateOf = (t: readonly DesignRow[]) =>
  t.find((r): r is GateRow => r.kind === "gate") as GateRow;
const replaceGate = (patch: Partial<GateRow>): DesignRow[] =>
  DESIGN_TABLE.map((r) => (r.kind === "gate" ? { ...r, ...patch } : r));

test("a gate placed before the step that produces what it reads is refused (rule 3)", () => {
  const gate = gateOf(DESIGN_TABLE);
  const early = [gate, ...DESIGN_TABLE.filter((r) => r !== gate)];
  expect(checkDesignTable(early)).toEqual([
    "rule 3: gate plan-review reads planFindings, produced later by design:review",
  ]);
  const e = (() => {
    try {
      assertDesignTable(early);
    } catch (err) {
      return err as DesignTableError;
    }
    throw new Error("assertDesignTable accepted a gate placed before its producer");
  })();
  expect(e.code).toBe(EXIT.INTERNAL); // 70
});

test("a gate whose step is not a step of the table is refused", () => {
  expect(checkDesignTable(replaceGate({ stepKey: "checks:dispatch" as never }))).toEqual([
    "gate plan-review: its step checks:dispatch is not a step of the table",
  ]);
});

test("a gate that applies where its step does not is refused, on each such track", () => {
  expect(checkDesignTable(replaceGate({ appliesWhen: () => true }))).toEqual([
    "gate plan-review: applies on track unset, where its step design:review does not",
    "gate plan-review: applies on track fast, where its step design:review does not",
  ]);
  // narrower than its step is fine: the gate fires on a subset of the step's rounds
  expect(checkDesignTable(replaceGate({ appliesWhen: () => false }))).toEqual([]);
});

test("a snapshot input is accepted by rule 1 in any position; an output is not a snapshot input", () => {
  for (const n of SNAPSHOT_INPUT_NAMES) {
    const ok = replace("provision", { inputs: () => [n] });
    expect(checkDesignTable(ok)).toEqual([]);
  }
  const bad = replace("provision", { inputs: () => ["plan"] });
  expect(checkDesignTable(bad).join("\n")).toMatch(/rule 3: provision reads plan, produced later/);
});

test("the routing is generated from the table: gates are skipped, order is table order", () => {
  const reversed = [...DESIGN_TABLE].reverse();
  expect(designRouting(reversed)).toEqual([
    "design:review",
    "design:size",
    "design:extract",
    "design:dispatch",
    "provision",
  ]);
  expect(designRouting([])).toEqual([]);
  expect(designRouting(DESIGN_TABLE)).toHaveLength(steps(DESIGN_TABLE).length);
});

test("stepRow and isTableStep find the five design steps and nothing else", () => {
  for (const key of designRouting(DESIGN_TABLE)) {
    expect(isTableStep(key)).toBe(true);
    expect(stepRow(key)?.stepKey).toBe(key);
  }
  for (const other of ["checks:dispatch", "checks:classify", "implement", "plan-review", ""]) {
    expect(isTableStep(other)).toBe(false);
    expect(stepRow(other)).toBeUndefined();
  }
});

test("isSnapshotInput is true for the ten snapshot names and false for outputs and noise", () => {
  expect(SNAPSHOT_INPUT_NAMES).toHaveLength(10);
  for (const n of SNAPSHOT_INPUT_NAMES) expect(isSnapshotInput(n)).toBe(true);
  for (const n of ["plan", "workUnits", "track", "planFindings", "ghost", ""]) {
    expect(isSnapshotInput(n)).toBe(false);
  }
  expect(TICKET_TEXT_INPUTS).toEqual(["ticket.ident", "ticket.title", "ticket.description"]);
  for (const n of TICKET_TEXT_INPUTS) expect(isSnapshotInput(n)).toBe(true);
});

test("declaresInput is true under either grading value and false for a step that never reads it", () => {
  // Declared in both contexts.
  expect(declaresInput("design:extract", "plan")).toBe(true);
  expect(declaresInput("design:size", "workUnits")).toBe(true);
  // Declared only with grading on (the grader's inputs).
  for (const n of ["ticket.title", "profile.slug", "profile.promptVars", "plan"] as const) {
    expect(declaresInput("design:size", n)).toBe(true);
  }
  // ticket.title is declared by design:size only when grading is on; declaresInput still sees it.
  expect((stepRow("design:size") as StepRow).inputs({ complexityGrading: false })).not.toContain(
    "ticket.title",
  );
  // Never declared.
  expect(declaresInput("provision", "plan")).toBe(false);
  expect(declaresInput("design:review", "ticket.description")).toBe(false);
  expect(declaresInput("design:extract", "ticket.description")).toBe(false);
  expect(declaresInput("design:extract", "workUnits")).toBe(false);
  expect(declaresInput("not-a-step", "plan")).toBe(false);
});

// The declared inputs, checked against what the handlers and prompt variable functions read at the
// commit this task was written against (see the task report for the line by line comparison).
test("the shipped table declares exactly the inputs the handlers read", () => {
  const off = { complexityGrading: false };
  const on = { complexityGrading: true };
  const row = (k: string) => stepRow(k) as StepRow;
  expect(row("provision").inputs(off)).toEqual([
    "profile.components",
    "run.unusableComponents",
    "run.nonPrimaryComponents",
  ]);
  expect(row("design:dispatch").inputs(off)).toEqual([
    "ticket.title",
    "ticket.description",
    "profile.slug",
    "profile.promptVars",
    "profile.runtimeContext",
    "profile.components",
  ]);
  expect(row("design:extract").inputs(off)).toEqual([
    "ticket.ident",
    "ticket.title",
    "profile.slug",
    "profile.promptVars",
    "profile.runtimeContext",
    "profile.components",
    "plan",
  ]);
  expect(row("design:size").inputs(off)).toEqual(["config.complexityGrading", "workUnits"]);
  expect(row("design:size").inputs(on)).toEqual([
    "config.complexityGrading",
    "workUnits",
    "ticket.title",
    "profile.slug",
    "profile.promptVars",
    "plan",
  ]);
  expect(row("design:review").inputs(off)).toEqual([
    "ticket.title",
    "profile.slug",
    "profile.promptVars",
    "plan",
    "workUnits",
  ]);
  // The reviewer does not read the ticket description (prompt-vars.ts designReviewVars).
  expect(row("design:review").inputs(on)).not.toContain("ticket.description");
});

test("each row carries its handler key, outputs, feedback and file output flag", () => {
  const view = steps(DESIGN_TABLE).map((r) => ({
    k: r.stepKey,
    type: r.stepType,
    handler: r.handlerKey,
    produces: r.produces,
    feedback: r.feedback,
    file: r.fileOutput,
  }));
  expect(view).toEqual([
    {
      k: "provision",
      type: "provision",
      handler: "provision",
      produces: [],
      feedback: [],
      file: false,
    },
    {
      k: "design:dispatch",
      type: "dispatch",
      handler: "design:dispatch",
      produces: ["plan"],
      feedback: ["design loopback findings"],
      file: true,
    },
    {
      k: "design:extract",
      type: "dispatch",
      handler: "design:extract",
      produces: ["workUnits"],
      feedback: [],
      file: false,
    },
    {
      k: "design:size",
      type: "dispatch",
      handler: "design:size",
      produces: ["track"],
      feedback: [],
      file: false,
    },
    {
      k: "design:review",
      type: "dispatch",
      handler: "design:review",
      produces: ["planFindings"],
      feedback: [],
      file: false,
    },
  ]);
});

test("appliesWhen: every step runs on any track except the review, which runs on the full track", () => {
  for (const track of ["fast", "full", null] as const) {
    for (const r of steps(DESIGN_TABLE)) {
      const expected = r.stepKey === "design:review" ? track === "full" : true;
      expect(r.appliesWhen({ track } as never)).toBe(expected);
    }
  }
});

test("the plan review gate row: full track only, reads the findings, names the review step", () => {
  const gates = DESIGN_TABLE.filter((r): r is GateRow => r.kind === "gate");
  expect(gates).toHaveLength(1);
  const gate = gates[0];
  expect(gate.name).toBe("plan-review");
  expect(gate.reads).toEqual(["planFindings"]);
  expect(gate.reason).toBe("unresolved plan-review findings");
  expect(gate.signature).toBe("review:unresolved-plan");
  expect(gate.stepKey).toBe("design:review");
  expect(gate.appliesWhen({ track: "full" } as never)).toBe(true);
  expect(gate.appliesWhen({ track: "fast" } as never)).toBe(false);
  expect(gate.appliesWhen({ track: null } as never)).toBe(false);
  // The gate's step is a step of the table.
  expect(isTableStep(gate.stepKey)).toBe(true);
});

// `ensureDesignTableChecked` memoises per module instance, and the shipped table is valid, so a
// fresh instance of the module (a query string gives Bun a separate copy) is the only way to see it
// refuse a broken table without touching the instance the other tests use.
const freshModule = async (
  tag: string,
): Promise<typeof import("../../src/daemon/design-graph.ts")> =>
  import(`../../src/daemon/design-graph.ts?${tag}`);

test("ensureDesignTableChecked asserts the table the first time and refuses a broken one", async () => {
  const fresh = await freshModule("ensure-refuses");
  expect(fresh.DESIGN_TABLE).not.toBe(DESIGN_TABLE); // a separate copy of the module
  const table = fresh.DESIGN_TABLE as DesignRow[];
  table.push(table[1]); // design:dispatch listed twice: rule 4
  let caught: unknown;
  try {
    fresh.ensureDesignTableChecked();
  } catch (err) {
    caught = err;
  }
  const e = caught as { name: string; code: number; detail: string };
  expect(e.name).toBe("DesignTableError");
  expect(e.code).toBe(70);
  expect(e.detail).toContain("rule 4: design:dispatch appears twice");
});

test("ensureDesignTableChecked checks once per process: a table that was fine stays accepted", async () => {
  const fresh = await freshModule("ensure-once");
  fresh.ensureDesignTableChecked();
  (fresh.DESIGN_TABLE as DesignRow[]).push(fresh.DESIGN_TABLE[1]);
  expect(() => fresh.ensureDesignTableChecked()).not.toThrow();
  // The assertion itself is not cached: it still sees the broken table.
  expect(() => fresh.assertDesignTable()).toThrow();
  // The instance the other tests use was never touched.
  expect(checkDesignTable(DESIGN_TABLE)).toEqual([]);
});
