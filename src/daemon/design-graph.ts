import { EXIT, StyreError } from "../cli/errors.ts";
import type { TicketRow } from "../db/repos/ticket.ts";

/** Inputs Styre hands a design step that are not rows of an earlier step (spec §4). */
export const SNAPSHOT_INPUT_NAMES = [
  "ticket.ident",
  "ticket.title",
  "ticket.description",
  "profile.slug",
  "profile.promptVars",
  "profile.runtimeContext",
  "profile.components",
  "run.unusableComponents",
  "run.nonPrimaryComponents",
  "config.complexityGrading",
] as const;
export type SnapshotInputName = (typeof SNAPSHOT_INPUT_NAMES)[number];

/** Fixed for the life of a run (E2): written once, never rewritten. */
export const TICKET_TEXT_INPUTS: readonly SnapshotInputName[] = [
  "ticket.ident",
  "ticket.title",
  "ticket.description",
];

export type OutputName = "plan" | "workUnits" | "track" | "planFindings";
export type InputName = SnapshotInputName | OutputName;
export type DesignStepKey =
  | "provision"
  | "design:dispatch"
  | "design:extract"
  | "design:size"
  | "design:review";

export interface InputContext {
  complexityGrading: boolean;
}

export interface StepRow {
  kind: "step";
  stepKey: DesignStepKey;
  stepType: string;
  handlerKey: string;
  appliesWhen: (t: Pick<TicketRow, "track">) => boolean;
  /** What Styre hands the step, plus the upstream outputs it reads. */
  inputs: (c: InputContext) => readonly InputName[];
  /** Routed backwards on a loopback event; never fingerprinted (spec §6.7). */
  feedback: readonly string[];
  produces: readonly OutputName[];
  /** True when the output lives outside the database (the plan), so its digest is recorded. */
  fileOutput: boolean;
}

export interface GateRow {
  kind: "gate";
  name: "plan-review";
  appliesWhen: (t: Pick<TicketRow, "track">) => boolean;
  reads: readonly OutputName[];
  reason: string;
  signature: string;
  stepKey: DesignStepKey;
}

export type DesignRow = StepRow | GateRow;

const always = (): boolean => true;
const fullTrack = (t: Pick<TicketRow, "track">): boolean => t.track === "full";

/** The design stage, in order (spec §3). The resolver's design routing is generated from it. After
 *  its last row the resolver continues with today's checks routing, unchanged (E9). */
export const DESIGN_TABLE: readonly DesignRow[] = [
  {
    kind: "step",
    stepKey: "provision",
    stepType: "provision",
    handlerKey: "provision",
    appliesWhen: always,
    inputs: () => ["profile.components", "run.unusableComponents", "run.nonPrimaryComponents"],
    feedback: [],
    produces: [],
    fileOutput: false,
  },
  {
    kind: "step",
    stepKey: "design:dispatch",
    stepType: "dispatch",
    handlerKey: "design:dispatch",
    appliesWhen: always,
    inputs: () => [
      "ticket.title",
      "ticket.description",
      "profile.slug",
      "profile.promptVars",
      "profile.runtimeContext",
      "profile.components",
    ],
    feedback: ["design loopback findings"],
    produces: ["plan"],
    fileOutput: true,
  },
  {
    kind: "step",
    stepKey: "design:extract",
    stepType: "dispatch",
    handlerKey: "design:extract",
    appliesWhen: always,
    inputs: () => [
      "ticket.ident",
      "ticket.title",
      "profile.slug",
      "profile.promptVars",
      "profile.runtimeContext",
      "profile.components",
      "plan",
    ],
    feedback: [],
    produces: ["workUnits"],
    fileOutput: false,
  },
  {
    kind: "step",
    stepKey: "design:size",
    stepType: "dispatch",
    handlerKey: "design:size",
    appliesWhen: always,
    inputs: (c) =>
      c.complexityGrading
        ? [
            "config.complexityGrading",
            "workUnits",
            "ticket.title",
            "profile.slug",
            "profile.promptVars",
            "plan",
          ]
        : ["config.complexityGrading", "workUnits"],
    feedback: [],
    produces: ["track"],
    fileOutput: false,
  },
  {
    kind: "step",
    stepKey: "design:review",
    stepType: "dispatch",
    handlerKey: "design:review",
    appliesWhen: fullTrack, // ENG-478's D11 widens this
    inputs: () => ["ticket.title", "profile.slug", "profile.promptVars", "plan", "workUnits"],
    feedback: [],
    produces: ["planFindings"],
    fileOutput: false,
  },
  {
    kind: "gate",
    name: "plan-review",
    appliesWhen: fullTrack,
    reads: ["planFindings"],
    reason: "unresolved plan-review findings",
    signature: "review:unresolved-plan",
    stepKey: "design:review",
  },
];

export class DesignTableError extends StyreError {
  constructor(violations: string[]) {
    super({
      code: EXIT.INTERNAL,
      headline: "the declared design table breaks its own rules",
      detail: violations.join("\n"),
      recovery: "This is a Styre defect; report it with the lines above.",
    });
    this.name = "DesignTableError";
  }
}

const isSnapshot = (n: string): n is SnapshotInputName =>
  (SNAPSHOT_INPUT_NAMES as readonly string[]).includes(n);
export const isSnapshotInput = isSnapshot;

const CONTEXTS: readonly InputContext[] = [
  { complexityGrading: false },
  { complexityGrading: true },
];

/** The four rules of spec §3.1. Returns one line per violation. */
export function checkDesignTable(table: readonly DesignRow[]): string[] {
  const out: string[] = [];
  const stepRows = table.filter((r): r is StepRow => r.kind === "step");
  const producer = new Map<OutputName, { key: DesignStepKey; index: number }>();
  stepRows.forEach((r, index) => {
    for (const o of r.produces) {
      const prior = producer.get(o);
      if (prior) out.push(`rule 2: ${o} is produced by ${prior.key} and ${r.stepKey}`);
      else producer.set(o, { key: r.stepKey, index });
    }
  });
  stepRows.forEach((r, index) => {
    const read = new Set(CONTEXTS.flatMap((c) => r.inputs(c)));
    for (const n of read) {
      if (isSnapshot(n)) continue;
      const p = producer.get(n as OutputName);
      if (!p)
        out.push(
          `rule 1: ${r.stepKey} reads ${n}, which is neither a snapshot input nor an output`,
        );
      else if (p.index >= index)
        out.push(`rule 3: ${r.stepKey} reads ${n}, produced later by ${p.key}`);
    }
  });
  for (const g of table.filter((r): r is GateRow => r.kind === "gate")) {
    for (const n of g.reads)
      if (!producer.has(n)) out.push(`rule 1: gate ${g.name} reads ${n}, which no step produces`);
  }
  // Rule 4: the routing is `designRouting(table)`, the step rows in table order, so order holds by
  // construction (spec §3.1); what can still go wrong is a step listed twice.
  const seen = new Set<string>();
  for (const r of stepRows) {
    if (seen.has(r.stepKey)) out.push(`rule 4: ${r.stepKey} appears twice in the routing`);
    seen.add(r.stepKey);
  }
  return out;
}

/** The design routing the walk follows: the step rows, in table order. */
export function designRouting(table: readonly DesignRow[]): DesignStepKey[] {
  return table.filter((r): r is StepRow => r.kind === "step").map((r) => r.stepKey);
}

export function assertDesignTable(table: readonly DesignRow[] = DESIGN_TABLE): void {
  const violations = checkDesignTable(table);
  if (violations.length > 0) throw new DesignTableError(violations);
}

let checked = false;
/** Asserted when the table is first used in a process (spec §3.1). */
export function ensureDesignTableChecked(): void {
  if (checked) return;
  assertDesignTable();
  checked = true;
}

export function stepRow(stepKey: string): StepRow | undefined {
  return DESIGN_TABLE.find((r): r is StepRow => r.kind === "step" && r.stepKey === stepKey);
}

export function isTableStep(stepKey: string): stepKey is DesignStepKey {
  return stepRow(stepKey) !== undefined;
}

export function declaresInput(stepKey: string, name: InputName): boolean {
  const row = stepRow(stepKey);
  return row !== undefined && CONTEXTS.some((c) => row.inputs(c).includes(name));
}
