import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { loadProfileByConvention, slugForCwd } from "../config/discover.ts";
import { getLatestWorktreePath } from "../db/repos/dispatch.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { deleteLocalBranch, deleteRemoteBranch, reconcileWorktree } from "../dispatch/worktree.ts";
import { classifyCheckpointDb, listCheckpoints } from "./checkpoints.ts";
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

  // Mirrors run.ts's profile/slug resolution (--profile now loads via loadProfile instead of
  // being silently ignored), while staying lazy about loadProfileByConvention so the opts test
  // seam (opts?.targetRepo) can still short-circuit it without a profile on disk — same as before.
  // Shared by both the single-ident and `--all` paths.
  let profile: Profile | undefined = opts?.profile;
  let slug: string;
  if (profile) {
    slug = args.slug ?? profile.slug;
  } else if (args.profile) {
    profile = loadProfile(args.profile);
    slug = args.slug ?? profile.slug;
  } else {
    const derived = args.slug ?? slugForCwd();
    if (!derived) {
      throw usageError(
        "styre clean: could not determine the project slug",
        "cd into the target repo, or pass --slug.",
      );
    }
    slug = derived;
  }
  const targetRepo = opts?.targetRepo ?? (profile ?? loadProfileByConvention(slug)).targetRepo;

  if (args.all) {
    // Scope to this project's slug — the state dir may hold multiple projects, but `targetRepo`
    // was resolved from a single profile, so reaping another slug's effort here would be wrong.
    const scoped = listCheckpoints(opts?.root).filter((c) => c.slug === slug);
    const finished = scoped.filter((c) => (c.kind === "pr-ready" || c.kind === "done") && !c.live);
    const kept = scoped.length - finished.length;

    let reaped = 0;
    const failures: { ident: string; error: unknown }[] = [];
    for (const c of finished) {
      // Re-check the lock immediately before reaping: a run can go live between the
      // `listCheckpoints` snapshot above and this iteration, and reconcileWorktree's internal
      // foreign-live check doesn't cover the narrow window where a run has acquired its lock but
      // not yet re-created its worktree. Mirrors the single-ident refuse gate above.
      const lock = runLockStatus(c.dir);
      if (lock && !lock.self) {
        failures.push({
          ident: c.ident,
          error: new Error("a run went live during the sweep; skipped"),
        });
        continue;
      }
      try {
        reapEffort(targetRepo, {
          branch: c.branch,
          dir: c.dir,
          ticketId: c.ticketId,
          dbPath: c.dbPath,
        });
        reaped++;
      } catch (e) {
        failures.push({ ident: c.ident, error: e });
      }
    }

    process.stdout.write(
      `styre clean: reaped ${reaped} finished leftover(s); kept ${kept} resumable/unknown; ${failures.length} failed\n`,
    );
    for (const f of failures) {
      const msg = f.error instanceof Error ? f.error.message : String(f.error);
      process.stderr.write(`styre clean: failed to reap ${f.ident}: ${msg}\n`);
    }
    return;
  }

  const ident = args.ident;
  if (!ident) throw usageError("clean: name an effort's ident, or pass --all");

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

  if (args.purge) {
    // NEVER purge the profile's default branch: a ticket configured with an explicit
    // branch_name equal to (or matching) the default branch would otherwise make `--purge`
    // run `git push origin --delete <default>` — deleting the repo's default branch, which is
    // irreversible. `profile` defaults its own `defaultBranch` to "main" (see Profile's zod
    // schema); mirror that fallback here for the opts.targetRepo test seam, which can leave
    // `profile` unresolved. The reap above has already happened — this only gates the deletion.
    const defaultBranch = profile?.defaultBranch ?? "main";
    if (cls.branch === defaultBranch) {
      process.stderr.write(
        `styre clean: refusing to --purge the default branch '${cls.branch}' (checkpoint + worktree already reaped)\n`,
      );
    } else {
      deleteLocalBranch(targetRepo, cls.branch);
      deleteRemoteBranch(targetRepo, cls.branch);
    }
  }

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
