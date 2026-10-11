// Keeps docs/architecture/state-machine.html in step with the code (operator request, ENG-477
// Task 18). The page's states and transitions are data; these tests derive what they can from the
// code (the declared design table, the resolver's stages, step keys, advances, escalations and
// descriptor kinds, the literal unions and literals of causes, loops, signatures (property and
// positional), outcomes, pause reasons, failure decisions and review resume plans, the caps, every
// line that refuses a start or resume (with its exit codes and the starts that reach it), and every
// line that writes an escalation) and fail, naming the difference, when either side has something
// the other lacks. Every cited line must still exist. The drawing is checked too: every node has a
// place, the escalations are drawn as the one Escalated node, no two nodes overlap, every step sits
// in its stage lane, and every scenario names the scenario it differs from. The last group proves
// each check can fail, on copies of the data or of the code.
import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESIGN_TABLE, type DesignRow } from "../../src/daemon/design-graph.ts";
import { makeTempDir } from "../helpers/temp.ts";
import {
  type Diagram,
  PAGE,
  REPO,
  blankComments,
  callArgs,
  checkGrounding,
  checkSites,
  codeFacts,
  diffAgainstCode,
  expand,
  readDiagram,
  refusalSitesIn,
  validateStructure,
} from "./state-machine-check.ts";

const diagram = (): Diagram => readDiagram(readFileSync(PAGE, "utf8"));
const clone = (d: Diagram): Diagram => structuredClone(d);

/** A private copy of src/, so a test can edit the code the census reads without touching the
 *  repository. Each edit replaces text that must occur exactly once in the file. */
function codeCopy(edits: { file: string; find: string; replace: string }[]): string {
  const root = makeTempDir("state-machine-src-");
  cpSync(join(REPO, "src"), join(root, "src"), { recursive: true });
  for (const e of edits) {
    const path = join(root, e.file);
    const text = readFileSync(path, "utf8");
    const count = text.split(e.find).length - 1;
    if (count !== 1) throw new Error(`${e.file}: '${e.find}' occurs ${count} times, not once`);
    writeFileSync(path, text.replace(e.find, e.replace));
  }
  return root;
}
/** The 1 based line of `text` in `file` under `root` (which must hold it exactly once). */
function lineIn(root: string, file: string, text: string): number {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const at = lines.flatMap((l, i) => (l.includes(text) ? [i + 1] : []));
  if (at.length !== 1) throw new Error(`${file}: '${text}' is on ${at.length} lines, not one`);
  return at[0] as number;
}

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

  test("every refusal and escalation site in the code is drawn, with its exit codes", () => {
    expect(checkSites(diagram())).toEqual([]);
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

  test("escalations are drawn as the one Escalated node, every other state at its own place", () => {
    const d = diagram();
    const id = d.drawing.escalated.id;
    expect(d.layout[id]).toBeDefined();
    expect(d.groups[d.drawing.escalated.group]?.members.length).toBe(24);
    for (const s of d.states) {
      if (s.kind === "escalation") expect(d.layout[s.id]).toBeUndefined();
      else expect(d.layout[s.id]).toBeDefined();
    }
  });

  test("every scenario names the scenario it differs from, and how", () => {
    const d = diagram();
    const ids = new Set(d.scenarios.map((s) => s.id));
    for (const sc of d.scenarios) {
      expect(ids.has(sc.differsFrom.scenario)).toBe(true);
      expect(sc.differsFrom.scenario).not.toBe(sc.id);
      expect(sc.differsFrom.note.length).toBeGreaterThan(20);
    }
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

  test("a refusal or escalation edge deleted from the diagram", () => {
    const d = clone(diagram());
    d.transitions = d.transitions.filter(
      (t) => t.id !== "t.start.agent-cli" && t.id !== "t.resume.retry-escalate",
    );
    const lines = checkSites(d);
    expect(lines).toContain(
      "refusal site 'if (!cliPreflight.ok) throw agentCliError(cliPreflight);' lists 't.start.agent-cli', which is not a transition",
    );
    expect(lines.some((l) => l.includes("exits 69,78 in the code, but its drawn edges"))).toBe(
      true,
    );
    expect(lines).toContain(
      "escalation site '\"no progress: identical review findings\"' lists 't.resume.retry-escalate', which is not a transition",
    );
  });

  test("a refusal edge drawn to the wrong exit", () => {
    const d = clone(diagram());
    const t = d.transitions.find((x) => x.id === "t.start.pr-base");
    if (!t) throw new Error("t.start.pr-base missing");
    t.to = "exit:usage";
    expect(
      checkSites(d).some(
        (l) =>
          l.includes("resolve-pr-base.ts") &&
          l.includes("exits 78 in the code, but its drawn edges (t.start.pr-base) exit 64"),
      ),
    ).toBe(true);
  });

  test("a code site the diagram does not declare", () => {
    const d = clone(diagram());
    d.refusalSites = d.refusalSites.filter(
      (x) => x.anchor !== '"--ticket is required when not using --resume",',
    );
    d.escalationSites = d.escalationSites.filter((x) => x.to !== "esc:outbox");
    const lines = checkSites(d);
    expect(
      lines.some((l) => l.startsWith("refusal in the code is not drawn: src/cli/run.ts:")),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.startsWith("escalation in the code is not drawn: src/daemon/projector.ts:"),
      ),
    ).toBe(true);
    expect(lines).toContain("refusal edge 't.run.no-ticket' is listed at no refusal site");
    expect(lines).toContain("escalation edge 't.any.outbox' is listed at no escalation site");
  });

  test("a misplaced drawing: an escalation drawn alone, a state left out, overlaps, a step outside its lane", () => {
    const d = clone(diagram());
    const at = (id: string) => d.layout[id] as [number, number];
    d.layout["esc:stalled"] = [at("review")[0], at("review")[1] + 400];
    d.layout = Object.fromEntries(Object.entries(d.layout).filter(([k]) => k !== "merge:push"));
    const extract = at("design:extract");
    d.layout["design:size"] = [extract[0] + 30, extract[1] + 10];
    d.layout["docs:revise"] = at("review");
    const lines = validateStructure(d);
    expect(lines).toContain(
      "escalation state 'esc:stalled' has a layout position; escalations are drawn as the one Escalated node",
    );
    expect(lines).toContain("state 'merge:push' has no layout position");
    expect(lines).toContain("drawn nodes 'design:extract' and 'design:size' overlap");
    expect(lines).toContain("state 'docs:revise' (stage implement) is not inside its lane");
    const d2 = clone(diagram());
    const escId = d2.drawing.escalated.id;
    d2.layout = Object.fromEntries(Object.entries(d2.layout).filter(([k]) => k !== escId));
    expect(validateStructure(d2)).toContain(
      "the Escalated node 'escalated' has no layout position",
    );
  });

  test("a drawing that breaks a rule: no stage in a lane, lanes overlapping, off the canvas, an unknown key (D1 to D4)", () => {
    const d = clone(diagram());
    d.layout["run.prepare"] = [1260, 300]; // a free place inside the design lane
    const review = d.drawing.lanes.find((l) => l.stage === "review");
    if (!review) throw new Error("no review lane");
    review.box = [2050, review.box[1], review.box[2], review.box[3]];
    d.layout["outcome:done"] = [2990, 990];
    d.layout.ghost = [100, 1040];
    const lines = validateStructure(d);
    expect(lines).toContain("state 'run.prepare' has no stage but sits in the design lane");
    expect(lines).toContain("lanes 'implement' and 'review' overlap");
    expect(lines).toContain("drawn node 'outcome:done' lies outside the canvas");
    expect(lines).toContain("layout names 'ghost', which is not a state");
  });

  test("two nodes clear of each other but closer than the gap; a hub's own size", () => {
    const d = clone(diagram());
    const extract = d.layout["design:extract"] as [number, number];
    const step = d.drawing.sizes.step as [number, number];
    d.layout["design:size"] = [extract[0], extract[1] + step[1] + 10]; // 10 apart, gap 24
    expect(validateStructure(d)).toContain(
      "drawn nodes 'design:extract' and 'design:size' overlap",
    );
    const d2 = clone(diagram());
    const hub = d2.layout["implement.pick"] as [number, number];
    const hubSize = d2.drawing.hubs["implement.pick"] as [number, number];
    // Clear of a plain helper's box, inside the hub's.
    d2.layout["mark-verified"] = [hub[0], hub[1] - hubSize[1] / 2 - 20];
    expect(validateStructure(d2)).toContain(
      "drawn nodes 'implement.pick' and 'mark-verified' overlap",
    );
  });

  test("a scenario whose differsFrom names no scenario", () => {
    const d = clone(diagram());
    const [a, b] = d.scenarios;
    if (!a || !b) throw new Error("fewer than two scenarios");
    a.differsFrom = { scenario: "no-such-scenario", note: "x" };
    b.differsFrom = { scenario: b.id, note: "x" };
    const lines = validateStructure(d);
    expect(lines).toContain(
      `scenario '${a.id}' differs from 'no-such-scenario', which is not a scenario`,
    );
    expect(lines).toContain(`scenario '${b.id}' differs from itself`);
  });

  // The census of refusal sites, against edits to a private copy of the code.

  test("a refusal added to loadProfile is counted (F)", () => {
    const root = codeCopy([
      {
        file: "src/dispatch/profile.ts",
        find: "export function loadProfile(path: string): Profile {\n",
        replace:
          'export function loadProfile(path: string): Profile {\n  if (path === "") throw new Error("profile: empty path");\n',
      },
    ]);
    const line = lineIn(root, "src/dispatch/profile.ts", 'throw new Error("profile: empty path")');
    expect(checkSites(diagram(), root)).toContain(
      `refusal in the code is not drawn: src/dispatch/profile.ts:${line} (throw new Error)`,
    );
  });

  test("an exit code set through EXIT is read (I)", () => {
    const line = "process.exitCode = 65; // EXIT.RESUME_REFUSED";
    const root = codeCopy([
      { file: "src/cli/run.ts", find: line, replace: "process.exitCode = EXIT.USAGE; // usage" },
    ]);
    const d = clone(diagram());
    const site = d.refusalSites.find((x) => x.anchor === line);
    if (!site) throw new Error("the newer scheme site is missing");
    site.anchor = "process.exitCode = EXIT.USAGE; // usage";
    expect(
      checkSites(d, root).some((l) =>
        l.endsWith(
          "(process.exitCode) exits 64 in the code, but its drawn edges (t.run.newer-scheme) exit 65",
        ),
      ),
    ).toBe(true);
  });

  test("a throw of another error class is counted with the exit its class maps to (J)", () => {
    const root = codeCopy([
      {
        file: "src/cli/run.ts",
        find: "    const slug: string = loaded.slug;\n",
        replace:
          '    const slug: string = loaded.slug;\n    if (slug === "") throw new DesignTableError(["x"]);\n    if (slug === " ") throw new StepPrerequisiteError("y");\n',
      },
    ]);
    const sites = refusalSitesIn(root).filter((c) => c.file === "src/cli/run.ts");
    expect(sites.find((c) => c.what === "throw new DesignTableError")?.codes).toEqual([70]);
    expect(sites.find((c) => c.what === "throw new StepPrerequisiteError")?.codes).toEqual([70]);
    const lines = checkSites(diagram(), root);
    expect(lines.some((l) => l.endsWith("(throw new DesignTableError)"))).toBe(true);
    const unknown = codeCopy([
      {
        file: "src/cli/run.ts",
        find: "    const slug: string = loaded.slug;\n",
        replace:
          '    const slug: string = loaded.slug;\n    if (slug === "") throw new NoSuchError();\n',
      },
    ]);
    expect(() => refusalSitesIn(unknown)).toThrow("NoSuchError");
  });

  test("padding near a site stays green; an anchor moved off its call goes red (G)", () => {
    const padded = codeCopy([
      {
        file: "src/dispatch/worktree.ts",
        find: "    if (holder !== null) {\n",
        replace: `    if (holder !== null) {\n${"      // padding\n".repeat(8)}\n`,
      },
    ]);
    expect(checkSites(diagram(), padded)).toEqual([]);
    const d = clone(diagram());
    const site = d.refusalSites.find((x) => x.anchor === "if (holder !== null) {");
    if (!site) throw new Error("the worktree holder site is missing");
    site.anchor = "if (foreignLive) {";
    expect(
      checkSites(d).some((l) =>
        l.startsWith("refusal site 'if (foreignLive) {' (src/dispatch/worktree.ts:"),
      ),
    ).toBe(true);
  });

  test("a resume refusal erased from a site both starts reach (H)", () => {
    const d = clone(diagram());
    const gone = "t.resume.in-place-unsafe";
    d.transitions = d.transitions.filter((t) => t.id !== gone);
    for (const s of d.refusalSites) s.edges = s.edges.filter((e) => e !== gone);
    expect(validateStructure(d)).toEqual([]);
    const anchor = "--in-place refused: no .styre-disposable marker";
    const line = lineIn(REPO, "src/dispatch/in-place.ts", anchor);
    expect(checkSites(d)).toContain(
      `refusal site '${anchor}' (src/dispatch/in-place.ts:${line}) is reached from a resume, but lists no edge from resume.start or @starts`,
    );
  });

  test("an edge from a start that never reaches its site (H2)", () => {
    const d = clone(diagram());
    const anchor = "if (!ticket) throw noOwnTicket(ident, dir, reason, listCheckpointIdents(db));";
    const site = d.refusalSites.find((x) => x.anchor === anchor);
    if (!site) throw new Error("the resume's own ticket site is missing");
    site.edges.push("t.run.newer-scheme"); // a fresh run refusal that also exits 65
    const line = lineIn(REPO, "src/cli/park.ts", anchor);
    expect(checkSites(d)).toContain(
      `refusal site '${anchor}' (src/cli/park.ts:${line}) lists 't.run.newer-scheme' from run.start, but a fresh run never reaches it`,
    );
  });

  test("an edge of both starts whose sites only one start reaches (H3)", () => {
    const d = clone(diagram());
    const site = d.refusalSites.find((x) => x.anchor === "throw agentCliError(cliPreflight);");
    if (!site) throw new Error("the resume's agent command line tool site is missing");
    site.edges = site.edges.filter((e) => e !== "t.start.agent-cli");
    expect(checkSites(d)).toContain(
      "refusal edge 't.start.agent-cli' leaves both starts, but only a fresh run reaches the sites that list it",
    );
  });

  test("a guard on --resume the census cannot read is refused loudly (I4)", () => {
    for (const [find, replace] of [
      ["      !args.resume &&\n", "      !args.resume ||\n"],
      ["      !args.resume &&\n", "      args.resume ||\n"],
      [
        '    if (args["in-place"] && !(args.resume && args.resume.length > 0)) {',
        '    if (args["in-place"] || !(args.resume && args.resume.length > 0)) {',
      ],
      // Every && part a known shape, but an || after them lets a resume through.
      ["      !args.resume &&\n", "      !args.resume && args.inspect ||\n"],
      // No ||, a known part, and beside it a part that is not one of the known shapes.
      ["      !args.resume &&\n", '      !args.resume && args.resume !== "x" &&\n'],
    ] as const) {
      const root = codeCopy([{ file: "src/cli/run.ts", find, replace }]);
      expect(() => refusalSitesIn(root)).toThrow(
        /refusal census: src\/cli\/run\.ts:\d+: an if around a refusal reads args\.resume in a shape the census cannot read/,
      );
    }
  });

  test("a regular expression that spells a refusal is not a refusal (RX)", () => {
    const root = codeCopy([
      {
        file: "src/dispatch/profile.ts",
        find: "export function loadProfile(path: string): Profile {\n",
        replace:
          'export function loadProfile(path: string): Profile {\n  if (/throw new Error(".*")/.test(path)) return parseProfile({}, path);\n',
      },
    ]);
    expect(checkSites(diagram(), root)).toEqual([]);
  });

  test("calls and brackets inside strings and templates are not code to the census (SL, TL)", () => {
    const loadProfile = "export function loadProfile(path: string): Profile {\n";
    const legacy = '    throw new Error(\n      "profile: legacy flat';
    const v2 = '    throw new Error(\n      "profile: schemaVersion 2 profile';
    for (const edit of [
      // A refusal spelled inside a string, and inside a template with a substitution.
      {
        find: loadProfile,
        replace: `${loadProfile}  if (path === "throw new Error(") return parseProfile({}, path);\n`,
      },
      {
        find: loadProfile,
        replace: `${loadProfile}  const shown = \`usageError(\${path})\`;\n  if (shown === "") return parseProfile({}, path);\n`,
      },
      // A closing bracket inside a string, and inside a template, among a call's arguments, before
      // the declared anchor's line: the call's span must run past it.
      { find: legacy, replace: '    throw new Error(\n      ")" +\n      "profile: legacy flat' },
      {
        find: v2,
        replace: '    throw new Error(\n      `)${""}` +\n      "profile: schemaVersion 2 profile',
      },
    ]) {
      const root = codeCopy([{ file: "src/dispatch/profile.ts", ...edit }]);
      expect(checkSites(diagram(), root)).toEqual([]);
    }
  });

  test("comments are blanked, strings are not (blankComments)", () => {
    const text = [
      'const a = "/*"; throw new Error("kept"); const b = "*/";',
      "x(); // throw new Error('line comment')",
      "/* throw new Error('block') */ y();",
      "const u = `//${z}`; throw new Error(`kept too`);",
      'const t = `a ${f("/*")} b ${`//${g}`} c`; throw new Error("kept three");',
      'const r = /\\/\\*["]/; if (x) /\\/\\/[`]/.test(s); throw new Error("kept four"); // gone',
      "const q = (a) / 2; // division, then a comment",
      'if (x) /"/.test(s); throw new Error("kept five"); // also gone',
      "// first of two",
      "// second of two",
    ].join("\n");
    const out = blankComments(text);
    expect(out.split("\n").length).toBe(10);
    expect(out).not.toContain("first of two");
    expect(out).not.toContain("second of two");
    expect(out).toContain('if (x) /"/.test(s); throw new Error("kept five");');
    expect(out).not.toContain("also gone");
    expect(out).toContain('throw new Error("kept three")');
    expect(out).toContain('throw new Error("kept four")');
    expect(out).toContain('/\\/\\*["]/');
    expect(out).toContain("/\\/\\/[`]/.test(s)");
    expect(out).toContain("(a) / 2;");
    expect(out).not.toContain("gone");
    expect(out).not.toContain("division, then");
    expect(out).toContain('throw new Error("kept")');
    expect(out).toContain("throw new Error(`kept too`)");
    expect(out).not.toContain("line comment");
    expect(out).not.toContain("block");
    expect(out.length).toBe(text.length);
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
