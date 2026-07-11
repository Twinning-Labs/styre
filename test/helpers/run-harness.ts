import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { finishRunResult, parkDir, resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import type { RunOutcome, RunResult } from "../../src/daemon/run-ticket.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import type { ParkInfo } from "../../src/engine/park-signal.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { gitRepoWithProject } from "./git-project.ts";

const PARK_SLUG = "test-project";
const PARK_IDENT = "ENG-1";

export interface ParkedRunResult {
  slug: string;
  ident: string;
  park: ParkInfo;
  exitCode: number;
  result: RunResult;
  /** The resolved dump directory path (captured while XDG_STATE_HOME is still set) */
  dumpDir: string;
  /** Temp dirs that must survive until the test is fully done (call cleanupParkedRun when done). */
  _tempDirs: string[];
}

/** Best-effort removal of all temp dirs created by runParkedTicket / resumeParkedTicket.
 *  Call this in an afterAll (or after the last assertion) to avoid leaking temp dirs. */
export function cleanupParkedRun(parked: ParkedRunResult): void {
  for (const dir of parked._tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive a ticket to a `parked` outcome in-process, using the same wiring as `src/cli/run.ts`
 *  but with a session-limit FakeAgentRunner and fake ports. Sets `XDG_STATE_HOME` to a temp dir
 *  before calling `dumpPark` so the dump lands in a test-controlled location. Returns the info
 *  needed for the park-half assertions in `park-resume-e2e.test.ts`. */
export async function runParkedTicket(): Promise<ParkedRunResult> {
  // Capture and override XDG_STATE_HOME so dumpPark / parkDir write to a temp dir, not ~/.local/state.
  const prevXdgStateHome = process.env.XDG_STATE_HOME;
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-park-state-"));
  process.env.XDG_STATE_HOME = stateRoot;

  // Reset process.exitCode to 0 so we can observe what finishRunResult sets it to.
  process.exitCode = 0;

  // A real git repo + on-disk SQLite DB seeded with ticket ENG-1 at stage='implement' + work_unit.
  // repoPath and stateRoot must outlive this function (needed by resumeParkedTicket); they are
  // tracked in _tempDirs so the caller can clean them up after the full test via cleanupParkedRun.
  const { db, ticketId, repoPath } = gitRepoWithProject();
  const dbPath = db.filename; // bun:sqlite exposes the file path

  const profile = parseProfile({
    slug: PARK_SLUG,
    targetRepo: repoPath,
    defaultBranch: "main",
    checksSystem: "none",
  });

  // FakeAgentRunner that immediately returns session-limit (triggers ParkSignal in runAgentDispatch)
  const runner = new FakeAgentRunner(() => ({
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
  }));

  // worktreeRoot is only needed during driveToTerminal; cleaned up in the finally below.
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-wt-harness-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });

  const ports = {
    issueTracker: fakeIssueTracker({
      ticket: {
        ident: PARK_IDENT,
        title: "Harness ticket",
        description: "body",
        typeLabel: "Feature",
        externalId: "uuid-harness",
        url: null,
      },
    }),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };

  try {
    const result = await driveToTerminal(db, registry, {
      ticketId,
      config: DEFAULT_RUNTIME_CONFIG,
      ports,
      profile,
    });

    if (result.outcome !== "parked" || !result.park) {
      db.close();
      throw new Error(
        `runParkedTicket: expected 'parked' outcome, got '${result.outcome}'. Check FakeAgentRunner.`,
      );
    }

    // Capture the dump dir while XDG_STATE_HOME is still set (finishRunResult/dumpPark will write
    // here; the finally block restores XDG_STATE_HOME, so we must snapshot the path now).
    const dumpDir = parkDir(PARK_SLUG, PARK_IDENT);

    // Use the shared finishRunResult (same code path as run.ts) — it calls dumpPark, sets
    // process.exitCode = 75, and returns. We then read back process.exitCode as the observed value.
    finishRunResult(db, dbPath, PARK_SLUG, PARK_IDENT, result);

    return {
      slug: PARK_SLUG,
      ident: PARK_IDENT,
      park: result.park,
      exitCode: process.exitCode, // observed — not hardcoded
      result,
      dumpDir,
      // stateRoot and repoPath must survive until the caller is fully done with the parked run.
      _tempDirs: [stateRoot, repoPath],
    };
  } finally {
    // Restore XDG_STATE_HOME so the global side-effect doesn't leak to subsequent tests.
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
    // worktreeRoot is no longer needed once driveToTerminal has returned.
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
}

/** A `RunOutcome` extended with `"refused"` for the exit-65 HEAD-guard refusal path.
 *  The harness synthesises a minimal result from the observed process.exitCode; `"refused"` is
 *  not a durable `RunOutcome` (it is never stored in the DB) but is a valid harness signal. */
export type HarnessOutcome = RunOutcome | "refused";

export interface ResumedRunResult {
  /** All prompts received by the FakeAgentRunner, in order. */
  prompts: string[];
  /** Synthesised result from the observed exit code — use `exitCode` for precise refusal checks. */
  result: Omit<RunResult, "outcome"> & { outcome: HarnessOutcome };
  /** The real observed process.exitCode after resumeRun completes. */
  exitCode: number;
  /** Whether any dispatch was actually attempted (FakeAgentRunner recorded at least one input). */
  ran: boolean;
}

/** Re-open a parked dump by calling the REAL `resumeRun` with injected test doubles.
 *  The `deps` seam supplies a fake `buildRegistry` + fake `ports` so no real LLM call occurs.
 *  Production stale-worktree cleanup (Fix B inside resumeRun) now handles worktree removal —
 *  no bespoke worktree cleanup here.
 *
 *  FakeAgentRunner strategy:
 *  - `parkAgain: true`: runner returns session-limit again so the run re-parks (exit 75).
 *  - Normal (default): first call writes a file + returns success; subsequent calls return an
 *    empty-findings sidecar so the full run completes.
 *
 *  Profile: uses `commands: { build: "true", test: "true" }` so verify:integration passes. */
export async function resumeParkedTicket(
  parked: ParkedRunResult,
  opts?: { acceptHead?: boolean; inspect?: boolean; parkAgain?: boolean },
): Promise<ResumedRunResult> {
  // Restore the same XDG_STATE_HOME the park used so parkDir resolves to the same dumpDir.
  const xdgStateHome = join(parked.dumpDir, "..", "..", "..");
  const prevXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = xdgStateHome;
  process.exitCode = 0;

  // Read the real repo path from the dump DB for the profile.
  // (resumeRun re-opens it internally; we just need it for the profile here.)
  const dbPath = join(parked.dumpDir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  const ticketRow = db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get();
  if (!ticketRow) throw new Error("resumeParkedTicket: no ticket in dump DB");
  const ticketId = ticketRow.id;
  const projectRow = db
    .query<{ target_repo: string; default_branch: string }, [number]>(
      "SELECT target_repo, default_branch FROM project WHERE id = (SELECT project_id FROM ticket WHERE id = ?)",
    )
    .get(ticketId);
  if (!projectRow) throw new Error("resumeParkedTicket: no project in dump DB");
  db.close(); // resumeRun will re-open its own handle

  const realProfile = parseProfile({
    slug: parked.slug,
    targetRepo: projectRow.target_repo,
    defaultBranch: projectRow.default_branch,
    checksSystem: "none",
    components: [
      {
        name: "app",
        kind: "app",
        paths: ["**"],
        commands: { build: "true", test: "true" },
      },
    ],
  });

  const prompts: string[] = [];
  let callCount = 0;
  // Track the runner constructed in buildRegistry so we can read .inputs for the `ran` flag.
  let lastRunner: FakeAgentRunner | null = null;
  // Collect worktreeRoot dirs created inside buildRegistry for cleanup in the finally block.
  const resumeWorktreeDirs: string[] = [];

  const fakePorts = {
    issueTracker: fakeIssueTracker({
      ticket: {
        ident: parked.ident,
        title: "Harness ticket",
        description: "body",
        typeLabel: "Feature",
        externalId: "uuid-harness",
        url: null,
      },
    }),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };

  try {
    await resumeRun(
      { resume: parked.ident, acceptHead: opts?.acceptHead, inspect: opts?.inspect },
      realProfile,
      DEFAULT_RUNTIME_CONFIG,
      {
        buildRegistry: (resumeContext) => {
          const runner = new FakeAgentRunner((input) => {
            prompts.push(input.prompt);
            callCount++;
            if (opts?.parkAgain) {
              // Simulate session-limit again to produce a second park (exit 75).
              return {
                completed: false,
                exitCode: 1,
                stdout: "partial work from second session-limit",
                stderr: "You have reached your session limit · resets tomorrow",
                timedOut: false,
                costUsd: null,
                tokensIn: null,
                tokensOut: null,
                cause: "session-limit" as const,
                resetAt: "tomorrow",
              };
            }
            if (callCount === 1) {
              // implement:dispatch — write a file so the diff is non-empty (postcondition)
              writeFileSync(join(input.cwd, "harness-impl.ts"), "// harness-written impl\n");
              return {
                completed: true,
                exitCode: 0,
                stdout: 'done\n```styre-sidecar\n{"new_files":["harness-impl.ts"]}\n```',
                stderr: "",
                timedOut: false,
                costUsd: null,
                tokensIn: null,
                tokensOut: null,
              };
            }
            // review and any other dispatch: return a valid empty-findings sidecar
            return {
              completed: true,
              exitCode: 0,
              stdout: 'Done.\n```styre-sidecar\n{"findings":[]}\n```',
              stderr: "",
              timedOut: false,
              costUsd: null,
              tokensIn: null,
              tokensOut: null,
            };
          });
          lastRunner = runner;
          const wtRoot = mkdtempSync(join(tmpdir(), "styre-wt-resume-"));
          resumeWorktreeDirs.push(wtRoot);
          return buildDispatchRegistry({
            runner,
            agentConfig: DEFAULT_AGENT_CONFIG,
            profile: realProfile,
            worktreeRoot: wtRoot,
            resumeContext,
          });
        },
        ports: fakePorts,
      },
    );

    // resumeRun doesn't return RunResult directly; reconstruct a minimal result for backward
    // compat with the test assertions.
    // exitCode 75 = parked again; 65 = refused (HEAD guard); 0 = pr-ready or inspect-no-op.
    // NOTE: exit-65 maps to "refused" — NOT a durable RunOutcome — use exitCode to assert it.
    const exitCode = process.exitCode;
    const outcome: HarnessOutcome =
      exitCode === 75 ? "parked" : exitCode === 65 ? "refused" : "pr-ready";
    const result: Omit<RunResult, "outcome"> & { outcome: HarnessOutcome } = {
      outcome,
      iterations: 0,
      stage: "released",
      status: "done",
    };
    const ran = ((lastRunner as FakeAgentRunner | null)?.inputs.length ?? 0) > 0;
    return { prompts, result, exitCode, ran };
  } finally {
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
    // Clean up worktreeRoot dirs created during this resume.
    for (const dir of resumeWorktreeDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    // Note: stateRoot (dumpDir) and repoPath from the parked run are NOT cleaned here because
    // the caller may need the dumpDir after this call (e.g. to open the DB for assertions, or
    // to call resumeParkedTicket again). Call cleanupParkedRun(parked) when fully done.
  }
}

/**
 * Simulate an operator committing to the ticket branch after a park.
 *
 * Two things must be true for the HEAD guard to fire:
 *  1. The dump DB's baseline sha (`headBaseline`) must be non-null — i.e. at least one dispatch
 *     row must carry a `branch_head_sha`. The parked dispatch never records one (parking happens
 *     before `commitWorktree`), so we seed it here by updating that dispatch row.
 *  2. The branch's current HEAD must differ from the baseline.
 *
 * This function:
 *  a. Opens the dump DB and reads project.target_repo + ticket ident.
 *  b. Resolves the ticket branch name (feat/ENG-1 etc.) and reads its current sha.
 *  c. Updates the parked dispatch row to record that sha as the baseline.
 *  d. Makes a new empty commit on the branch so current HEAD > baseline.
 *  e. Closes the dump DB.
 */
export function advanceBranchHead(parked: ParkedRunResult): void {
  const dbPath = join(parked.dumpDir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);

  // Read target_repo + ticket ident + branch naming columns
  const ticketRow = db
    .query<
      { id: number; ident: string; branch_name: string | null; branch_prefix: string | null },
      []
    >("SELECT id, ident, branch_name, branch_prefix FROM ticket ORDER BY id LIMIT 1")
    .get();
  if (!ticketRow) throw new Error("advanceBranchHead: no ticket in dump DB");

  const projectRow = db
    .query<{ target_repo: string }, [number]>(
      "SELECT target_repo FROM project WHERE id = (SELECT project_id FROM ticket WHERE id = ?)",
    )
    .get(ticketRow.id);
  if (!projectRow) throw new Error("advanceBranchHead: no project in dump DB");

  const branch = ticketRow.branch_name ?? `${ticketRow.branch_prefix ?? "feat"}/${ticketRow.ident}`;
  const repoPath = projectRow.target_repo;

  // Get the branch's current sha (the branch may exist from the parked worktree creation,
  // or we need to create it first from main's HEAD).
  const refResult = Bun.spawnSync(["git", "rev-parse", branch], { cwd: repoPath });
  let baselineSha: string;
  if (refResult.success) {
    baselineSha = refResult.stdout.toString().trim();
  } else {
    // Branch doesn't exist yet — create it from main's HEAD so we have a baseline.
    const headResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoPath });
    if (!headResult.success) throw new Error("advanceBranchHead: can't get HEAD sha");
    baselineSha = headResult.stdout.toString().trim();
    const branchResult = Bun.spawnSync(["git", "branch", branch], { cwd: repoPath });
    if (!branchResult.success)
      throw new Error(`advanceBranchHead: git branch failed: ${branchResult.stderr.toString()}`);
  }

  // Seed the baseline sha into the most recent parked dispatch row so headBaseline() returns it.
  db.query(
    "UPDATE dispatch SET branch_head_sha = ? WHERE id = (SELECT id FROM dispatch WHERE ticket_id = ? AND branch_head_sha IS NULL ORDER BY id DESC LIMIT 1)",
  ).run(baselineSha, ticketRow.id);
  // Ensure WAL is flushed so the resumed run sees the update.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();

  // Create a new commit on the branch so current HEAD != baseline.
  // Use git commit-tree + update-ref to avoid touching any checked-out worktree.
  const treeResult = Bun.spawnSync(["git", "rev-parse", `${branch}^{tree}`], { cwd: repoPath });
  if (!treeResult.success) throw new Error("advanceBranchHead: can't get tree sha");
  const treeSha = treeResult.stdout.toString().trim();

  const commitResult = Bun.spawnSync(
    ["git", "commit-tree", "-p", branch, "-m", "operator: post-park change", treeSha],
    {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@s.dev",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@s.dev",
      },
    },
  );
  if (!commitResult.success)
    throw new Error(`advanceBranchHead: commit-tree failed: ${commitResult.stderr.toString()}`);
  const newSha = commitResult.stdout.toString().trim();

  // Update the branch ref to point to the new commit.
  const updateRef = Bun.spawnSync(["git", "update-ref", `refs/heads/${branch}`, newSha], {
    cwd: repoPath,
  });
  if (!updateRef.success)
    throw new Error(`advanceBranchHead: update-ref failed: ${updateRef.stderr.toString()}`);
}
