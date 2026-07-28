import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanImpl } from "../../src/cli/clean.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { setBranch, setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { listWorktrees } from "../../src/dispatch/worktree.ts";
import { seedCheckpoint } from "../helpers/checkpoint.ts";

/** A real temp git repo with one commit, mirroring run-live-location.test.ts's harness. */
function makeTargetRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "styre-clean-repo-"));
  const git = (args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: repoDir });
    if (!res.success) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@s.dev"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(repoDir, "README.md"), "x");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  return repoDir;
}

/** Like `makeTargetRepo`, but with a separate BARE `origin` remote wired up — for `--purge`
 *  coverage, which needs a real `git push origin --delete` / `git ls-remote` round trip
 *  (ENG-386 Task 5). Returns both repo dirs; caller is responsible for cleaning up `origin` too. */
function makeTargetRepoWithOrigin(): { repoDir: string; originDir: string } {
  const repoDir = makeTargetRepo();
  const originDir = mkdtempSync(join(tmpdir(), "styre-clean-origin-"));
  const git = (args: string[], cwd: string) => {
    const res = Bun.spawnSync(["git", ...args], { cwd });
    if (!res.success) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  };
  git(["init", "--bare", "-b", "main"], originDir);
  git(["remote", "add", "origin", originDir], repoDir);
  git(["push", "origin", "main"], repoDir);
  return { repoDir, originDir };
}

function remoteHasBranch(repoDir: string, branch: string): boolean {
  const res = Bun.spawnSync(["git", "ls-remote", "--heads", "origin", branch], { cwd: repoDir });
  return res.success && res.stdout.toString().trim() !== "";
}

/** Seed a pr-ready checkpoint at <root>/<slug>/<ident> plus a real styre-owned worktree in
 *  `repoDir` holding its branch, recorded as the effort's latest dispatch worktree_path. */
function seedPrReadyEffort(
  root: string,
  repoDir: string,
  slug: string,
  ident: string,
): { dir: string; branch: string; leftover: string; wtParent: string } {
  const branch = `feat/${ident}`;
  const wtParent = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const leftover = join(wtParent, "held");
  const addRes = Bun.spawnSync(["git", "worktree", "add", "-b", branch, leftover], {
    cwd: repoDir,
  });
  if (!addRes.success) throw new Error(`git worktree add failed: ${addRes.stderr.toString()}`);

  seedCheckpoint(root, slug, ident, (db, ticketId) => {
    setTicketStatus(db, ticketId, "waiting");
    setTicketStage(db, ticketId, "merge");
    insertPending(db, { ticketId, signalType: "human_merge_approval" });
    insertDispatch(db, { ticketId, dispatchId: "d1", seq: 1, worktreePath: leftover });
  });

  return { dir: join(root, slug, ident), branch, leftover, wtParent };
}

/** Like `seedPrReadyEffort`, but also pushes the branch to `origin` — for `--purge` coverage
 *  (ENG-386 Task 5), which needs a real local+remote branch to delete. */
function seedPrReadyEffortWithRemoteBranch(
  root: string,
  repoDir: string,
  slug: string,
  ident: string,
): { dir: string; branch: string; leftover: string; wtParent: string } {
  const seeded = seedPrReadyEffort(root, repoDir, slug, ident);
  const push = Bun.spawnSync(["git", "push", "origin", seeded.branch], { cwd: repoDir });
  if (!push.success)
    throw new Error(`git push origin ${seeded.branch} failed: ${push.stderr.toString()}`);
  return seeded;
}

/** Seed a checkpoint at <root>/<slug>/<ident> plus a real styre-owned worktree in `repoDir`
 *  holding its branch, recorded as the effort's latest dispatch worktree_path. Generalizes
 *  `seedPrReadyEffort` for `--all`'s multi-kind fixture (ENG-386 Task 4). */
function seedEffortWithWorktree(
  root: string,
  repoDir: string,
  slug: string,
  ident: string,
  shape: (db: Database, ticketId: number) => void,
): { dir: string; branch: string; leftover: string; wtParent: string } {
  const branch = `feat/${ident}`;
  const wtParent = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const leftover = join(wtParent, "held");
  const addRes = Bun.spawnSync(["git", "worktree", "add", "-b", branch, leftover], {
    cwd: repoDir,
  });
  if (!addRes.success) throw new Error(`git worktree add failed: ${addRes.stderr.toString()}`);

  seedCheckpoint(root, slug, ident, (db, ticketId) => {
    insertDispatch(db, { ticketId, dispatchId: "d1", seq: 1, worktreePath: leftover });
    shape(db, ticketId);
  });

  return { dir: join(root, slug, ident), branch, leftover, wtParent };
}

describe("cleanImpl", () => {
  test("reap: frees the worktree and removes the checkpoint dir for a pr-ready effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const repoDir = makeTargetRepo();
    const slug = "proj";
    const ident = "ENG-9";
    const { dir, branch, wtParent } = seedPrReadyEffort(root, repoDir, slug, ident);

    try {
      await cleanImpl({ ident, slug }, { root, targetRepo: repoDir });

      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${branch}`),
      ).toBeUndefined();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test("refuse-when-live: a live run.lock refuses (exit 75) and leaves worktree + dir untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const repoDir = makeTargetRepo();
    const slug = "proj";
    const ident = "ENG-10";
    const { dir, branch, wtParent } = seedPrReadyEffort(root, repoDir, slug, ident);
    // A live (not our own) pid owns the lock — process.ppid is guaranteed alive for the duration
    // of this test process (same idiom as run-live-location.test.ts).
    writeFileSync(join(dir, "run.lock"), String(process.ppid));

    try {
      await expect(cleanImpl({ ident, slug }, { root, targetRepo: repoDir })).rejects.toMatchObject(
        { code: 75 },
      );

      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${branch}`),
      ).not.toBeUndefined();
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test("--all: reaps pr-ready and done leftovers, protects needs_you and interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const repoDir = makeTargetRepo();
    const slug = "proj";

    const prReady = seedEffortWithWorktree(root, repoDir, slug, "ENG-20", (db, ticketId) => {
      setTicketStatus(db, ticketId, "waiting");
      setTicketStage(db, ticketId, "merge");
      insertPending(db, { ticketId, signalType: "human_merge_approval" });
    });
    const done = seedEffortWithWorktree(root, repoDir, slug, "ENG-21", (db, ticketId) => {
      setTicketStatus(db, ticketId, "done");
    });
    const needsYou = seedEffortWithWorktree(root, repoDir, slug, "ENG-22", (db, ticketId) => {
      setTicketStatus(db, ticketId, "waiting");
      insertPending(db, { ticketId, signalType: "human_resume", reason: "needs you" });
    });
    const interrupted = seedEffortWithWorktree(root, repoDir, slug, "ENG-23", () => {
      // active, no signal, no transcript → interrupted (same as checkpoints.test.ts's ENG-4)
    });

    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      written.push(s);
      return true;
    }) as typeof process.stdout.write;

    try {
      await cleanImpl({ all: true, slug }, { root, targetRepo: repoDir });

      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${prReady.branch}`),
      ).toBeUndefined();
      expect(existsSync(prReady.dir)).toBe(false);
      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${done.branch}`),
      ).toBeUndefined();
      expect(existsSync(done.dir)).toBe(false);

      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${needsYou.branch}`),
      ).not.toBeUndefined();
      expect(existsSync(needsYou.dir)).toBe(true);
      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${interrupted.branch}`),
      ).not.toBeUndefined();
      expect(existsSync(interrupted.dir)).toBe(true);

      const out = written.join("");
      expect(out).toContain("reaped 2");
      expect(out).toContain("kept 2");
      expect(out).toContain("0 failed");
    } finally {
      process.stdout.write = origWrite;
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      for (const e of [prReady, done, needsYou, interrupted]) {
        rmSync(e.wtParent, { recursive: true, force: true });
      }
    }
  });

  test("--purge: reaps the effort AND deletes the local + remote branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const { repoDir, originDir } = makeTargetRepoWithOrigin();
    const slug = "proj";
    const ident = "ENG-30";
    const { dir, branch, wtParent } = seedPrReadyEffortWithRemoteBranch(root, repoDir, slug, ident);

    try {
      expect(remoteHasBranch(repoDir, branch)).toBe(true);

      await cleanImpl({ ident, slug, purge: true }, { root, targetRepo: repoDir });

      expect(existsSync(dir)).toBe(false);
      expect(
        listWorktrees(repoDir).find((w) => w.branch === `refs/heads/${branch}`),
      ).toBeUndefined();
      const local = Bun.spawnSync(["git", "branch", "--list", branch], { cwd: repoDir });
      expect(local.stdout.toString().trim()).toBe("");
      expect(remoteHasBranch(repoDir, branch)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(originDir, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test("--purge: with no branch anywhere, still reaps the effort and writes no error output", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const { repoDir, originDir } = makeTargetRepoWithOrigin();
    const slug = "proj";
    const ident = "ENG-31";
    // Seed a checkpoint WITHOUT any worktree/branch — reapEffort must succeed on an
    // already-branchless effort, and the --purge tail must be a true silent no-op.
    const dir = join(root, slug, ident);
    seedCheckpoint(root, slug, ident, (db, ticketId) => {
      setTicketStatus(db, ticketId, "waiting");
      setTicketStage(db, ticketId, "merge");
      insertPending(db, { ticketId, signalType: "human_merge_approval" });
    });

    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      written.push(s.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await cleanImpl({ ident, slug, purge: true }, { root, targetRepo: repoDir });
      expect(existsSync(dir)).toBe(false);
    } finally {
      process.stderr.write = origWrite;
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(originDir, { recursive: true, force: true });
    }
    expect(written).toEqual([]);
  });

  test("--purge: refuses to delete the default branch, local and remote, even for an explicit branch_name of 'main'", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const { repoDir, originDir } = makeTargetRepoWithOrigin();
    // main was pushed to origin by makeTargetRepoWithOrigin while repoDir was checked out on
    // main; move the primary worktree off main so `main` isn't "held" by repoDir itself — same
    // shape as a real effort, whose default branch is never the styre worktree's own checkout.
    const mv = Bun.spawnSync(["git", "checkout", "-b", "not-main"], { cwd: repoDir });
    if (!mv.success) throw new Error(`git checkout -b not-main failed: ${mv.stderr.toString()}`);
    const slug = "proj";
    const ident = "ENG-40";
    const branch = "main";

    // A ticket with an explicit branch_name of "main" — e.g. misconfigured, or matching the
    // profile's default branch — is exactly the case `branchNameFor` warns about (ENG-386 review).
    const dir = seedCheckpoint(root, slug, ident, (db, ticketId) => {
      setTicketStatus(db, ticketId, "waiting");
      setTicketStage(db, ticketId, "merge");
      insertPending(db, { ticketId, signalType: "human_merge_approval" });
      setBranch(db, ticketId, branch);
    });

    const written: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      written.push(s.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(remoteHasBranch(repoDir, branch)).toBe(true);
      const localBefore = Bun.spawnSync(["git", "branch", "--list", branch], { cwd: repoDir });
      expect(localBefore.stdout.toString().trim()).not.toBe("");

      await cleanImpl({ ident, slug, purge: true }, { root, targetRepo: repoDir });

      // The reap (checkpoint dir) still happened — only the branch deletion was gated.
      expect(existsSync(dir)).toBe(false);

      const localAfter = Bun.spawnSync(["git", "branch", "--list", branch], { cwd: repoDir });
      expect(localAfter.stdout.toString().trim()).not.toBe("");
      expect(remoteHasBranch(repoDir, branch)).toBe(true);

      const err = written.join("");
      expect(err).toContain("refusing to --purge the default branch");
      expect(err).toContain(branch);
    } finally {
      process.stderr.write = origWrite;
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  test("--all --purge: rejected as a usage error (exit 64)", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-clean-state-"));
    const repoDir = makeTargetRepo();
    const slug = "proj";

    try {
      await expect(
        cleanImpl({ all: true, purge: true, slug }, { root, targetRepo: repoDir }),
      ).rejects.toMatchObject({ code: 64 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
