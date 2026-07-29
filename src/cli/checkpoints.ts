import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import { stateDir } from "../config/paths.ts";
import { listPending } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { runLockStatus } from "./run-lock.ts";

export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "interrupted" | "done" | "other";

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
  const t = getTicket(db, ticketId);
  if (t === null) return null;
  const branch = branchNameFor(t);
  const pending = listPending(db, ticketId);
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
      let cls: ReturnType<typeof classifyCheckpointDb> = null;
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          cls = classifyCheckpointDb(db, dir);
        } finally {
          db.close();
        }
      } catch {
        continue;
      }
      if (cls === null) continue;
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
