// The checks behind test/docs/state-machine.test.ts: read the state machine data out of
// docs/architecture/state-machine.html, validate it, check that every cited line still exists, and
// compare it with what the code declares. Each check returns one line per difference (empty when
// the two agree), so a failure names exactly what drifted.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
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
  scenarios: {
    id: string;
    label: string;
    summary: string;
    transitions: string[];
    /** The closest other scenario and how this one differs from it. */
    differsFrom: { scenario: string; note: string };
  }[];
  /** Centre of every drawn node: every state but the escalations, and the one Escalated node. */
  layout: Record<string, [number, number]>;
  drawing: Drawing;
  /** The code sites that refuse a start or resume, and that write an escalation (see SITES). */
  refusalSites: DeclaredSite[];
  /** Refusal edges whose code site lies outside the refusal census, with the reason. */
  refusalEdgesOutsideCensus: { edge: string; reason: string }[];
  escalationSites: DeclaredSite[];
}

/** How the page draws the data: the sizes the overlap check uses, the stage lanes and the one
 *  node that stands for every escalation. */
export interface Drawing {
  /** Width and height of a node, by state kind (and `escalated` for the Escalated node). */
  sizes: Record<string, [number, number]>;
  /** The least space between two nodes. */
  gap: number;
  /** The drawing's extent: width and height. */
  canvas: [number, number];
  /** One lane per stage: x, y, width, height. */
  lanes: { stage: string; label: string; box: [number, number, number, number] }[];
  /** Helpers drawn as hubs, with their own width and height (edges meet them at ports spread
   *  around a circle). */
  hubs: Record<string, [number, number]>;
  /** The node that stands for every state of the group (the escalations). */
  escalated: { id: string; label: string; group: string };
}

export interface DeclaredSite {
  file: string;
  /** One line of the code, exactly as written, unique in the file. */
  anchor: string;
  /** The drawn transitions (ids as listed, before group expansion) that go through this site. */
  edges: string[];
  /** Escalation sites: the escalation state the site writes. */
  to?: string;
  /** Set when no edge is drawn for the site, saying why. */
  notDrawn?: string;
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
  }
  out.push(...validateDrawing(d));
  const scenarioIds = new Set(d.scenarios.map((sc) => sc.id));
  for (const sc of d.scenarios) {
    const df = sc.differsFrom;
    if (!df?.scenario || !df.note) out.push(`scenario '${sc.id}' has no differsFrom note`);
    else if (df.scenario === sc.id) out.push(`scenario '${sc.id}' differs from itself`);
    else if (!scenarioIds.has(df.scenario))
      out.push(`scenario '${sc.id}' differs from '${df.scenario}', which is not a scenario`);
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

type Box = [number, number, number, number];
/** Two boxes share some area (touching edges do not count). */
const overlaps = (a: Box, b: Box) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const inside = (a: Box, b: Box) =>
  a[0] >= b[0] && a[1] >= b[1] && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3];

/** The drawing: every state but the escalations has a place, the escalations have none (they are
 *  drawn as the one Escalated node, which has one), no two nodes come closer than the gap, every
 *  state of a stage sits inside that stage's lane, every other state outside all lanes, and
 *  everything inside the canvas. */
export function validateDrawing(d: Diagram): string[] {
  const out: string[] = [];
  const g = d.drawing;
  if (!g) return ["the data has no drawing section"];
  const esc = g.escalated;
  const stateIds = new Set(d.states.map((s) => s.id));
  const finite = (p: unknown) =>
    Array.isArray(p) && p.length === 2 && p.every((x) => Number.isFinite(x));
  const nodes: { id: string; kind: string; stage?: string }[] = [];
  for (const s of d.states) {
    const p = d.layout[s.id];
    if (s.kind === "escalation") {
      if (p !== undefined)
        out.push(
          `escalation state '${s.id}' has a layout position; escalations are drawn as the one Escalated node`,
        );
      if (!d.groups[esc.group]?.members.includes(s.id))
        out.push(
          `escalation state '${s.id}' is not in the group '${esc.group}' the Escalated node draws`,
        );
      continue;
    }
    if (!finite(p)) out.push(`state '${s.id}' has no layout position`);
    else nodes.push({ id: s.id, kind: s.kind, stage: s.stage });
  }
  if (stateIds.has(esc.id)) out.push(`the Escalated node's id '${esc.id}' is also a state`);
  if (!finite(d.layout[esc.id])) out.push(`the Escalated node '${esc.id}' has no layout position`);
  else nodes.push({ id: esc.id, kind: "escalated" });
  for (const id of Object.keys(d.layout))
    if (!stateIds.has(id) && id !== esc.id) out.push(`layout names '${id}', which is not a state`);
  const box = (n: { id: string; kind: string }, pad: number): Box | undefined => {
    const size = g.hubs?.[n.id] ?? g.sizes[n.kind];
    const p = d.layout[n.id] as [number, number];
    if (!size) return undefined;
    return [
      p[0] - size[0] / 2 - pad,
      p[1] - size[1] / 2 - pad,
      size[0] + 2 * pad,
      size[1] + 2 * pad,
    ];
  };
  const placed: { id: string; stage?: string; box: Box; padded: Box }[] = [];
  for (const n of nodes) {
    const b = box(n, 0);
    const padded = box(n, g.gap / 2);
    if (!b || !padded) out.push(`state '${n.id}' has kind '${n.kind}', which has no drawn size`);
    else placed.push({ id: n.id, stage: n.stage, box: b, padded });
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i] as (typeof placed)[number];
      const b = placed[j] as (typeof placed)[number];
      if (overlaps(a.padded, b.padded)) {
        const [x, y] = [a.id, b.id].sort();
        out.push(`drawn nodes '${x}' and '${y}' overlap`);
      }
    }
  const laneOf = new Map(g.lanes.map((l) => [l.stage, l]));
  const stages = new Set(d.stages.map((s) => s.id));
  for (const s of stages) if (!laneOf.has(s)) out.push(`stage '${s}' has no lane`);
  for (const l of g.lanes) if (!stages.has(l.stage)) out.push(`lane '${l.stage}' names no stage`);
  for (let i = 0; i < g.lanes.length; i++)
    for (let j = i + 1; j < g.lanes.length; j++) {
      const a = g.lanes[i] as Drawing["lanes"][number];
      const b = g.lanes[j] as Drawing["lanes"][number];
      if (overlaps(a.box, b.box)) out.push(`lanes '${a.stage}' and '${b.stage}' overlap`);
    }
  const canvas: Box = [0, 0, g.canvas[0], g.canvas[1]];
  for (const l of g.lanes)
    if (!inside(l.box, canvas)) out.push(`lane '${l.stage}' lies outside the canvas`);
  for (const p of placed) {
    if (!inside(p.box, canvas)) out.push(`drawn node '${p.id}' lies outside the canvas`);
    if (p.stage !== undefined) {
      const lane = laneOf.get(p.stage);
      if (!lane || !inside(p.box, lane.box))
        out.push(`state '${p.id}' (stage ${p.stage}) is not inside its lane`);
    } else
      for (const l of g.lanes)
        if (overlaps(p.box, l.box))
          out.push(`state '${p.id}' has no stage but sits in the ${l.stage} lane`);
  }
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
  return out;
}

/** Where the walk starts: the node of the walk's edges that no edge enters. */
function firstWalkNode(f: CodeFacts): string | undefined {
  return f.walkPairs
    .map((p) => p.split(">")[0])
    .find((n) => !f.walkPairs.some((p) => p.split(">")[1] === n));
}

// ------------------------------------------------------------------------------------------------
// Sites: every line of code that refuses a start or resume, and every line that writes an
// escalation, must be declared in the data with the drawn transitions that go through it. A new
// site, a deleted transition, or a refusal whose exit code changed fails here, by name.

/** Where refusals of a start or resume live: `styre run`, the resume, and the helpers they call
 *  before the first step (hand listed; whole files, or the named top level functions). */
export const REFUSAL_SCOPE: { file: string; functions?: string[] }[] = [
  { file: "src/cli/run.ts" },
  { file: "src/cli/park.ts" },
  { file: "src/cli/load-profile.ts" },
  { file: "src/cli/checkpoint-name.ts" },
  { file: "src/cli/resolve-pr-base.ts" },
  { file: "src/cli/preflight.ts", functions: ["applyToolchainGate"] },
  { file: "src/config/discover.ts" },
  { file: "src/config/parse-config.ts", functions: ["parseConfigOrThrow"] },
  { file: "src/config/slug.ts", functions: ["discoverRepoRoot"] },
  { file: "src/dispatch/profile.ts", functions: ["parseProfile", "loadProfile"] },
  { file: "src/dispatch/test-target.ts", functions: ["assertTestTargets"] },
  { file: "src/dispatch/in-place.ts" },
  { file: "src/dispatch/worktree.ts", functions: ["reconcileWorktree"] },
  { file: "src/integrations/notifier.ts", functions: ["assertSlackConfigured"] },
  { file: "src/db/migrate.ts", functions: ["migrate", "refused"] },
];
/** Helpers that build a refusal; each one's exit codes are read from its definition. */
const REFUSAL_HELPERS: Record<string, string> = {
  usageError: "src/cli/errors.ts",
  configError: "src/cli/errors.ts",
  agentCliError: "src/cli/errors.ts",
  toolchainError: "src/cli/errors.ts",
  noPrimaryComponentError: "src/cli/errors.ts",
  noOwnTicket: "src/cli/park.ts",
};
const ESCALATION_WRITERS = ["escalate", "pauseTicket", "escalateProjection"];

/** The two starts, by the function each one runs in. */
export type Entry = "run" | "resume";
const RUN_ENTRY = { file: "src/cli/run.ts", fn: "runImpl" };
const RESUME_ENTRY = { file: "src/cli/park.ts", fn: "resumeRun" };

// What each character of a source text is (code, inside a literal, inside a comment), read with
// TypeScript's own parser: it tells a regular expression from a division, so a "/*" or "//" inside
// a string, a template or a regular expression is never taken for a comment, and a bracket inside
// one never counts.
const CODE = 0;
const LITERAL = 1;
const COMMENT = 2;
const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);
const isJSDoc = (n: ts.Node) =>
  n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
const lexCache = new Map<string, Uint8Array>();

/** Code, literal or comment, per character. A template's `${` and `}` count as literal, the
 *  substitution between them as code. */
function lex(text: string): Uint8Array {
  const hit = lexCache.get(text);
  if (hit) return hit;
  const kind = new Uint8Array(text.length);
  const sf = ts.createSourceFile(
    "census.ts",
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  // Returns nothing: a truthy return would stop TypeScript's comment iteration early.
  const mark = (from: number, to: number, k: number): void => {
    kind.fill(k, from, to);
  };
  // Every comment sits in the trivia before some token (the end of file token included): on the
  // token's own line it is a trailing comment of the token before, after a line break a leading one.
  const comments = (pos: number) => {
    ts.forEachLeadingCommentRange(text, pos, (from, to) => mark(from, to, COMMENT));
    ts.forEachTrailingCommentRange(text, pos, (from, to) => mark(from, to, COMMENT));
  };
  const visit = (node: ts.Node): void => {
    const kids = node.getChildren(sf).filter((k) => !isJSDoc(k));
    if (kids.length === 0) {
      comments(node.pos);
      if (LITERAL_KINDS.has(node.kind)) mark(node.getStart(sf), node.end, LITERAL);
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);
  lexCache.set(text, kind);
  return kind;
}

/** Comments blanked to spaces (strings, templates and regular expressions kept), so line numbers
 *  stay and a comment naming a call is not a call. */
export function blankComments(text: string): string {
  const kind = lex(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    out += kind[i] === COMMENT && c !== "\n" ? " " : c;
  }
  return out;
}

/** A source file as the census reads it: comments blanked, with its lines and top level
 *  functions. */
interface Model {
  file: string;
  text: string;
  kind: Uint8Array;
  lines: string[];
  lineStart: number[];
  fns: { name: string; start: number; end: number }[];
}
type Models = Map<string, Model>;

function model(root: string, file: string, cache: Models): Model {
  const hit = cache.get(file);
  if (hit) return hit;
  const text = blankComments(raw(root, file));
  const lines = text.split("\n");
  const lineStart: number[] = [];
  let at = 0;
  for (const l of lines) {
    lineStart.push(at);
    at += l.length + 1;
  }
  const fns: Model["fns"] = [];
  lines.forEach((l, i) => {
    const m = /^(?:export )?(?:async )?function\*?\s*(\w+)/.exec(l);
    if (!m) return;
    let end = i;
    while (end < lines.length && lines[end] !== "}") end++;
    fns.push({ name: m[1] as string, start: i, end });
  });
  const made = { file, text, kind: lex(text), lines, lineStart, fns };
  cache.set(file, made);
  return made;
}

function lineAt(m: Model, index: number): number {
  let lo = 0;
  let hi = m.lineStart.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((m.lineStart[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The index of the bracket that closes the one at `open` (code characters only), or -1. */
function closing(m: Model, open: number): number {
  let depth = 0;
  for (let i = open; i < m.text.length; i++) {
    if (m.kind[i] !== CODE) continue;
    const c = m.text[i] as string;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** The index of the `{` of the innermost block around `index`, or -1 at top level. */
function enclosingBlock(m: Model, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (m.kind[i] !== CODE) continue;
    if (m.text[i] === "}") depth++;
    else if (m.text[i] === "{" && depth-- === 0) return i;
  }
  return -1;
}

/** Code matches of `re` in the file (a match that starts in a string or comment is not code). */
function codeMatches(m: Model, re: RegExp): RegExpExecArray[] {
  return [...m.text.matchAll(re)].filter((x) => m.kind[x.index ?? 0] === CODE) as RegExpExecArray[];
}

/** Top level function ranges [first line, last line] by name. */
function functionRanges(m: Model, names: string[]): [number, number][] {
  return names.map((name) => {
    const f = m.fns.find((x) => x.name === name);
    if (!f) throw new Error(`${m.file}: function ${name} not found`);
    return [f.start, f.end];
  });
}

export interface CodeSite {
  file: string;
  /** The line the call or assignment starts on (0 based). */
  line: number;
  /** The lines a declared anchor may sit on: the call's arguments (an escalation's whole
   *  transaction when it writes inside one; an exit code assignment's whole block), and the line
   *  opening the block the call starts. */
  span: [number, number];
  what: string;
  codes: number[];
  /** The starts that reach a refusal site (refusal sites only). */
  entries?: Entry[];
}

/** A site's span: from `start` to `end` (indexes), widened to the enclosing `transaction(` call
 *  when `inTransaction`, then up to a block opener directly above it (blank lines between are
 *  padding). */
function spanOf(m: Model, start: number, end: number, inTransaction = false): [number, number] {
  let [a, b] = [start, end];
  if (inTransaction) {
    let best: [number, number] | null = null;
    for (const t of codeMatches(m, /\btransaction\(/g)) {
      const open = (t.index ?? 0) + t[0].length - 1;
      const close = closing(m, open);
      if ((t.index ?? 0) < start && close > end && (!best || (t.index ?? 0) > best[0]))
        best = [t.index ?? 0, close];
    }
    if (best) [a, b] = best;
  }
  let first = lineAt(m, a);
  let p = first - 1;
  while (p >= 0 && (m.lines[p] as string).trim() === "") p--;
  if (p >= 0 && (m.lines[p] as string).trimEnd().endsWith("{")) first = p;
  return [first, lineAt(m, b)];
}

const EXIT_CODES = EXIT as Record<string, number>;
function exitCodesIn(text: string): number[] {
  return sorted(
    [...text.matchAll(/EXIT\.(\w+)/g)].map((m) => String(EXIT_CODES[m[1] as string])),
  ).map(Number);
}

/** Every error class declared in src: the exit codes a throw of it maps to. A class that extends
 *  StyreError exits with the code its constructor gives; any other error is an internal error
 *  (the error boundary's rule, src/cli/output.ts). */
function errorClasses(root: string): Map<string, number[]> {
  const decl = new Map<string, { base: string; code?: string }>();
  const files = (readdirSync(join(root, "src"), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .sort();
  for (const f of files) {
    const text = blankComments(readFileSync(join(root, "src", f), "utf8"));
    for (const m of text.matchAll(/\bclass (\w+) extends (\w+)/g)) {
      const body = text.slice(m.index ?? 0, text.indexOf("\n}", m.index ?? 0));
      decl.set(m[1] as string, { base: m[2] as string, code: /code: EXIT\.(\w+)/.exec(body)?.[1] });
    }
  }
  const resolve = (name: string, seen: Set<string>): { styre: boolean; code?: string } | null => {
    if (name === "Error") return { styre: false };
    if (name === "StyreError") return { styre: true };
    const c = decl.get(name);
    if (!c || seen.has(name)) return null;
    const base = resolve(c.base, new Set([...seen, name]));
    if (!base) return null;
    return base.styre ? { styre: true, code: c.code ?? base.code } : base;
  };
  const out = new Map<string, number[]>();
  for (const name of decl.keys()) {
    const r = resolve(name, new Set());
    if (!r) continue;
    if (!r.styre) out.set(name, [EXIT.INTERNAL]);
    else out.set(name, r.code ? [EXIT_CODES[r.code] as number] : []);
  }
  return out;
}

/** The conditions of the `if` statements around `index` in the function starting at `from`, each
 *  with the line its `if` is on. */
function enclosingConditions(
  m: Model,
  from: number,
  index: number,
): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (const x of codeMatches(m, /\bif\s*\(/g)) {
    const at = x.index ?? 0;
    if (at < from || at >= index) continue;
    const open = at + x[0].length - 1;
    const close = closing(m, open);
    if (close < 0 || close >= index) continue;
    let body = close + 1;
    while (/\s/.test(m.text[body] as string)) body++;
    let end: number;
    if (m.text[body] === "{") end = closing(m, body);
    else {
      end = body;
      let depth = 0;
      for (; end < m.text.length; end++) {
        if (m.kind[end] !== CODE) continue;
        const c = m.text[end] as string;
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (c === ";" && depth === 0) break;
      }
    }
    if (index > close && index <= end)
      out.push({ text: m.text.slice(open + 1, close), line: lineAt(m, at) });
  }
  return out;
}

/** The conjuncts of a condition that the census can read as a guard on `--resume`. */
const FRESH_ONLY = ["!args.resume", "!(args.resume && args.resume.length > 0)"];
const RESUME_ONLY = ["args.resume", "args.resume.length > 0"];

/** What an `if` condition says about `--resume`: nothing, fresh runs only, or resumes only. Only
 *  a condition made of `&&` conjuncts, each either free of `args.resume` or one of the exact
 *  shapes above, is read; any other condition that mentions `args.resume` (an `||`, a `?`, a
 *  shape not listed) makes the census throw, naming the line, rather than guess. */
function resumeGuard(file: string, c: { text: string; line: number }): "none" | "run" | "resume" {
  if (!/\bargs\.resume\b/.test(c.text)) return "none";
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let readable = true;
  for (let i = 0; i < c.text.length; i++) {
    const ch = c.text[i] as string;
    const two = c.text.slice(i, i + 2);
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (depth === 0 && two === "&&") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (depth === 0 && (two === "||" || two === "??" || ch === "?")) readable = false;
    cur += ch;
  }
  parts.push(cur);
  const kinds = new Set<string>();
  for (const part of parts.map((p) => p.replace(/\s+/g, " ").trim())) {
    if (!/\bargs\.resume\b/.test(part)) continue;
    if (FRESH_ONLY.includes(part)) kinds.add("run");
    else if (RESUME_ONLY.includes(part)) kinds.add("resume");
    else readable = false;
  }
  if (!readable || kinds.size !== 1)
    throw new Error(
      `refusal census: ${file}:${c.line + 1}: an if around a refusal reads args.resume in a shape the census cannot read: ${c.text.replace(/\s+/g, " ").trim()}`,
    );
  return kinds.has("run") ? "run" : "resume";
}

/** A call at `index` whose error a `try` around it swallows (its `catch` does not throw the
 *  caught error on) cannot refuse a start. */
function caught(m: Model, index: number): boolean {
  const tries = codeMatches(m, /\btry\s*\{/g)
    .map((x) => {
      const open = (x.index ?? 0) + x[0].length - 1;
      return { open, close: closing(m, open) };
    })
    .filter((t) => t.open < index && t.close > index)
    .sort((a, b) => b.open - a.open);
  for (const t of tries) {
    const after = m.text.slice(t.close + 1);
    const c = /^\s*catch\s*(?:\(\s*(\w+)[^)]*\))?\s*\{/.exec(after);
    if (!c) continue; // try/finally: the error goes on
    const bodyOpen = t.close + 1 + c[0].length - 1;
    const body = m.text.slice(bodyOpen, closing(m, bodyOpen));
    if (!c[1] || !new RegExp(`\\bthrow\\s+${c[1]}\\b`).test(body)) return true;
  }
  return false;
}

/** The starts that reach the code at `index` of `file`. In `resumeRun`: a resume. In `runImpl`: a
 *  fresh run, and a resume too when the site comes before `runImpl` hands over to `resumeRun` and
 *  no `if` around it excludes `--resume`. In any other function: whatever reaches the calls of that
 *  function in the refusal scope's files, except calls whose error a `try` swallows. A site no start
 *  reaches is an error of the census. */
function entriesAt(
  root: string,
  cache: Models,
  file: string,
  index: number,
  seen: string[] = [],
): Set<Entry> {
  const m = model(root, file, cache);
  const line = lineAt(m, index);
  const fn = m.fns.find((f) => line >= f.start && line <= f.end);
  if (!fn) throw new Error(`refusal census: ${file}:${line + 1} is outside any top level function`);
  if (file === RESUME_ENTRY.file && fn.name === RESUME_ENTRY.fn) return new Set(["resume"]);
  if (file === RUN_ENTRY.file && fn.name === RUN_ENTRY.fn) {
    const from = m.lineStart[fn.start] as number;
    const handOver = codeMatches(m, /\bawait resumeRun\(/g).find(
      (x) => lineAt(m, x.index ?? 0) <= fn.end && (x.index ?? 0) > from,
    );
    if (!handOver) throw new Error(`refusal census: ${file}: runImpl no longer calls resumeRun`);
    if (index > (handOver.index ?? 0)) return new Set(["run"]);
    const guards = enclosingConditions(m, from, index).map((c) => resumeGuard(file, c));
    if (guards.includes("run") && guards.includes("resume"))
      throw new Error(`refusal census: ${file}:${line + 1}: guarded both for and against --resume`);
    if (guards.includes("run")) return new Set(["run"]);
    if (guards.includes("resume")) return new Set(["resume"]);
    return new Set(["run", "resume"]);
  }
  const key = `${file}#${fn.name}`;
  if (seen.includes(key)) return new Set();
  const found = new Set<Entry>();
  let calls = 0;
  const call = new RegExp(`(?<![\\w$.])(?<!function )\\b${fn.name}\\(`, "g");
  for (const f of sorted(REFUSAL_SCOPE.map((s) => s.file))) {
    const caller = model(root, f, cache);
    for (const x of codeMatches(caller, call)) {
      calls++;
      if (caught(caller, x.index ?? 0)) continue;
      for (const e of entriesAt(root, cache, f, x.index ?? 0, [...seen, key])) found.add(e);
    }
  }
  // A function nothing in the scope's files calls is on no start's path (ensureWorktree, say, runs
  // inside the provision step): it adds no start.
  return calls === 0 ? new Set() : found;
}

/** The refusal sites of the scope, each with the exit codes it can produce and the starts that
 *  reach it. */
export function refusalSitesIn(root: string = REPO): CodeSite[] {
  const cache: Models = new Map();
  const helperCodes: Record<string, number[]> = {};
  for (const [h, f] of Object.entries(REFUSAL_HELPERS)) {
    const m = model(root, f, cache);
    const [a, b] = functionRanges(m, [h])[0] as [number, number];
    helperCodes[h] = exitCodesIn(m.lines.slice(a, b + 1).join("\n"));
  }
  const classes = errorClasses(root);
  const out: CodeSite[] = [];
  for (const scope of REFUSAL_SCOPE) {
    const m = model(root, scope.file, cache);
    const ranges = scope.functions
      ? functionRanges(m, scope.functions)
      : [[0, m.lines.length - 1] as [number, number]];
    const add = (start: number, end: number, what: string, codes: number[]) => {
      const line = lineAt(m, start);
      if (!ranges.some(([a, b]) => line >= a && line <= b)) return;
      const entries = [...entriesAt(root, cache, scope.file, start)].sort();
      if (entries.length === 0)
        throw new Error(
          `refusal census: no start reaches ${scope.file}:${line + 1} (${what}); is it on a start's path?`,
        );
      out.push({
        file: scope.file,
        line,
        span: spanOf(m, start, end),
        what,
        codes,
        entries,
      });
    };
    const callEnd = (x: RegExpExecArray) => closing(m, (x.index ?? 0) + x[0].length - 1);
    const helperCall = new RegExp(
      `(?<![\\w$.])(?<!function )(${Object.keys(REFUSAL_HELPERS).join("|")})\\(`,
      "g",
    );
    for (const x of codeMatches(m, helperCall))
      add(x.index ?? 0, callEnd(x), x[1] as string, helperCodes[x[1] as string] ?? []);
    for (const x of codeMatches(m, /\bnew StyreError\(/g)) {
      const end = callEnd(x);
      const code = /code:\s*EXIT\.\w+/.exec(m.text.slice(x.index ?? 0, end))?.[0] ?? "";
      add(x.index ?? 0, end, "new StyreError", exitCodesIn(code));
    }
    // An exit code assignment refuses together with the message written beside it: its span is
    // the block that holds it.
    for (const x of codeMatches(m, /\bprocess\.exitCode\s*=\s*(?:(\d+)|EXIT\.(\w+))/g)) {
      const at = x.index ?? 0;
      const block = enclosingBlock(m, at);
      const code = x[1] !== undefined ? Number(x[1]) : (EXIT_CODES[x[2] as string] as number);
      const before = out.length;
      add(
        block < 0 ? at : block,
        block < 0 ? at + x[0].length : closing(m, block),
        "process.exitCode",
        [code],
      );
      const site = out[before];
      if (site) site.line = lineAt(m, at);
    }
    for (const x of codeMatches(m, /\bthrow new (\w*Error)\(/g)) {
      const name = x[1] as string;
      if (name === "StyreError") continue; // counted as `new StyreError` above
      const codes = name === "Error" ? [EXIT.INTERNAL] : classes.get(name);
      if (!codes)
        throw new Error(
          `refusal census: ${scope.file}:${lineAt(m, x.index ?? 0) + 1} throws ${name}, an error class src does not declare`,
        );
      add(x.index ?? 0, callEnd(x), `throw new ${name}`, codes);
    }
  }
  return out;
}

/** The escalation write sites of src/daemon and the resume: calls of escalate, pauseTicket and
 *  escalateProjection, and appendEvent of an escalated event, outside those three definitions. */
export function escalationSitesIn(root: string = REPO): CodeSite[] {
  const files = [
    ...readdirSync(join(root, "src", "daemon"))
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => join("src", "daemon", f)),
    "src/cli/park.ts",
  ];
  const cache: Models = new Map();
  const out: CodeSite[] = [];
  for (const file of files) {
    const m = model(root, file, cache);
    const defs = ESCALATION_WRITERS.flatMap((w) =>
      m.fns.some((f) => f.name === w) ? functionRanges(m, [w]) : [],
    );
    const inDef = (line: number) => defs.some(([a, b]) => line >= a && line <= b);
    const site = (x: RegExpExecArray, what: string) => {
      const start = x.index ?? 0;
      const end = closing(m, start + x[0].length - 1);
      return { file, line: lineAt(m, start), span: spanOf(m, start, end, true), what, codes: [] };
    };
    for (const w of ESCALATION_WRITERS)
      for (const x of codeMatches(m, new RegExp(`(?<![\\w$.])(?<!function )\\b${w}\\(`, "g")))
        if (!inDef(lineAt(m, x.index ?? 0))) out.push(site(x, w));
    for (const x of codeMatches(m, /\bappendEvent\(/g)) {
      if (inDef(lineAt(m, x.index ?? 0))) continue;
      const call = callArgs(m.text.slice(x.index ?? 0), "appendEvent")[0] ?? [];
      if (call.some((a) => /kind: "escalated"/.test(a)))
        out.push(site(x, "appendEvent(escalated)"));
    }
  }
  return out;
}

/** The line of `anchor` in `file`, which must hold it exactly once. */
function anchorLine(root: string, file: string, anchor: string): number | string {
  const lines = raw(root, file).split("\n");
  const at = lines.flatMap((l, i) => (l.includes(anchor) ? [i] : []));
  if (at.length === 0) return `not found in ${file}`;
  if (at.length > 1) return `found ${at.length} times in ${file}; make it unique`;
  return at[0] as number;
}

/** Declared sites against code sites: each code site matched by exactly one declared site (the
 *  declared anchor inside the code site's span; the narrowest span first), each declared site
 *  matching one code site, and every listed edge existing. */
function matchSites(
  kind: string,
  declared: DeclaredSite[],
  code: CodeSite[],
  root: string,
): { lines: string[]; pairs: { site: DeclaredSite; code: CodeSite; at: number }[] } {
  const lines: string[] = [];
  const pairs: { site: DeclaredSite; code: CodeSite; at: number }[] = [];
  const taken = new Set<CodeSite>();
  for (const site of declared) {
    const at = anchorLine(root, site.file, site.anchor);
    if (typeof at === "string") {
      lines.push(`${kind} site '${site.anchor}': ${at}`);
      continue;
    }
    const near = code
      .filter((c) => c.file === site.file && !taken.has(c) && at >= c.span[0] && at <= c.span[1])
      .sort(
        (x, y) =>
          x.span[1] - x.span[0] - (y.span[1] - y.span[0]) ||
          Math.abs(x.line - at) - Math.abs(y.line - at),
      )[0];
    if (!near) {
      lines.push(
        `${kind} site '${site.anchor}' (${site.file}:${at + 1}) matches no ${kind} in the code`,
      );
      continue;
    }
    taken.add(near);
    pairs.push({ site, code: near, at });
  }
  for (const c of code)
    if (!taken.has(c))
      lines.push(`${kind} in the code is not drawn: ${c.file}:${c.line + 1} (${c.what})`);
  return { lines, pairs };
}

const isStart = (t: DiagramTransition) =>
  t.kind === "refuse" && ["run.start", "resume.start", "@starts"].includes(t.from);
/** The starts a refusal edge leaves from. */
const startsOf = (t: DiagramTransition | undefined): Entry[] =>
  t?.from === "run.start"
    ? ["run"]
    : t?.from === "resume.start"
      ? ["resume"]
      : t?.from === "@starts"
        ? ["run", "resume"]
        : [];
const ENTRY_WORDS: Record<Entry, string> = { run: "a fresh run", resume: "a resume" };

/** Every refusal and escalation site in the code is declared with the transitions drawn through
 *  it; a refusal site's exit codes equal those of its transitions' targets, and it lists an edge
 *  from every start that reaches it; every refusal edge of a start and every edge into an
 *  escalation is listed at some site. */
export function checkSites(d: Diagram, root: string = REPO): string[] {
  const out: string[] = [];
  const byId = new Map(d.transitions.map((t) => [t.id, t]));
  const stateById = new Map(d.states.map((s) => [s.id, s]));
  const listed = (sites: DeclaredSite[]) => new Set(sites.flatMap((s) => s.edges));
  const refusal = matchSites("refusal", d.refusalSites ?? [], refusalSitesIn(root), root);
  out.push(...refusal.lines);
  const reachedFrom = new Map<string, Set<Entry>>();
  for (const { site, code, at } of refusal.pairs) {
    if (site.edges.length === 0) {
      if (!site.notDrawn) out.push(`refusal site '${site.anchor}' lists no edge and no reason`);
      continue;
    }
    const codes = new Set<number>();
    for (const id of site.edges) {
      const t = byId.get(id);
      if (!t) {
        out.push(`refusal site '${site.anchor}' lists '${id}', which is not a transition`);
        continue;
      }
      const exit = stateById.get(t.to)?.exitCode;
      if (exit === undefined)
        out.push(`refusal site '${site.anchor}': '${id}' does not end at an exit`);
      else codes.add(exit);
    }
    const want = code.codes.join(",");
    const have = sorted([...codes].map(String))
      .map(Number)
      .join(",");
    if (want !== have)
      out.push(
        `refusal site ${site.file}:${code.line + 1} (${code.what}) exits ${want} in the code, but its drawn edges (${site.edges.join(", ")}) exit ${have}`,
      );
    // Per start: every start that reaches the site has an edge here, and an edge from one start
    // only is listed where that start reaches.
    const where = `refusal site '${site.anchor}' (${site.file}:${at + 1})`;
    const entries = new Set(code.entries ?? []);
    for (const e of entries)
      if (!site.edges.some((id) => startsOf(byId.get(id)).includes(e)))
        out.push(
          `${where} is reached from ${ENTRY_WORDS[e]}, but lists no edge from ${e}.start or @starts`,
        );
    for (const id of site.edges) {
      const t = byId.get(id);
      const from = startsOf(t);
      if (from.length === 1 && !entries.has(from[0] as Entry))
        out.push(
          `${where} lists '${id}' from ${t?.from}, but ${ENTRY_WORDS[from[0] as Entry]} never reaches it`,
        );
      const r = reachedFrom.get(id) ?? new Set<Entry>();
      for (const e of entries) r.add(e);
      reachedFrom.set(id, r);
    }
  }
  for (const [id, r] of reachedFrom)
    if (byId.get(id)?.from === "@starts" && r.size < 2)
      out.push(
        `refusal edge '${id}' leaves both starts, but only ${[...r].map((e) => ENTRY_WORDS[e]).join(" and ") || "no start"} reaches the sites that list it`,
      );
  const outside = new Set((d.refusalEdgesOutsideCensus ?? []).map((x) => x.edge));
  for (const x of d.refusalEdgesOutsideCensus ?? [])
    if (!byId.has(x.edge))
      out.push(`refusalEdgesOutsideCensus lists '${x.edge}', which is not a transition`);
  const refusalListed = listed(d.refusalSites ?? []);
  for (const t of d.transitions)
    if (isStart(t) && !refusalListed.has(t.id) && !outside.has(t.id))
      out.push(`refusal edge '${t.id}' is listed at no refusal site`);
  const escalation = matchSites(
    "escalation",
    d.escalationSites ?? [],
    escalationSitesIn(root),
    root,
  );
  out.push(...escalation.lines);
  for (const site of d.escalationSites ?? []) {
    if (site.edges.length === 0 && !site.notDrawn)
      out.push(`escalation site '${site.anchor}' lists no edge and no reason`);
    for (const id of site.edges) {
      const t = byId.get(id);
      if (!t) out.push(`escalation site '${site.anchor}' lists '${id}', which is not a transition`);
      else if (site.to && t.to !== site.to)
        out.push(
          `escalation site '${site.anchor}' writes '${site.to}', but '${id}' ends at '${t.to}'`,
        );
    }
  }
  const escalationListed = listed(d.escalationSites ?? []);
  for (const t of d.transitions)
    if (t.to.startsWith("esc:") && !escalationListed.has(t.id))
      out.push(`escalation edge '${t.id}' is listed at no escalation site`);
  return out;
}
