import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import { stateDir } from "../config/paths.ts";
import { type DatabaseState, classifyDatabase } from "../db/migrate.ts";
import { CURRENT_VERSION, OLDEST_MIGRATABLE_VERSION } from "../db/migrations/index.ts";
import { readCopyOf } from "../db/read-copy.ts";
import { listCheckpointPendingSignals, readCheckpointTicket } from "../db/repos/checkpoint-read.ts";
import { runLockStatus } from "./run-lock.ts";

export type CheckpointKind =
  | "needs_you"
  | "budget"
  | "pr-ready"
  | "interrupted"
  | "done"
  | "other"
  // Listed, never classified (operator rulings, 2026-10-09 and 2026-10-10): a checkpoint that
  // could not be read, and one whose schema this Styre cannot use. Never resumable, never reaped.
  | "unreadable"
  | "incompatible";

export interface Checkpoint {
  slug: string;
  ident: string;
  dir: string; // parkDir(slug, ident)
  dbPath: string; // join(dir, "run.db")
  ticketId: number;
  status: string;
  stage: string;
  branch: string; // branchNameFor(ticket)
  kind: CheckpointKind; // the design §5 "reason"
  note: string | null; // the design §5 "honest-note"
  ageMs: number; // now - run.db mtime
  live: boolean; // runLockStatus(dir) is a live, non-self process
  resumable: boolean; // kind ∈ {needs_you, budget, interrupted}
}

function singleTicketId(db: Database): number | null {
  return (
    db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get()?.id ?? null
  );
}

function budgetNote(dir: string): string {
  try {
    const j = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as {
      resetAt?: string | null;
    };
    return j.resetAt ? `out of budget (resets ${j.resetAt})` : "out of budget";
  } catch {
    return "out of budget";
  }
}

export function classifyCheckpointDb(
  db: Database,
  dir: string,
): {
  ticketId: number;
  status: string;
  stage: string;
  branch: string;
  kind: CheckpointKind;
  note: string | null;
} | null {
  const ticketId = singleTicketId(db);
  if (ticketId === null) return null;
  const t = readCheckpointTicket(db, ticketId);
  if (t === null) return null;
  const branch = branchNameFor(t);
  const pending = listCheckpointPendingSignals(db, ticketId);
  const humanResume = pending.find((s) => s.signal_type === "human_resume");
  const prReady =
    t.stage === "merge" &&
    t.status !== "done" &&
    pending.some((s) => s.signal_type === "human_merge_approval");
  let kind: CheckpointKind;
  let note: string | null;
  if (t.status === "done") {
    kind = "done";
    note = null;
  } else if (humanResume) {
    kind = "needs_you";
    note = humanResume.reason;
  } else if (prReady) {
    kind = "pr-ready";
    note = "PR open, awaiting merge";
  } else if (existsSync(join(dir, "transcript.json"))) {
    kind = "budget";
    note = budgetNote(dir);
  } else if (t.status === "active") {
    kind = "interrupted";
    note = "interrupted mid-run — resume to continue";
  } else {
    kind = "other";
    note = null;
  }
  return { ticketId, status: t.status, stage: t.stage, branch, kind, note };
}

const RESUMABLE: ReadonlySet<CheckpointKind> = new Set(["needs_you", "budget", "interrupted"]);

/** What a checkpoint's database says, read through one private copy: its state (a schema this
 *  Styre can use, or why not) and, when the schema is usable, its classification. */
export interface CheckpointRead {
  state: DatabaseState;
  cls: ReturnType<typeof classifyCheckpointDb>;
}

export function readCheckpoint(dbPath: string, dir: string): CheckpointRead {
  return readCopyOf(dbPath, (db) => {
    const state = classifyDatabase(db, dbPath);
    return { state, cls: state.kind === "refuse" ? null : classifyCheckpointDb(db, dir) };
  });
}

/** Why this Styre cannot use a checkpoint because of its schema (operator ruling, 2026-10-10):
 *  never reported as damage. */
export function incompatibleReason(state: DatabaseState): string {
  if (state.kind !== "refuse") throw new Error("incompatibleReason: the schema is usable");
  if (state.version === null) return "unknown database shape";
  if (state.version > CURRENT_VERSION) return `written by a newer Styre (schema v${state.version})`;
  if (state.version < OLDEST_MIGRATABLE_VERSION)
    return `older than v${OLDEST_MIGRATABLE_VERSION} (schema v${state.version})`;
  return "unknown database shape";
}

/** Whether `ls` and `clean` can use a checkpoint, from one read of it: classified, or why not.
 *  A schema this Styre refuses is `incompatible`, with its reason; a checkpoint that cannot be read
 *  (`readError` prefixes the error) or holds no ticket is `unreadable`. */
export type CheckpointUse =
  | { kind: "usable"; cls: NonNullable<ReturnType<typeof classifyCheckpointDb>> }
  | { kind: "incompatible" | "unreadable"; reason: string };

export function checkpointUse(dbPath: string, dir: string, readError: string): CheckpointUse {
  let read: CheckpointRead | null = null;
  let reason = "no ticket recorded";
  try {
    read = readCheckpoint(dbPath, dir);
  } catch (err) {
    reason = `${readError}${err instanceof Error ? err.message : String(err)}`;
  }
  if (read?.state.kind === "refuse") {
    return { kind: "incompatible", reason: incompatibleReason(read.state) };
  }
  const cls = read?.cls ?? null;
  if (cls === null) return { kind: "unreadable", reason };
  return { kind: "usable", cls };
}

/** A checkpoint listed without a classification, never dropped: never resumable, never reaped
 *  by `clean --all`. */
function unusableCheckpoint(
  where: { slug: string; ident: string; dir: string; dbPath: string },
  kind: "unreadable" | "incompatible",
  note: string,
): Checkpoint {
  const lock = runLockStatus(where.dir);
  return {
    ...where,
    ticketId: 0,
    status: "unknown",
    stage: "unknown",
    branch: "",
    kind,
    note,
    ageMs: 0,
    live: lock !== null && !lock.self,
    resumable: false,
  };
}

export function listCheckpoints(root: string = stateDir()): Checkpoint[] {
  const out: Checkpoint[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const slug of slugs) {
    const slugDir = join(root, slug);
    let idents: string[];
    try {
      if (!statSync(slugDir).isDirectory()) continue;
      idents = readdirSync(slugDir);
    } catch {
      continue;
    }
    for (const ident of idents) {
      const dir = join(slugDir, ident);
      const dbPath = join(dir, "run.db");
      if (!existsSync(dbPath)) continue;
      const use = checkpointUse(dbPath, dir, "could not read it: ");
      if (use.kind !== "usable") {
        out.push(unusableCheckpoint({ slug, ident, dir, dbPath }, use.kind, use.reason));
        continue;
      }
      const cls = use.cls;
      let ageMs = 0;
      try {
        ageMs = now - statSync(dbPath).mtimeMs;
      } catch {
        ageMs = 0;
      }
      const lock = runLockStatus(dir);
      out.push({
        slug,
        ident,
        dir,
        dbPath,
        ...cls,
        ageMs,
        live: lock !== null && !lock.self,
        resumable: RESUMABLE.has(cls.kind),
      });
    }
  }
  return out;
}
