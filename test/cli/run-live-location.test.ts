import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { parkDir } from "../../src/cli/park.ts";
import { runImpl } from "../../src/cli/run.ts";
import { worktreeHoldingBranch } from "../../src/dispatch/worktree.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { runFreshTicket } from "../helpers/run-harness.ts";

test("a fresh run journals its SoT to parkDir/run.db, not a temp dir", async () => {
  const run = await runFreshTicket(); // drives real runImpl to a terminal; returns { checkpointDir, dbPath, cleanup }
  expect(run.dbPath).toBe(join(parkDir("test-project", "ENG-1"), "run.db"));
  expect(existsSync(run.dbPath)).toBe(true);
  run.cleanup();
});

test("a second fresh run on an existing checkpoint refuses (usage error), does not clobber", async () => {
  const first = await runFreshTicket();
  await expect(runFreshTicket({ reuseStateOf: first })).rejects.toThrow(
    /checkpoint already exists|--fresh/i,
  );
  first.cleanup();
});

test("--fresh discards an existing checkpoint (whole dir) and starts over", async () => {
  const first = await runFreshTicket();
  expect(existsSync(first.dbPath)).toBe(true);
  // A sidecar unrelated to run.db, dropped straight into the checkpoint dir, to prove --fresh
  // wipes the WHOLE dir (per the brief: run.db + -wal/-shm + transcript.json + run.lock) rather
  // than just unlinking dbPath. A narrower "just rm dbPath" fix would leave this behind.
  //
  // NOTE: the brief's literal third assertion (`existsSync(`${first.dbPath}-wal`)).toBe(false)`)
  // is not achievable here: bun:sqlite's `PRAGMA wal_checkpoint(TRUNCATE)` (which dumpPark runs
  // before every close, on every parked run — see src/cli/park.ts) truncates the -wal file's
  // *content* to zero bytes but never unlinks it; a completed second run always parks again via
  // the harness's session-limit runner and so leaves its own fresh (empty) -wal stub at the same
  // path. Verified empirically with bun:sqlite and the system sqlite3 CLI: TRUNCATE-checkpoint +
  // close leaves a present, 0-byte `-wal` file on disk in every case, --fresh or not. This sentinel
  // check exercises the same "whole dir vs. single file" guarantee without depending on that
  // internal SQLite/dumpPark behavior.
  const sentinel = join(first.checkpointDir, "leftover-sentinel.txt");
  writeFileSync(sentinel, "stale");
  const second = await runFreshTicket({ reuseStateOf: first, fresh: true }); // must NOT reject
  expect(existsSync(second.dbPath)).toBe(true);
  expect(existsSync(sentinel)).toBe(false); // whole dir wiped, not just run.db
  // second doesn't own stateRoot (reuseStateOf'd from first) — its cleanup only rewinds env to
  // what first left in place. first.cleanup() must run too, to restore the env to its true
  // pre-test value and remove the shared stateRoot (it's the one that owns it).
  second.cleanup();
  first.cleanup();
});

test("--fresh refuses (and does NOT delete) when a live foreign run.lock holds the checkpoint", async () => {
  const first = await runFreshTicket();
  expect(existsSync(first.dbPath)).toBe(true);
  // Simulate another live 'styre run' journaling this ticket right now: a live (not our own) pid
  // owns the lock. process.ppid is guaranteed alive for the duration of this test process.
  writeFileSync(join(first.checkpointDir, "run.lock"), String(process.ppid));
  await expect(runFreshTicket({ reuseStateOf: first, fresh: true })).rejects.toThrow(/in progress/);
  expect(existsSync(first.dbPath)).toBe(true); // NOT deleted — the live run's checkpoint survives
  first.cleanup();
});

test("a second concurrent (non-fresh) run refuses while a live run.lock is held (AC#3 wiring)", async () => {
  const first = await runFreshTicket();
  // Remove run.db so the earlier "checkpoint already exists" guard doesn't fire first — this test
  // targets the run-lock collision specifically (AC#3: two concurrent `run <same-ticket>` → the
  // second refuses because the lock is held), not the separate "checkpoint exists" refuse.
  rmSync(first.dbPath, { force: true });
  writeFileSync(join(first.checkpointDir, "run.lock"), String(process.ppid)); // live, foreign owner
  await expect(runFreshTicket({ reuseStateOf: first })).rejects.toThrow(/already in progress/);
  expect(existsSync(join(first.checkpointDir, "run.lock"))).toBe(true); // acquireRunLock never clobbered it
  first.cleanup();
});

test("--fresh reconciles a non-prunable, styre-owned leftover worktree (the common post-park state) instead of aborting at ensureWorktree", async () => {
  // `runFreshTicket` mints a NEW repo per call, so it can't reproduce a leftover worktree still
  // sitting in the SAME repo the fresh run will provision into. Drive `runImpl` directly, on a repo
  // we control, so we can plant that leftover before invoking --fresh.
  const SLUG = "test-project";
  const IDENT = "ENG-1";
  const prevEnv = {
    state: process.env.XDG_STATE_HOME,
    config: process.env.XDG_CONFIG_HOME,
    telemetry: process.env.STYRE_TELEMETRY,
  };
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-fresh-state-"));
  const configRoot = mkdtempSync(join(tmpdir(), "styre-fresh-config-"));
  const repoDir = mkdtempSync(join(tmpdir(), "styre-fresh-repo-"));
  const profileDir = mkdtempSync(join(tmpdir(), "styre-fresh-profile-"));
  // A parent dir separate from repoDir/profileDir/etc — cleaned up alongside them.
  const leftoverParent = mkdtempSync(join(tmpdir(), "styre-wt-leftover-"));

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

  // Plant a NON-PRUNABLE, styre-owned leftover: a real worktree holding the ticket's branch
  // (feat/ENG-1, from typeLabel "Feature"), its dir still present on disk — the COMMON state left
  // behind by a gracefully parked run (lock released, worktree never torn down). A path under
  // `/styre-wt-*` is what reconcileWorktree treats as styre-owned (see worktree.ts).
  const leftover = join(leftoverParent, "held");
  const addRes = Bun.spawnSync(["git", "worktree", "add", "-b", "feat/ENG-1", leftover], {
    cwd: repoDir,
  });
  expect(addRes.success).toBe(true);
  expect(worktreeHoldingBranch(repoDir, "feat/ENG-1")).not.toBeNull();
  expect(worktreeHoldingBranch(repoDir, "feat/ENG-1")?.prunable).toBe(false); // dir present → non-prunable

  const profilePath = join(profileDir, "profile.json");
  writeFileSync(
    profilePath,
    JSON.stringify({
      slug: SLUG,
      targetRepo: repoDir,
      defaultBranch: "main",
      checksSystem: "none",
      components: [],
    }),
  );

  process.env.XDG_STATE_HOME = stateRoot;
  process.env.XDG_CONFIG_HOME = configRoot;
  process.env.STYRE_TELEMETRY = "0";

  // A leftover checkpoint dir from a prior parked run: present on disk (so the --fresh block's
  // `existsSync(checkpointDir)` guard fires), no run.lock (the owner released it on park) — the
  // gracefully-parked post-park state.
  const checkpointDir = parkDir(SLUG, IDENT);
  mkdirSync(checkpointDir, { recursive: true });
  writeFileSync(join(checkpointDir, "run.db"), "stale");

  const ports = {
    issueTracker: fakeIssueTracker({
      ticket: {
        ident: IDENT,
        title: "Fresh harness ticket",
        description: "body",
        typeLabel: "Feature",
        externalId: "uuid-fresh-harness",
        url: null,
      },
    }),
    forge: fakeForge(),
  };

  try {
    // Must SUCCEED (frees the leftover via the liveness gate, then starts fresh) — not abort at
    // ensureWorktree's prunable-only refuse.
    await runImpl(
      { args: { ticket: IDENT, profile: profilePath, fresh: true } },
      {
        ports,
        runner: new FakeAgentRunner(() => ({
          completed: false,
          exitCode: 1,
          stdout: "partial work from session-limit",
          stderr: "You have reached your session limit · resets tomorrow",
          timedOut: false,
          costUsd: null,
          tokensIn: null,
          tokensOut: null,
          cause: "session-limit" as const,
          resetAt: "tomorrow",
        })),
        preflight: () => ({ ok: true, version: null }),
      },
    );

    // A real fresh checkpoint was journaled (not the stale placeholder).
    const dbPath = join(checkpointDir, "run.db");
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(join(dbPath, "..", "run.lock"))).toBe(false); // released on park
    // The original leftover holder no longer owns the branch — reconcileWorktree freed it.
    expect(existsSync(leftover)).toBe(false);
  } finally {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    };
    restore("XDG_STATE_HOME", prevEnv.state);
    restore("XDG_CONFIG_HOME", prevEnv.config);
    restore("STYRE_TELEMETRY", prevEnv.telemetry);
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(leftoverParent, { recursive: true, force: true });
  }
});
