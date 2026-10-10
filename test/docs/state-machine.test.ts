// Keeps docs/architecture/state-machine.html in step with the code (operator request, ENG-477
// Task 18). The page's states and transitions are data; these tests derive what they can from the
// code (the declared design table, the resolver's stages, step keys, advances, escalations and
// descriptor kinds, the literal unions and literals of causes, loops, signatures (property and
// positional), outcomes, pause reasons, failure decisions and review resume plans, the caps, and
// the count of places that write an escalation) and fail, naming the
// difference, when either side has something the other lacks. Every cited line must still exist.
// The last group proves each check can fail.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DESIGN_TABLE, type DesignRow } from "../../src/daemon/design-graph.ts";
import {
  type Diagram,
  PAGE,
  callArgs,
  checkGrounding,
  codeFacts,
  diffAgainstCode,
  expand,
  readDiagram,
  validateStructure,
} from "./state-machine-check.ts";

const diagram = (): Diagram => readDiagram(readFileSync(PAGE, "utf8"));
const clone = (d: Diagram): Diagram => structuredClone(d);

describe("docs/architecture/state-machine.html", () => {
  test("its data block parses and holds states, transitions and scenarios", () => {
    const d = diagram();
    expect(d.schemaVersion).toBe(1);
    expect(d.states.length).toBeGreaterThan(0);
    expect(d.transitions.length).toBeGreaterThan(0);
    expect(d.scenarios.length).toBeGreaterThan(0);
  });

  test("its data is whole: every end exists, every scenario chains, every state is reachable", () => {
    expect(validateStructure(diagram())).toEqual([]);
  });

  test("every state and transition cites a file, symbol and line that exist", () => {
    expect(checkGrounding(diagram())).toEqual([]);
  });

  test("it agrees with the code, both ways", () => {
    expect(diffAgainstCode(diagram(), codeFacts())).toEqual([]);
  });

  test("the scenarios the operator asked for are present", () => {
    const ids = diagram().scenarios.map((s) => s.id);
    for (const id of [
      "success-fast",
      "success-full",
      "plan-review-redesign",
      "plan-review-twice",
      "plan-review-gate",
      "checks-reauthor",
      "ac-gate-cap",
      "review-code-findings",
      "review-same-findings",
      "review-repair-limit",
      "review-plan-defect-escalate",
      "review-plan-defect-redesign",
      "input-edited-on-resume",
      "budget-pause-resume",
    ])
      expect(ids).toContain(id);
  });

  test("the page loads nothing from the network", () => {
    const html = readFileSync(PAGE, "utf8");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});

// Each check is shown to fail on a copy of the data or of the table, so none stays green whatever
// changes. (The same breaks made to the real page and the real table are recorded in the Task 18
// report.)
describe("the checks fail on a difference", () => {
  test("a transition removed from the diagram", () => {
    const d = clone(diagram());
    d.transitions = d.transitions.filter((t) => t.id !== "t.walk.design:size>design:review");
    expect(diffAgainstCode(d, codeFacts())).toContain(
      "design walk edge: 'design:size>design:review' is in the code but not in the diagram",
    );
    expect(
      validateStructure(d).some((l) =>
        l.includes("'t.walk.design:size>design:review', which does not exist"),
      ),
    ).toBe(true);
  });

  test("a step added to the design table", () => {
    // A key the table's type does not know yet: the cast is the point of the test.
    const extra = {
      kind: "step",
      stepKey: "design:extra",
      stepType: "dispatch",
      handlerKey: "design:extra",
      appliesWhen: () => true,
      inputs: () => ["plan"],
      feedback: [],
      produces: [],
      fileOutput: false,
    } as unknown as DesignRow;
    const table = [...DESIGN_TABLE.slice(0, 3), extra, ...DESIGN_TABLE.slice(3)];
    const diff = diffAgainstCode(diagram(), codeFacts(undefined, table));
    expect(diff).toContain("design table step 'design:extra' has no state in the diagram");
    expect(diff).toContain(
      "design walk edge: 'design:extra>design:size' is in the code but not in the diagram",
    );
    expect(diff).toContain(
      "step (stage|step key): 'design|design:extra' is in the code but not in the diagram",
    );
  });

  test("a state the code does not serve", () => {
    const d = clone(diagram());
    const docs = d.states.find((s) => s.id === "docs:revise");
    if (!docs) throw new Error("docs:revise missing");
    d.states.push({ ...docs, id: "docs:extra", stepKey: "docs:extra" });
    d.layout["docs:extra"] = [1, 1];
    expect(diffAgainstCode(d, codeFacts())).toContain(
      "step (stage|step key): 'implement|docs:extra' is in the diagram but not in the code",
    );
  });

  test("a value the code does not declare", () => {
    const d = clone(diagram());
    const t = d.transitions.find((x) => x.id === "t.checks.reauthor");
    if (!t) throw new Error("t.checks.reauthor missing");
    t.loop = "plan";
    t.cause = "operator";
    const diff = diffAgainstCode(d, codeFacts());
    expect(diff).toContain("event_log loop: 'plan' is in the diagram but not in the code");
    expect(diff).toContain("invalidate cause: 'operator' is in the diagram but not in the code");
  });

  test("a scenario naming a missing transition, or a broken chain", () => {
    const d = clone(diagram());
    const sc = d.scenarios[0];
    if (!sc) throw new Error("no scenario");
    sc.transitions = [
      ...sc.transitions.slice(0, 2),
      "t.no-such-transition",
      ...sc.transitions.slice(2),
    ];
    const lines = validateStructure(d);
    expect(
      lines.some((l) =>
        l.includes("names transition 't.no-such-transition', which does not exist"),
      ),
    ).toBe(true);
    const d2 = clone(diagram());
    const sc2 = d2.scenarios[0];
    if (!sc2) throw new Error("no scenario");
    sc2.transitions = [sc2.transitions[0] as string, sc2.transitions[2] as string];
    expect(validateStructure(d2).some((l) => l.includes("starts at"))).toBe(true);
  });

  test("a state no transition reaches", () => {
    const d = clone(diagram());
    d.transitions = d.transitions.filter((t) => t.to !== "esc:tick-cap");
    expect(validateStructure(d)).toContain(
      "state 'esc:tick-cap' cannot be reached from run.start or resume.start",
    );
  });

  test("a cited line that is gone", () => {
    const d = clone(diagram());
    const t = d.transitions.find((x) => x.id === "t.pick.stuck");
    if (!t) throw new Error("t.pick.stuck missing");
    t.anchor = 'if (blamed && done(db, ticketId, "verify:checks-gate-renamed")) {';
    expect(
      checkGrounding(d).some((l) =>
        l.startsWith("transition 't.pick.stuck': the cited line is not in"),
      ),
    ).toBe(true);
  });

  test("a cap that differs", () => {
    const d = clone(diagram());
    d.constants.GATE_ROUND_CAP = 4;
    expect(diffAgainstCode(d, codeFacts())).toContain(
      "cap: 'GATE_ROUND_CAP=3' is in the code but not in the diagram",
    );
  });

  test("group transitions expand to one per member", () => {
    const d = diagram();
    const n = d.groups.steps?.members.length ?? 0;
    expect(n).toBeGreaterThan(0);
    expect(expand(d).filter((t) => t.id.startsWith("t.any.stop@")).length).toBe(n);
  });
  test("a positional escalate signature is read", () => {
    const calls = callArgs(
      'x(); escalate(db, ticketId, "flooded", "review-flood", id); function escalate(a, b) {}',
      "escalate",
    );
    expect(calls).toEqual([["db", "ticketId", '"flooded"', '"review-flood"', "id"]]);
  });

  test("an escalation write site the diagram does not count", () => {
    const d = clone(diagram());
    d.escalationWrites["src/daemon/advance.ts"] = 3;
    expect(diffAgainstCode(d, codeFacts())).toContain(
      "escalation write sites (file=count): 'src/daemon/advance.ts=4' is in the code but not in the diagram",
    );
  });

  test("a run cap the condition does not state", () => {
    const d = clone(diagram());
    d.constants.IDLE_CAP = 4;
    expect(validateStructure(d)).toContain(
      "transition 't.any.stalled' cites IDLE_CAP = 4 but its condition does not say 4",
    );
    expect(diffAgainstCode(d, codeFacts())).toContain(
      "cap: 'IDLE_CAP=3' is in the code but not in the diagram",
    );
  });
});
