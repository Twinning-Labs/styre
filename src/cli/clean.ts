import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { loadProfileByConvention, slugForCwd } from "../config/discover.ts";
import { getLatestWorktreePath } from "../db/repos/dispatch.ts";
import type { Profile } from "../dispatch/profile.ts";
import { reconcileWorktree } from "../dispatch/worktree.ts";
import { classifyCheckpointDb } from "./checkpoints.ts";
import { EXIT, StyreError, usageError } from "./errors.ts";
import { guard } from "./output.ts";
import { parkDir } from "./park.ts";
import { runLockStatus } from "./run-lock.ts";

export interface CleanArgs {
  ident?: string;
  all?: boolean;
  purge?: boolean;
  slug?: string;
  profile?: string;
}

/** The minimal shape `reapEffort` needs — a slice of `Checkpoint` plus the effort's db path. */
export interface EffortRef {
  branch: string;
  dir: string;
  ticketId: number;
  dbPath: string;
}

/** Free `targetRepo`'s worktree for `c`'s branch (liveness-gated reconcile — never a blind
 *  force-remove, see `reconcileWorktree`), then delete its checkpoint dir. Shared by clean's
 *  single-ident, `--all`, and `--purge` paths (ENG-386 Tasks 4-5). Never touches ticket status. */
export function reapEffort(targetRepo: string, c: EffortRef): void {
  const db = new Database(c.dbPath, { readonly: true });
  let stale: string | null;
  try {
    stale = getLatestWorktreePath(db, c.ticketId);
  } finally {
    db.close();
  }
  // `join(c.dir, "wt")` is a non-repo sentinel path used only for reconcileWorktree's in-place
  // (`newWorktreePath === repoPath`) check — it is never created or written to. Same idiom as
  // resumeRun's `targetWorktreePath` (park.ts) / run.ts:252-258.
  reconcileWorktree(targetRepo, c.branch, stale ?? undefined, join(c.dir, "wt"), c.dir);
  rmSync(c.dir, { recursive: true, force: true });
}

/** `styre clean <ident>`: reap ONE effort's disk artifacts — free its worktree and delete its
 *  checkpoint dir. Never changes ticket status (that's the issue tracker's job, driven by the
 *  merge itself) and never touches the SoT beyond a read-only classify. */
export async function cleanImpl(
  args: CleanArgs,
  opts?: { root?: string; targetRepo?: string; profile?: Profile },
): Promise<void> {
  if (!args.ident && !args.all) {
    throw usageError("clean: name an effort's ident, or pass --all");
  }
  if (args.all && args.purge) {
    throw usageError("--purge targets a single effort; name an ident");
  }
  if (!args.ident) {
    // `--all` execution is ENG-386 Task 4's job — this task wires the guards + single-ident path.
    throw usageError("styre clean --all is not yet implemented");
  }
  const ident = args.ident;

  const slug = args.slug ?? slugForCwd();
  if (!slug) {
    throw usageError(
      "styre clean: could not determine the project slug",
      "cd into the target repo, or pass --slug.",
    );
  }
  const targetRepo =
    opts?.targetRepo ?? (opts?.profile ?? loadProfileByConvention(slug)).targetRepo;

  const dir = opts?.root ? join(opts.root, slug, ident) : parkDir(slug, ident);
  const dbPath = join(dir, "run.db");
  if (!existsSync(dbPath)) {
    throw usageError(`no styre effort on '${ident}'`);
  }

  // Refuse gate BEFORE any deletion: a different live run owns this checkpoint.
  const lock = runLockStatus(dir);
  if (lock && !lock.self) {
    throw new StyreError({
      code: EXIT.TEMPFAIL,
      headline: `a run is in progress (pid ${lock.pid}); refusing to clean`,
    });
  }

  const db = new Database(dbPath, { readonly: true });
  let cls: ReturnType<typeof classifyCheckpointDb>;
  try {
    cls = classifyCheckpointDb(db, dir);
  } finally {
    db.close();
  }
  if (cls === null) {
    throw usageError(`no styre effort on '${ident}' (empty or unreadable checkpoint)`);
  }

  reapEffort(targetRepo, { branch: cls.branch, dir, ticketId: cls.ticketId, dbPath });

  process.stdout.write(`styre clean: reaped ${ident} (freed worktree, removed checkpoint)\n`);
}

export const cleanCommand = defineCommand({
  meta: { name: "clean", description: "Reap a finished/leftover styre effort's disk artifacts." },
  args: {
    ident: {
      type: "positional",
      required: false,
      description: "Ticket ident to clean (e.g. ENG-123)",
    },
    all: { type: "boolean", description: "Reap every pr-ready/done effort" },
    purge: { type: "boolean", description: "Single-effort only: also purge (ENG-386 Task 5)" },
    slug: {
      type: "string",
      description: "Project slug to locate the profile (default: derived from the cwd repo)",
    },
    profile: { type: "string", description: "Path to the project-profile JSON" },
  },
  run: (ctx) => guard("clean", () => cleanImpl(ctx.args as unknown as CleanArgs)),
});
