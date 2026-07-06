import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkDir, resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  completeDispatch,
  insertDispatch,
  nextSeq as nextDispatchSeq,
} from "../../src/db/repos/dispatch.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

// helper: journal a step straight to succeeded (mirrors park.test.ts's local `succeed`, which is
// not shared/importable — see plan Task 7 review F5).
async function succeed(db: Parameters<typeof runStep>[0], ticketId: number, stepKey: string) {
  await runStep(db, {
    ticketId,
    stepKey,
    stepType: "provision",
    effectful: true,
    execute: () => ({ ok: true }),
  });
}

/** A real temp git repo with an initial commit on `main`, plus the ticket's feature branch
 *  created (not checked out) at that same commit — mirrors what an in-place park would have left
 *  behind: HEAD still needs a checkout to `branch` (the eventual `ensureWorktree` in-place call). */
function gitRepo(branch: string): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "styre-park-inplace-repo-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  run(["branch", branch]);
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
  return { root, sha };
}

test("resumeRun derives in-place from the persisted worktree path: skips wipe/reset and threads inPlace into the registry (S4)", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-park-inplace-state-"));
  const prevXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  const slug = "inplace-test";
  const ident = "ENG-9";
  const branch = `feat/${ident}`;
  const { root: repoPath, sha } = gitRepo(branch);

  try {
    const dir = parkDir(slug, ident);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const seedDb = openDb(dbPath);
    const projectId = insertProject(seedDb, { slug, targetRepo: repoPath });
    const ticketId = insertTicket(seedDb, { projectId, ident });
    setTicketStage(seedDb, ticketId, "implement");

    // provision already succeeded on a prior attempt — in-place resume must NOT reset this
    // (the deps persist in the repo root; re-arming would needlessly discard the reuse payoff).
    await succeed(seedDb, ticketId, "provision");
    expect(getByKey(seedDb, ticketId, "provision")?.status).toBe("succeeded");

    // A work unit already coded (status 'verifying') — the resolver's next actionable step is
    // 'provision' (skipped, already done above) then 'completeness' then 'verify:check' — no
    // agent dispatch is ever needed to reach a terminal (escalated/blocked) outcome.
    insertWorkUnit(seedDb, {
      ticketId,
      seq: 1,
      kind: "backend",
      status: "verifying",
      behavioral: 0,
      filesToTouch: [],
      verifyCheckTypes: ["build"],
    });

    // The prior IN-PLACE park: the latest dispatch row's worktree_path equals project.target_repo
    // (not a separate mkdtemp'd worktree) — this is the exact predicate `resumeRun` must derive
    // `inPlace` from: `getLatestWorktreePath(db, ticketId) === project.target_repo`.
    const seq = nextDispatchSeq(seedDb, ticketId);
    const d = insertDispatch(seedDb, {
      ticketId,
      dispatchId: `${ident}-d0001`,
      seq,
      worktreePath: repoPath,
    });
    completeDispatch(seedDb, d.id, { outcome: "parked", branchHeadSha: sha });

    seedDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    seedDb.close();

    const profile = parseProfile({
      slug,
      targetRepo: repoPath,
      defaultBranch: "main",
      checksSystem: "none",
    });

    // No `buildRegistry` override: this exercises the REAL `buildDispatchRegistry(...)` call
    // inside `resumeRun`, with the real `inPlace` value it derives. Only `ports` are faked.
    // Nothing here ever reaches an agent dispatch (verified below via the deterministic
    // escalation path), so the real (unused) claude runner selection is never invoked.
    await expect(
      resumeRun({ resume: ident }, profile, DEFAULT_RUNTIME_CONFIG, {
        ports: {
          issueTracker: fakeIssueTracker({
            ticket: {
              ident,
              title: "In-place resume",
              description: "body",
              typeLabel: "Feature",
              linearIssueUuid: "uuid-inplace",
              url: null,
            },
          }),
          forge: fakeForge(),
          checks: fakeChecks("passing"),
        },
      }),
    ).rejects.toThrow(/blocked/);

    // --- (a)+(b): inPlace was derived true AND threaded into the registry's handlers ---
    // Proof: `ensureWorktree`/`worktreeFor` resolve `worktreePath === repoPath` only when
    // `inPlace` is true — observable as the repo's OWN HEAD switching to the ticket branch
    // (worktree mode would instead `git worktree add` a separate directory and leave `repoPath`
    // on `main`).
    const headRes = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    expect(headRes.stdout.toString().trim()).toBe(branch);

    // No separate linked worktree was created — `git worktree list` shows only the repo itself.
    const wtListRes = Bun.spawnSync(["git", "worktree", "list"], { cwd: repoPath });
    const worktreeLines = wtListRes.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l !== "");
    expect(worktreeLines.length).toBe(1);

    // --- (c): resetProvisionForResume was NOT called ---
    const checkDb = openDb(dbPath);
    const provisionStep = getByKey(checkDb, ticketId, "provision");
    checkDb.close();
    expect(provisionStep?.status).toBe("succeeded");
    expect(provisionStep?.attempt).toBeGreaterThan(0); // untouched — resetProvisionForResume zeroes this
  } finally {
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("resumeRun re-checks in-place identity before mutating: throws when the active env's <pkg> doesn't resolve under target_repo (I-2)", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-park-inplace-identity-state-"));
  const prevXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  const slug = "inplace-identity-test";
  const ident = "ENG-10";
  const branch = `feat/${ident}`;
  const { root: repoPath } = gitRepo(branch);

  // A python component whose derivable import name is NOT installed anywhere the active
  // interpreter can see (`find_spec` returns None) — the identity probe can't resolve it under
  // repoPath, exactly like a foreign-checkout collision (a reused park dir whose target_repo path
  // happens to collide with a checkout the editable env doesn't actually target).
  writeFileSync(
    join(repoPath, "pyproject.toml"),
    '[project]\nname = "definitely_not_a_real_package_xyz123"\n',
  );

  try {
    const dir = parkDir(slug, ident);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const seedDb = openDb(dbPath);
    const projectId = insertProject(seedDb, { slug, targetRepo: repoPath });
    const ticketId = insertTicket(seedDb, { projectId, ident });
    setTicketStage(seedDb, ticketId, "implement");

    // The prior IN-PLACE park: latest dispatch's worktree_path === project.target_repo, so
    // `resumeRun` derives `inPlace = true` and must re-run the identity probe before anything else.
    const seq = nextDispatchSeq(seedDb, ticketId);
    const d = insertDispatch(seedDb, {
      ticketId,
      dispatchId: `${ident}-d0001`,
      seq,
      worktreePath: repoPath,
    });
    completeDispatch(seedDb, d.id, { outcome: "parked", branchHeadSha: null });

    seedDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    seedDb.close();

    const profile = parseProfile({
      slug,
      targetRepo: repoPath,
      defaultBranch: "main",
      checksSystem: "none",
      components: [{ name: "app", kind: "python", paths: ["**"], commands: {} }],
    });

    const headBefore = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
    })
      .stdout.toString()
      .trim();
    expect(headBefore).toBe("main");

    await expect(
      resumeRun({ resume: ident }, profile, DEFAULT_RUNTIME_CONFIG, {
        ports: {
          issueTracker: fakeIssueTracker({
            ticket: {
              ident,
              title: "In-place resume identity re-check",
              description: "body",
              typeLabel: "Feature",
              linearIssueUuid: "uuid-inplace-identity",
              url: null,
            },
          }),
          forge: fakeForge(),
          checks: fakeChecks("passing"),
        },
      }),
    ).rejects.toThrow(/in-place/);

    // Proof of "before mutating": the repo's own checkout never moved off `main` — the identity
    // probe fired (and threw) before `ensureWorktree`'s `checkout -B` could hijack it.
    const headAfter = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath })
      .stdout.toString()
      .trim();
    expect(headAfter).toBe("main");
  } finally {
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
});
