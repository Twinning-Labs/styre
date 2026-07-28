import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanImpl } from "../../src/cli/clean.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
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
});
