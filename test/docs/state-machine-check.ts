// The checks behind test/docs/state-machine.test.ts: read the state machine data out of
// docs/architecture/state-machine.html, validate it, check that every cited line still exists, and
// compare it with what the code declares. Each check returns one line per difference (empty when
// the two agree), so a failure names exactly what drifted.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/cli/errors.ts";
import { GATE_ROUND_CAP } from "../../src/daemon/arbiter-verdict.ts";
import { DESIGN_TABLE, type DesignRow } from "../../src/daemon/design-graph.ts";
import { INVALIDATE_LOOP_LIMIT } from "../../src/daemon/design-walk.ts";
import { DEFAULT_MAX_ATTEMPTS } from "../../src/daemon/failure-policy.ts";
import { OUTBOX_RETRY_BUDGET } from "../../src/daemon/projector.ts";
import { REVIEW_REPAIR_LIMIT } from "../../src/db/repos/review-round.ts";

export const REPO = join(import.meta.dir, "..", "..");
export const PAGE = join(REPO, "docs", "architecture", "state-machine.html");

export interface Source {
  file: string;
  symbol: string;
}
export interface DiagramState {
  id: string;
  label: string;
  kind: string;
  stage?: string;
  stepKey?: string;
  inputs?: string[];
  produces?: string[];
  outcome?: string;
  reason?: string;
  exitCode?: number;
  exitName?: string;
  description: string;
  source: Source;
  anchor: string;
}
export interface DiagramTransition {
  id: string;
  from: string;
  to: string;
  kind: string;
  label: string;
  condition: string;
  source: Source;
  anchor: string;
  descriptor?: string;
  cause?: string;
  loop?: string;
  signature?: string;
  stageChange?: { from: string; to: string };
  resumePlan?: string;
  constants?: string[];
}
interface Anchored {
  id: string;
  source: Source;
  anchor: string;
}
export interface Diagram {
  schemaVersion: number;
  constants: Record<string, number>;
  entries: string[];
  stages: (Anchored & { label: string })[];
  unroutedStages: (Anchored & { note: string })[];
  unproducedOutcomes: (Anchored & { note: string })[];
  groups: Record<string, { label: string; members: string[]; source: Source; anchor: string }>;
  states: DiagramState[];
  transitions: DiagramTransition[];
  scenarios: { id: string; label: string; summary: string; transitions: string[] }[];
  layout: Record<string, [number, number]>;
  /** Per file, the places that write an escalation (see `escalationWrites` below). */
  escalationWrites: Record<string, number>;
}

const DATA_OPEN = '<script type="application/json" id="state-machine-data">';

/** The JSON of the page's data block, parsed. Throws when the block is missing. */
export function readDiagram(html: string): Diagram {
  const a = html.indexOf(DATA_OPEN);
  if (a < 0) throw new Error("state-machine.html: no state-machine-data block");
  const b = html.indexOf("</script>", a);
  return JSON.parse(html.slice(a + DATA_OPEN.length, b)) as Diagram;
}

export const TRANSITION_KINDS = [
  "forward",
  "advance",
  "loopback",
  "invalidate",
  "retry",
  "escalate",
  "pause",
  "resume",
  "refuse",
  "outcome",
];

/** Group transitions (`from: "@group"`, `to: "@self"`) as one transition per member, with the id
 *  `<id>@<member>`: the form the page shows and the scenarios name. */
export function expand(d: Diagram): DiagramTransition[] {
  const out: DiagramTransition[] = [];
  for (const t of d.transitions) {
    if (!t.from.startsWith("@")) {
      out.push(t);
      continue;
    }
    const group = d.groups[t.from.slice(1)];
    for (const m of group?.members ?? []) {
      out.push({ ...t, id: `${t.id}@${m}`, from: m, to: t.to === "@self" ? m : t.to });
    }
  }
  return out;
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
/** Both directions of a set comparison, as lines. */
function compareSets(what: string, code: Iterable<string>, diagram: Iterable<string>): string[] {
  const c = new Set(code);
  const g = new Set(diagram);
  const out: string[] = [];
  for (const x of sorted(c))
    if (!g.has(x)) out.push(`${what}: '${x}' is in the code but not in the diagram`);
  for (const x of sorted(g))
    if (!c.has(x)) out.push(`${what}: '${x}' is in the diagram but not in the code`);
  return out;
}

/** Ids unique, every end of every transition a state (or a group), every scenario a chain of
 *  transitions that exist, every state reachable from an entry, laid out, and every cap a
 *  transition cites written in its condition. */
export function validateStructure(d: Diagram): string[] {
  const out: string[] = [];
  const stateIds = new Set<string>();
  for (const s of d.states) {
    if (stateIds.has(s.id)) out.push(`state '${s.id}' is listed twice`);
    stateIds.add(s.id);
    if (!s.label || !s.description) out.push(`state '${s.id}' has no label or description`);
    const p = d.layout[s.id];
    if (!p || p.length !== 2 || !p.every(Number.isFinite))
      out.push(`state '${s.id}' has no layout position`);
  }
  for (const id of Object.keys(d.layout))
    if (!stateIds.has(id)) out.push(`layout names '${id}', which is not a state`);
  const positions = new Map<string, string>();
  for (const [id, p] of Object.entries(d.layout)) {
    const key = p.join(",");
    const other = positions.get(key);
    if (other) out.push(`states '${other}' and '${id}' share the layout position ${key}`);
    positions.set(key, id);
  }
  for (const [name, g] of Object.entries(d.groups))
    for (const m of g.members)
      if (!stateIds.has(m)) out.push(`group '${name}' names '${m}', which is not a state`);
  const tIds = new Set<string>();
  for (const t of d.transitions) {
    if (tIds.has(t.id)) out.push(`transition '${t.id}' is listed twice`);
    tIds.add(t.id);
    if (!TRANSITION_KINDS.includes(t.kind))
      out.push(`transition '${t.id}' has an unknown kind '${t.kind}'`);
    if (!t.label || !t.condition) out.push(`transition '${t.id}' has no label or condition`);
    if ((t.condition.match(/`/g) ?? []).length % 2 !== 0)
      out.push(`transition '${t.id}': its condition has an unclosed backtick`);
    if (t.from.startsWith("@")) {
      if (!d.groups[t.from.slice(1)])
        out.push(`transition '${t.id}' starts at unknown group '${t.from}'`);
    } else if (!stateIds.has(t.from))
      out.push(`transition '${t.id}' starts at unknown state '${t.from}'`);
    if (t.to === "@self") {
      if (!t.from.startsWith("@")) out.push(`transition '${t.id}' targets @self without a group`);
    } else if (!stateIds.has(t.to))
      out.push(`transition '${t.id}' ends at unknown state '${t.to}'`);
    for (const c of t.constants ?? []) {
      const v = d.constants[c];
      if (v === undefined) out.push(`transition '${t.id}' cites unknown cap '${c}'`);
      else if (!new RegExp(`\\b${v}\\b`).test(t.condition))
        out.push(`transition '${t.id}' cites ${c} = ${v} but its condition does not say ${v}`);
    }
  }
  const all = expand(d);
  const byId = new Map(all.map((t) => [t.id, t]));
  for (const sc of d.scenarios) {
    if (sc.transitions.length === 0) out.push(`scenario '${sc.id}' is empty`);
    let prev: DiagramTransition | undefined;
    sc.transitions.forEach((id, i) => {
      const t = byId.get(id);
      if (!t) {
        out.push(
          `scenario '${sc.id}' step ${i + 1} names transition '${id}', which does not exist`,
        );
        prev = undefined;
        return;
      }
      if (prev && prev.to !== t.from)
        out.push(
          `scenario '${sc.id}' step ${i + 1} ('${id}') starts at '${t.from}', but step ${i} ended at '${prev.to}'`,
        );
      prev = t;
    });
  }
  const reached = new Set(d.entries);
  for (const e of d.entries) if (!stateIds.has(e)) out.push(`entry '${e}' is not a state`);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all)
      if (reached.has(t.from) && !reached.has(t.to)) {
        reached.add(t.to);
        grew = true;
      }
  }
  for (const s of d.states)
    if (!reached.has(s.id))
      out.push(`state '${s.id}' cannot be reached from ${d.entries.join(" or ")}`);
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const fileCache = new Map<string, string | null>();
function source(root: string, file: string): string | null {
  const key = join(root, file);
  if (!fileCache.has(key))
    fileCache.set(key, existsSync(key) ? norm(readFileSync(key, "utf8")) : null);
  return fileCache.get(key) ?? null;
}

/** Every cited file exists, holds the cited symbol, and holds the cited line (whitespace aside):
 *  a state or transition whose code moved or changed fails here, by name. */
export function checkGrounding(d: Diagram, root: string = REPO): string[] {
  const out: string[] = [];
  const items: { what: string; source: Source; anchor: string }[] = [
    ...d.states.map((s) => ({ what: `state '${s.id}'`, source: s.source, anchor: s.anchor })),
    ...d.transitions.map((t) => ({
      what: `transition '${t.id}'`,
      source: t.source,
      anchor: t.anchor,
    })),
    ...Object.entries(d.groups).map(([n, g]) => ({
      what: `group '${n}'`,
      source: g.source,
      anchor: g.anchor,
    })),
    ...d.stages.map((s) => ({ what: `stage '${s.id}'`, source: s.source, anchor: s.anchor })),
    ...d.unroutedStages.map((s) => ({
      what: `unrouted stage '${s.id}'`,
      source: s.source,
      anchor: s.anchor,
    })),
    ...d.unproducedOutcomes.map((s) => ({
      what: `outcome '${s.id}'`,
      source: s.source,
      anchor: s.anchor,
    })),
  ];
  for (const it of items) {
    const text = it.source?.file ? source(root, it.source.file) : null;
    if (text === null) {
      out.push(`${it.what} cites '${it.source?.file}', which does not exist`);
      continue;
    }
    const sym = it.source.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(^|[^\\w$])${sym}([^\\w$]|$)`).test(text))
      out.push(`${it.what}: '${it.source.symbol}' is not in ${it.source.file}`);
    if (!it.anchor || !text.includes(norm(it.anchor)))
      out.push(`${it.what}: the cited line is not in ${it.source.file}: ${it.anchor}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// What the code declares.

/** Signatures written as an argument or a return value rather than a `signature:` property, so the
 *  property scan below cannot see them. Hand listed; each one's line is checked to still exist. */
export const HAND_SIGNATURES: { signature: string; file: string; line: string }[] = [
  {
    signature: "*:*",
    file: "src/daemon/failure-policy.ts",
    line: "return `${step.step_key}:${message}`;",
  },
  {
    signature: "review:*",
    file: "src/daemon/review-verdict.ts",
    line: 'return `review:${parts.join("|")}`;',
  },
  {
    signature: "review:operator-plan-head-changed",
    file: "src/daemon/review-resume.ts",
    line: '"review:operator-plan-head-changed",',
  },
  {
    signature: "review:operator-head-changed",
    file: "src/daemon/review-resume.ts",
    line: '"review:operator-head-changed",',
  },
];

export interface CodeFacts {
  /** Design table rows in order: steps with their inputs (every input context) and outputs. */
  tableSteps: { key: string; inputs: string[]; produces: string[] }[];
  tableGates: { name: string; signature: string }[];
  /** The walk's consecutive nodes for every track (`gate:<name>` for a gate), then the first
   *  step past the table. */
  walkPairs: string[];
  stages: string[];
  schemaStages: string[];
  stepKeysByStage: Record<string, string[]>;
  advances: string[];
  escalateSignatures: string[];
  waitSignals: string[];
  descriptorKinds: string[];
  invalidateCauses: string[];
  loops: string[];
  signatures: string[];
  runOutcomes: string[];
  pauseReasons: string[];
  failureDecisions: string[];
  resumePlanKinds: string[];
  constants: Record<string, number>;
  handSignatureLinesMissing: string[];
  escalationWrites: Record<string, number>;
}

const raw = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const literals = (s: string) => [...s.matchAll(/"([\w-]+)"/g)].map((m) => m[1] as string);
/** A type alias's string literals: `export type Name = "a" | "b";`. */
function unionOf(text: string, name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(text);
  if (!m) throw new Error(`type ${name} not found`);
  return literals(m[1] as string);
}
/** The `kind:` literals of a union of object types: `export type Name = | { kind: "a" ... } ...;`. */
function kindsOf(text: string, name: string): string[] {
  const start = text.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`type ${name} not found`);
  const end = text.indexOf("\n\n", start); // the alias ends at the first blank line
  return [...text.slice(start, end).matchAll(/kind: "([\w-]+)"/g)].map((m) => m[1] as string);
}
/** `${u.seq}` → `<seq>`, `${check}` → `<check>`; quotes removed. */
const stepKeyOf = (lit: string) =>
  lit.slice(1, -1).replace(/\$\{([^}]*)\}/g, (_, e: string) => `<${e.split(".").pop()}>`);
/** `${...}` → `*`; quotes removed. */
const signatureOf = (lit: string) => lit.slice(1, -1).replace(/\$\{[^}]*\}/g, "*");

/** `const NAME = <number>;` in a source text (for caps a module does not export). */
function constOf(text: string, file: string, name: string): number {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(text);
  if (!m) throw new Error(`${file}: ${name} not found`);
  return Number(m[1]);
}

/** The arguments of every call of `name(` in `text` (not its definition), split at top level
 *  commas: strings, templates and nested brackets are skipped over. */
export function callArgs(text: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`(?<!function )\\b${name}\\(`, "g");
  for (const m of text.matchAll(re)) {
    const args: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let cur = "";
    for (let i = (m.index ?? 0) + m[0].length; i < text.length; i++) {
      const c = text[i] as string;
      if (quote) {
        cur += c;
        if (c === "\\") cur += text[++i] ?? "";
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) {
          if (cur.trim()) args.push(cur.trim());
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(args);
  }
  return out;
}

/** Every place that writes an escalation, per file: calls of `escalate(`, `pauseTicket(` and
 *  `escalateProjection(`, and each `appendEvent(` of an `escalated` event. A new one changes the
 *  count, and the diagram must draw it before its count is updated in the data. */
export const ESCALATION_WRITERS = ["escalate", "pauseTicket", "escalateProjection"];
/** Source text without comments (block, whole line, and trailing after code), so a comment that
 *  names `escalate()` is not counted as a call. */
const withoutComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([;,{}()])\s*\/\/.*$/gm, "$1");
function escalationWritesIn(source: string): number {
  const text = withoutComments(source);
  const calls = ESCALATION_WRITERS.reduce((n, w) => n + callArgs(text, w).length, 0);
  const events = callArgs(text, "appendEvent").filter((a) =>
    a.some((x) => /kind: "escalated"/.test(x)),
  ).length;
  return calls + events;
}

export function codeFacts(
  root: string = REPO,
  table: readonly DesignRow[] = DESIGN_TABLE,
): CodeFacts {
  const resolver = raw(root, "src/daemon/resolver.ts");
  const fnStart = resolver.indexOf("export function nextStepKey(");
  const fn = resolver.slice(fnStart);
  // The stage cases of nextStepKey and the step keys each one serves.
  const cases = [...fn.matchAll(/case "(\w+)": \{/g)].map((m) => ({
    stage: m[1] as string,
    at: m.index,
  }));
  const stepKeysByStage: Record<string, string[]> = {};
  cases.forEach((c, i) => {
    const end = i + 1 < cases.length ? (cases[i + 1]?.at ?? fn.length) : fn.indexOf("default:");
    const block = fn.slice(c.at, end);
    stepKeysByStage[c.stage] = [...block.matchAll(/\bstep\(\s*(`[^`]*`|"[^"]*")/g)].map((m) =>
      stepKeyOf(m[1] as string),
    );
  });
  const steps = table.filter((r) => r.kind === "step");
  const contexts = [{ complexityGrading: false }, { complexityGrading: true }];
  const tableSteps = steps.map((r) => ({
    key: r.stepKey as string,
    inputs: sorted(contexts.flatMap((c) => [...r.inputs(c)])),
    produces: sorted(r.produces),
  }));
  const tableGates = table
    .filter((r) => r.kind === "gate")
    .map((g) => ({ name: g.name as string, signature: g.signature }));
  const node = (r: DesignRow) => (r.kind === "step" ? r.stepKey : `gate:${r.name}`);
  const pastTable = stepKeysByStage.design?.[0];
  const walkPairs = new Set<string>();
  for (const track of [null, "fast", "full"] as const) {
    const chain = table.filter((r) => r.appliesWhen({ track })).map(node);
    if (pastTable) chain.push(pastTable);
    for (let i = 0; i + 1 < chain.length; i++) walkPairs.add(`${chain[i]}>${chain[i + 1]}`);
  }
  const schema = raw(root, "src/db/schema.sql");
  const stageCheck = /stage\s+TEXT NOT NULL CHECK \(stage IN \(([\s\S]*?)\)\)/.exec(schema);
  if (!stageCheck) throw new Error("schema.sql: the ticket.stage CHECK was not found");
  const walk = raw(root, "src/daemon/design-walk.ts");
  const walkFn = walk.slice(walk.indexOf("export function walkDesign("));
  const daemonNames = readdirSync(join(root, "src", "daemon"))
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => join("src", "daemon", f));
  const daemonFiles = daemonNames.map((f) => raw(root, f));
  const escalationWrites: Record<string, number> = {};
  for (const f of [...daemonNames, "src/cli/park.ts"]) {
    const n = escalationWritesIn(raw(root, f));
    if (n > 0) escalationWrites[f] = n;
  }
  // `escalate(db, ticketId, reason, signature, ...)`: a literal fourth argument is a signature.
  const positionalSignatures = daemonFiles.flatMap((t) =>
    callArgs(t, "escalate")
      .map((a) => a[3])
      .filter((a): a is string => a !== undefined && /^[`"]/.test(a))
      .map(signatureOf),
  );
  const loops = daemonFiles.flatMap((t) =>
    [...t.matchAll(/\bloop:\s*"([\w-]+)"/g)].map((m) => m[1] as string),
  );
  const propertySignatures = daemonFiles.flatMap((t) =>
    [...t.matchAll(/\bsignature\s*[:=]\s*(`[^`]*`|"[^"]*")/g)].map((m) =>
      signatureOf(m[1] as string),
    ),
  );
  const handSignatureLinesMissing = HAND_SIGNATURES.filter(
    (h) => !norm(raw(root, h.file)).includes(norm(h.line)),
  ).map((h) => `${h.file}: ${h.line}`);
  const checksVerdict = raw(root, "src/daemon/checks-verdict.ts");
  const reauthorCap = /const REAUTHOR_ESCALATE_CAP = (\d+);/.exec(checksVerdict);
  if (!reauthorCap) throw new Error("checks-verdict.ts: REAUTHOR_ESCALATE_CAP not found");
  const runTicket = raw(root, "src/daemon/run-ticket.ts");
  return {
    tableSteps,
    tableGates,
    walkPairs: sorted(walkPairs),
    stages: cases.map((c) => c.stage),
    schemaStages: literals(stageCheck[1]?.replace(/--[^\n]*/g, "").replace(/'/g, '"') ?? ""),
    stepKeysByStage,
    advances: [...fn.matchAll(/kind: "advance", from: "(\w+)", to: "(\w+)"/g)].map(
      (m) => `${m[1]}>${m[2]}`,
    ),
    escalateSignatures: [
      ...[...fn.matchAll(/kind: "escalate",[\s\S]*?signature: "([^"]+)"/g)].map(
        (m) => m[1] as string,
      ),
      ...tableGates.map((g) => g.signature),
      ...[...walkFn.matchAll(/signature: (`[^`]*`|"[^"]*")/g)].map((m) =>
        signatureOf(m[1] as string),
      ),
    ],
    waitSignals: [...fn.matchAll(/kind: "wait", signalType: "(\w+)"/g)].map((m) => m[1] as string),
    descriptorKinds: kindsOf(resolver, "StepDescriptor"),
    invalidateCauses: unionOf(raw(root, "src/daemon/invalidate.ts"), "InvalidateCause"),
    loops: sorted(loops),
    signatures: sorted([
      ...propertySignatures,
      ...positionalSignatures,
      ...HAND_SIGNATURES.map((h) => h.signature),
    ]),
    runOutcomes: unionOf(runTicket, "RunOutcome"),
    pauseReasons: unionOf(runTicket, "PauseReason"),
    failureDecisions: unionOf(raw(root, "src/daemon/failure-policy.ts"), "FailureDecision"),
    resumePlanKinds: kindsOf(raw(root, "src/daemon/review-resume.ts"), "ReviewResumePlan"),
    constants: {
      DEFAULT_MAX_ATTEMPTS,
      INVALIDATE_LOOP_LIMIT,
      REVIEW_REPAIR_LIMIT,
      GATE_ROUND_CAP,
      REAUTHOR_ESCALATE_CAP: Number(reauthorCap[1]),
      IDLE_CAP: constOf(runTicket, "run-ticket.ts", "IDLE_CAP"),
      DEFAULT_CAP: constOf(runTicket, "run-ticket.ts", "DEFAULT_CAP"),
      OUTBOX_RETRY_BUDGET,
      MAX_TRANSITIONS: constOf(raw(root, "src/daemon/advance.ts"), "advance.ts", "MAX_TRANSITIONS"),
    },
    handSignatureLinesMissing,
    escalationWrites,
  };
}

const DECISION_KIND: Record<string, string> = {
  retry: "retry",
  loopback: "loopback",
  escalated: "escalate",
};

/** The diagram against the code, both directions. */
export function diffAgainstCode(d: Diagram, f: CodeFacts): string[] {
  const out: string[] = [];
  const stateById = new Map(d.states.map((s) => [s.id, s]));
  const ts = d.transitions;
  const defined = <T>(xs: (T | undefined)[]) => xs.filter((x): x is T => x !== undefined);

  // The design table: a state per step (with its inputs and outputs), a state per gate whose
  // escalation carries the gate's signature, the walk's edges for every track, and for every step
  // its `inputs` invalidate and its loop guard.
  const tableNodes = new Set([
    ...f.tableSteps.map((s) => s.key),
    ...f.tableGates.map((g) => `gate:${g.name}`),
  ]);
  for (const row of f.tableSteps) {
    const s = d.states.find((x) => x.stage === "design" && x.stepKey === row.key);
    if (!s) {
      out.push(`design table step '${row.key}' has no state in the diagram`);
      continue;
    }
    if (sorted(s.inputs ?? []).join(",") !== row.inputs.join(","))
      out.push(
        `design step '${row.key}': the diagram's inputs [${sorted(s.inputs ?? [])}] differ from the table's [${row.inputs}]`,
      );
    if (sorted(s.produces ?? []).join(",") !== row.produces.join(","))
      out.push(
        `design step '${row.key}': the diagram's outputs [${sorted(s.produces ?? [])}] differ from the table's [${row.produces}]`,
      );
    if (
      !ts.some(
        (t) => t.from === s.id && t.to === s.id && t.kind === "invalidate" && t.cause === "inputs",
      )
    )
      out.push(`design step '${row.key}' has no 'inputs' invalidate transition`);
    if (
      !ts.some(
        (t) =>
          t.from === s.id && t.to === "esc:invalidate-loop" && t.signature === "invalidate-loop:*",
      )
    )
      out.push(`design step '${row.key}' has no invalidate loop guard transition`);
  }
  for (const s of d.states)
    if (
      s.stage === "design" &&
      s.kind === "step" &&
      !tableNodes.has(s.stepKey ?? "") &&
      !(f.stepKeysByStage.design ?? []).includes(s.stepKey ?? "")
    )
      out.push(
        `design state '${s.id}' is neither a table step nor a step the resolver serves in design`,
      );
  for (const g of f.tableGates) {
    const id = `gate:${g.name}`;
    if (!stateById.has(id)) out.push(`design table gate '${g.name}' has no state '${id}'`);
    else if (!ts.some((t) => t.from === id && t.kind === "escalate" && t.signature === g.signature))
      out.push(`gate '${g.name}' has no escalation with its signature '${g.signature}'`);
  }
  for (const s of d.states)
    if (s.kind === "gate" && !tableNodes.has(s.id))
      out.push(`gate state '${s.id}' is not a gate of the table`);
  const diagramWalk = ts
    .filter((t) => t.kind === "forward" && tableNodes.has(t.from))
    .map((t) => `${t.from}>${t.to}`);
  out.push(...compareSets("design walk edge", f.walkPairs, diagramWalk));
  const first = firstWalkNode(f);
  if (
    first &&
    !ts.some((t) => t.from === "resolve.stage" && t.to === first && t.descriptor === "step")
  )
    out.push(`no transition enters the design walk at its first row '${first}'`);
  for (const t of ts)
    if (t.kind === "invalidate" && t.cause === "inputs" && !tableNodes.has(t.from))
      out.push(
        `transition '${t.id}' invalidates for changed inputs, but '${t.from}' is not a table step`,
      );

  // The resolver: stages, the step keys each stage serves, stage advances, escalations, waits and
  // its descriptor kinds.
  out.push(
    ...compareSets(
      "stage",
      f.stages,
      d.stages.map((s) => s.id),
    ),
  );
  out.push(
    ...compareSets(
      "stage the schema allows but the resolver never serves",
      f.schemaStages.filter((s) => !f.stages.includes(s)),
      d.unroutedStages.map((s) => s.id),
    ),
  );
  const codeSteps: string[] = [];
  for (const [stage, keys] of Object.entries(f.stepKeysByStage))
    for (const k of keys) codeSteps.push(`${stage}|${k}`);
  for (const s of f.tableSteps) codeSteps.push(`design|${s.key}`);
  out.push(
    ...compareSets(
      "step (stage|step key)",
      codeSteps,
      d.states.filter((s) => s.stepKey !== undefined).map((s) => `${s.stage}|${s.stepKey}`),
    ),
  );
  out.push(
    ...compareSets(
      "stage advance",
      f.advances,
      ts
        .filter((t) => t.kind === "advance")
        .map((t) => `${t.stageChange?.from}>${t.stageChange?.to}`),
    ),
  );
  out.push(
    ...compareSets(
      "resolver escalation signature",
      f.escalateSignatures,
      defined(ts.filter((t) => t.descriptor === "escalate").map((t) => t.signature)),
    ),
  );
  for (const w of f.waitSignals)
    if (!ts.some((t) => t.descriptor === "wait" && t.to === `wait:${w}`))
      out.push(`the resolver waits on '${w}', but no transition enters 'wait:${w}'`);
  out.push(
    ...compareSets(
      "resolver descriptor kind",
      f.descriptorKinds,
      defined(ts.map((t) => t.descriptor)),
    ),
  );

  // Values the code declares as literal unions or literals.
  out.push(...compareSets("invalidate cause", f.invalidateCauses, defined(ts.map((t) => t.cause))));
  out.push(...compareSets("event_log loop", f.loops, defined(ts.map((t) => t.loop))));
  out.push(...compareSets("signature", f.signatures, defined(ts.map((t) => t.signature))));
  for (const m of f.handSignatureLinesMissing)
    out.push(`a hand listed signature's line is gone: ${m}`);
  out.push(
    ...compareSets("run outcome", f.runOutcomes, [
      ...defined(d.states.map((s) => s.outcome)),
      ...d.unproducedOutcomes.map((u) => u.id),
    ]),
  );
  out.push(...compareSets("pause reason", f.pauseReasons, defined(d.states.map((s) => s.reason))));
  out.push(
    ...compareSets(
      "failure policy decision",
      f.failureDecisions.map((x) => DECISION_KIND[x] ?? x),
      ts.filter((t) => t.source.file === "src/daemon/failure-policy.ts").map((t) => t.kind),
    ),
  );
  out.push(
    ...compareSets("review resume plan", f.resumePlanKinds, defined(ts.map((t) => t.resumePlan))),
  );
  out.push(
    ...compareSets(
      "cap",
      Object.entries(f.constants).map(([k, v]) => `${k}=${v}`),
      Object.entries(d.constants).map(([k, v]) => `${k}=${v}`),
    ),
  );
  for (const s of d.states)
    if (s.exitName !== undefined && (EXIT as Record<string, number>)[s.exitName] !== s.exitCode)
      out.push(
        `state '${s.id}' says exit ${s.exitCode} (${s.exitName}), but EXIT.${s.exitName} is ${(EXIT as Record<string, number>)[s.exitName]}`,
      );

  // Group membership that follows from the states themselves.
  const steps = d.states.filter((s) => s.kind === "step").map((s) => s.id);
  out.push(...compareSets("member of group 'steps'", steps, d.groups.steps?.members ?? []));
  const escalations = d.states.filter((s) => s.kind === "escalation").map((s) => s.id);
  out.push(
    ...compareSets(
      "member of group 'escalations'",
      escalations,
      d.groups.escalations?.members ?? [],
    ),
  );
  // The interpreter checks the table and the snapshot before every table step, in any stage.
  const tableKeys = new Set(f.tableSteps.map((t) => t.key));
  out.push(
    ...compareSets(
      "member of group 'table-steps'",
      d.states.filter((s) => s.stepKey !== undefined && tableKeys.has(s.stepKey)).map((s) => s.id),
      d.groups["table-steps"]?.members ?? [],
    ),
  );
  // Every place that writes an escalation is accounted for, per file.
  out.push(
    ...compareSets(
      "escalation write sites (file=count)",
      Object.entries(f.escalationWrites).map(([k, v]) => `${k}=${v}`),
      Object.entries(d.escalationWrites ?? {}).map(([k, v]) => `${k}=${v}`),
    ),
  );
  return out;
}

/** Where the walk starts: the node of the walk's edges that no edge enters. */
function firstWalkNode(f: CodeFacts): string | undefined {
  return f.walkPairs
    .map((p) => p.split(">")[0])
    .find((n) => !f.walkPairs.some((p) => p.split(">")[1] === n));
}
