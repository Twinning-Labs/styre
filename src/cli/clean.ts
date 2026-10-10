import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineCommand } from "citty";
import { loadProfileByConvention, slugForCwd } from "../config/discover.ts";
import { readCopyOf } from "../db/read-copy.ts";
import { getLatestWorktreePath } from "../db/repos/dispatch.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  listWorktrees,
  reconcileWorktree,
} from "../dispatch/worktree.ts";
import { undoBeforeDiscard } from "../util/process/interruption.ts";
import { sweepOrphans } from "../util/process/sweep.ts";
import { assertCheckpointName, assertProfileSlug, checkpointPath } from "./checkpoint-name.ts";
import { checkpointUse, listCheckpoints } from "./checkpoints.ts";
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
  const stale = readCopyOf(c.dbPath, (db) => getLatestWorktreePath(db, c.ticketId));
  // In place, an interrupted step's edits are still in the checkout: undo them before the
  // checkpoint that names them is removed (ENG-485 section 7.5). Every caller checked the run lock.
  undoBeforeDiscard(c.dbPath, (line) => process.stderr.write(`${line}\n`));
  // `join(c.dir, "wt")` is a non-repo sentinel path used only for reconcileWorktree's in-place
  // (`newWorktreePath === repoPath`) check — it is never created or written to. Same idiom as
  // resumeRun's `targetWorktreePath` (park.ts) / run.ts:252-258.
  reconcileWorktree(targetRepo, c.branch, stale ?? undefined, join(c.dir, "wt"), c.dir);
  rmSync(c.dir, { recursive: true, force: true });
}

/** Worktrees of `targetRepo` that look like they belonged to a Styre run of `ident`: a folder named
 *  after the ident whose parent folder's name starts with `styre-wt-` (what run.ts and park.ts
 *  make), never the main entry and never the repository's own real path. Only printed, never
 *  removed (operator ruling, 2026-10-10). */
export function styreWorktreeCandidates(targetRepo: string, ident: string): string[] {
  const repo = realpathSync(targetRepo);
  return listWorktrees(targetRepo)
    .slice(1) // git lists the main working tree first
    .map((w) => w.path)
    .filter((p) => basename(p) === ident && basename(dirname(p)).startsWith("styre-wt-"))
    .filter((p) => !existsSync(p) || realpathSync(p) !== repo);
}

/** `styre clean <ident>` on a checkpoint it cannot use (operator rulings, 2026-10-10): refuse
 *  (exit 65) and remove nothing. It describes, as plain text, why, where the checkpoint is, and
 *  which worktrees look like the run's, and points at the docs for removing them by hand. It prints
 *  no shell command (nested slug listing and printed commands are ENG-491). */
function refuseUnusableCheckpoint(
  where: { ident: string; dir: string },
  kind: "unreadable" | "incompatible",
  reason: string,
  targetRepo: string,
): StyreError {
  const lines = [`checkpoint folder: ${where.dir}`];
  try {
    const paths = styreWorktreeCandidates(targetRepo, where.ident);
    if (paths.length === 0) lines.push(`no worktree of ${targetRepo} looks like this run's`);
    else {
      lines.push(`worktrees of ${targetRepo} that look like this run's:`);
      lines.push(...paths.map((p) => `  ${p}`));
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    lines.push(`could not list the worktrees of ${targetRepo}: ${why}`);
  }
  const docs = "the `styre clean` section of docs/architecture/runtime-parameters.md";
  return new StyreError({
    code: EXIT.RESUME_REFUSED,
    headline: `cannot clean '${where.ident}': this Styre cannot use its checkpoint (${reason})`,
    detail: lines.join("\n"),
    recovery:
      kind === "incompatible"
        ? `Nothing was removed. To keep the paused work, use the Styre that wrote it; to remove the run by hand instead, see ${docs}.`
        : `Nothing was removed. To remove the run by hand, see ${docs}.`,
  });
}

/** `styre clean <ident>`: reap ONE effort's disk artifacts — free its worktree and delete its
 *  checkpoint dir. Never changes ticket status (that's the issue tracker's job, driven by the
 *  merge itself) and never touches the SoT beyond a read-only classify. */
export async function cleanImpl(
  args: CleanArgs,
  opts?: { root?: string; targetRepo?: string; profile?: Profile },
): Promise<void> {
  // Names are checked before any path is built from them (operator rulings, 2026-10-10).
  if (args.ident !== undefined) assertCheckpointName("ident", args.ident);
  if (!args.ident && !args.all) {
    throw usageError("clean: name an effort's ident, or pass --all");
  }
  if (args.all && args.purge) {
    throw usageError("--purge targets a single effort; name an ident");
  }

  // Mirrors run.ts's profile/slug resolution (--profile now loads via loadProfile instead of
  // being silently ignored). Shared by both the single-ident and `--all` paths.
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
  // On every path, `--all` and the opts seams included (ruling B1): a slug read from a profile file
  // is a config error (78), any other a usage error (64).
  if (args.slug === undefined && args.profile && !opts?.profile)
    assertProfileSlug(slug, args.profile);
  assertCheckpointName("slug", slug);
  // Persist the convention-loaded profile into `profile` (rather than discarding it after reading
  // only `.targetRepo`) so `profile.defaultBranch` — the repo's REAL default branch — is available
  // to the --purge guard below. Only skip the disk load when the opts.targetRepo test seam is in
  // play: tests pass `opts.targetRepo` deliberately WITHOUT a profile on disk, and loading there
  // would throw.
  if (!profile && !opts?.targetRepo) {
    profile = loadProfileByConvention(slug);
  }
  const targetRepo = opts?.targetRepo ?? profile?.targetRepo;
  if (targetRepo === undefined) {
    // Unreachable: the block above guarantees `profile` is set whenever `opts?.targetRepo` is
    // not — kept as a type-safe guard instead of a non-null assertion.
    throw new Error("styre clean: could not resolve a target repo");
  }

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

  const dir = opts?.root ? checkpointPath(opts.root, slug, ident) : parkDir(slug, ident);
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

  // A checkpoint it cannot use, by schema or by damage, is refused (exit 65) and nothing is
  // removed (operator ruling, 2026-10-10: ENG-477 adds no new way to delete anything).
  const use = checkpointUse(dbPath, dir, "");
  if (use.kind !== "usable") {
    throw refuseUnusableCheckpoint({ ident, dir }, use.kind, use.reason, targetRepo);
  }
  const cls = use.cls;

  reapEffort(targetRepo, { branch: cls.branch, dir, ticketId: cls.ticketId, dbPath });

  if (args.purge) {
    // NEVER purge the profile's default branch: a ticket configured with an explicit
    // branch_name equal to (or matching) the default branch would otherwise make `--purge`
    // run `git push origin --delete <default>` — deleting the repo's default branch, which is
    // irreversible. `profile` is populated above (explicit --profile, or convention-loaded from
    // disk), so `defaultBranch` here is the repo's ACTUAL default branch in the real CLI path;
    // the `?? "main"` only covers the pure opts.targetRepo test seam, which intentionally leaves
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
  // The sweep runs first, before the checkpoint is discarded (section 8).
  run: (ctx) =>
    guard("clean", async () => {
      await sweepOrphans();
      await cleanImpl(ctx.args as unknown as CleanArgs);
    }),
});
