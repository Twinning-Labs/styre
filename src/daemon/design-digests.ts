import type { Database } from "bun:sqlite";
import { getTicket } from "../db/repos/ticket.ts";
import {
  listByTicket as listUnits,
  parseDependsOn,
  parseFilesToTouch,
  parseVerifyCheckTypes,
} from "../db/repos/work-unit.ts";
import { getByKey, recordManifest } from "../db/repos/workflow-step.ts";
import { linearFromFrontmatter } from "../dispatch/plan-frontmatter.ts";
import { planFilesAt } from "../dispatch/worktree.ts";
import { MalformedStepResultError } from "../engine/step-journal.ts";
import { FINGERPRINT_SCHEME, digestValue } from "./canonical.ts";
import {
  type InputContext,
  type OutputName,
  type StepRow,
  isSnapshotInput,
} from "./design-graph.ts";
import { snapshotDigest, snapshotValue } from "./design-inputs.ts";

/** design:extract's output (spec §5.3): only the fields it wrote, units of origin `extract` by
 *  seq, plus ticket.needs_docs. No ids, no timestamps, no status or base_sha (later stages change them). */
export function digestWorkUnits(db: Database, ticketId: number): string {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`digestWorkUnits: ticket ${ticketId} not found`);
  const units = listUnits(db, ticketId)
    .filter((u) => u.origin === "extract")
    .map((u) => ({
      seq: u.seq,
      kind: u.kind,
      title: u.title,
      description: u.description,
      behavioral: u.behavioral,
      test_plan: u.test_plan,
      files_to_touch: parseFilesToTouch(u),
      verify_check_types: parseVerifyCheckTypes(u),
      depends_on: parseDependsOn(u),
    }));
  return digestValue({ units, needsDocs: ticket.needs_docs });
}

/** design:size's output. */
export function digestTrack(db: Database, ticketId: number): string {
  return digestValue(getTicket(db, ticketId)?.track ?? null);
}

/** The `docs/plans/*.md` files at `ref` whose frontmatter `linear:` is this ticket, sorted by
 *  path, read through git (spec §5.3). `ref` is a commit sha or a fully qualified ref
 *  (`refs/heads/<branch>`), never a bare branch name: git resolves a tag of that name first. */
export function ticketPlanFilesAt(
  repoPath: string,
  ref: string,
  ident: string,
): { path: string; content: string }[] {
  return planFilesAt(repoPath, ref).filter((f) => linearFromFrontmatter(f.content) === ident);
}

/** The plan's digest (spec §5.3): path and content of each file, sorted by path. A renamed or
 *  extra plan file changes it. */
export function planDigestOf(files: readonly { path: string; content: string }[]): string {
  return digestValue(files.map((f) => ({ path: f.path, content: f.content })));
}

/** `ref` is a commit sha or a fully qualified ref, never a bare branch name (see above). */
export function planDigestAt(repoPath: string, ref: string, ident: string): string {
  return planDigestOf(ticketPlanFilesAt(repoPath, ref, ident));
}

/** The digest of "no plan file for this ticket". Test mocks of design:dispatch return it. */
export const EMPTY_PLAN_DIGEST = digestValue([]);

export function inputContext(db: Database, ticketId: number): InputContext {
  return { complexityGrading: snapshotValue(db, ticketId, "config.complexityGrading") === true };
}

function outputDigest(db: Database, ticketId: number, name: OutputName): string {
  switch (name) {
    case "plan": {
      const s = getByKey(db, ticketId, "design:dispatch");
      if (!s || s.status !== "succeeded" || s.output_digest === null)
        throw new Error(
          `ticket ${ticketId}: the plan has no recorded digest (design:dispatch is ${s?.status ?? "absent"})`,
        );
      return s.output_digest;
    }
    case "workUnits":
      return digestWorkUnits(db, ticketId);
    case "track":
      return digestTrack(db, ticketId);
    case "planFindings":
      throw new Error(
        "plan findings are read only by the gate; they are never a fingerprinted input",
      );
  }
}

/** The manifest `row` would record now: each declared input's current digest. Database only. */
export function currentManifest(
  db: Database,
  ticketId: number,
  row: StepRow,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of row.inputs(inputContext(db, ticketId))) {
    out[name] = isSnapshotInput(name)
      ? snapshotDigest(db, ticketId, name)
      : outputDigest(db, ticketId, name);
  }
  return out;
}

/** Input names whose digest differs, or that are present on one side only, sorted. */
export function changedInputs(
  recorded: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])]
    .filter((n) => recorded[n] !== current[n])
    .sort();
}

/** Called inside the success transaction (spec §5.2). `outputDigest` is computed before it. */
export function recordStepManifest(
  db: Database,
  ticketId: number,
  stepId: number,
  row: StepRow,
  outputDigest: string | null,
): void {
  if (row.fileOutput && outputDigest === null)
    throw new MalformedStepResultError(
      `${row.stepKey} succeeded without the digest of its file output`,
    );
  const manifest = currentManifest(db, ticketId, row);
  recordManifest(db, stepId, {
    manifest,
    fingerprint: digestValue(manifest),
    outputDigest: row.fileOutput ? outputDigest : null,
    scheme: FINGERPRINT_SCHEME,
  });
}

export function planDigestFromResult(result: unknown): string {
  const d = (result as { planDigest?: unknown } | null)?.planDigest;
  if (typeof d !== "string")
    throw new MalformedStepResultError("design:dispatch succeeded without a plan digest");
  return d;
}
