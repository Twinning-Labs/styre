import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { finishRunResult, parkDir, resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import type { RunResult } from "../../src/daemon/run-ticket.ts";
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
  const { db, ticketId, repoPath } = gitRepoWithProject();
  const dbPath = db.filename; // bun:sqlite exposes the file path

  const profile = parseProfile({
    slug: PARK_SLUG,
    targetRepo: repoPath,
    defaultBranch: "main",
    checksSystem: "none",
    commands: {},
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
        linearIssueUuid: "uuid-harness",
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
    };
  } finally {
    // Restore XDG_STATE_HOME so the global side-effect doesn't leak to subsequent tests.
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
  }
}

export interface ResumedRunResult {
  /** All prompts received by the FakeAgentRunner, in order. */
  prompts: string[];
  result: RunResult;
}

/** Re-open a parked dump by calling the REAL `resumeRun` with injected test doubles.
 *  The `deps` seam supplies a fake `buildRegistry` + fake `ports` so no real LLM call occurs.
 *  Production stale-worktree cleanup (Fix B inside resumeRun) now handles worktree removal —
 *  no bespoke worktree cleanup here.
 *
 *  FakeAgentRunner strategy:
 *  - First call (implement:dispatch): writes a file to cwd, returns success.
 *  - All other calls (review, etc.): returns a valid empty-findings sidecar.
 *
 *  Profile: uses `commands: { build: "true", test: "true" }` so verify:integration passes. */
export async function resumeParkedTicket(
  parked: ParkedRunResult,
  opts?: { acceptHead?: boolean; inspect?: boolean },
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
  const ticketRow = db
    .query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1")
    .get();
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
    commands: { build: "true", test: "true" },
  });

  const prompts: string[] = [];
  let callCount = 0;

  const fakePorts = {
    issueTracker: fakeIssueTracker({
      ticket: {
        ident: parked.ident,
        title: "Harness ticket",
        description: "body",
        typeLabel: "Feature",
        linearIssueUuid: "uuid-harness",
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
            if (callCount === 1) {
              // implement:dispatch — write a file so the diff is non-empty (postcondition)
              writeFileSync(join(input.cwd, "harness-impl.ts"), "// harness-written impl\n");
              return {
                completed: true,
                exitCode: 0,
                stdout: "done",
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
          return buildDispatchRegistry({
            runner,
            agentConfig: DEFAULT_AGENT_CONFIG,
            profile: realProfile,
            worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-resume-")),
            resumeContext,
          });
        },
        ports: fakePorts,
      },
    );

    // resumeRun doesn't return RunResult directly; reconstruct a minimal RunResult for backward
    // compat with the test assertions. exitCode 75 = parked again; 65 = refused; 0 = pr-ready.
    const outcome = process.exitCode === 75 ? "parked" : process.exitCode === 65 ? "done" : "pr-ready";
    const result: RunResult = {
      outcome: outcome as RunResult["outcome"],
      iterations: 0,
      stage: "released",
      status: "done",
    };
    return { prompts, result };
  } finally {
    if (prevXdgStateHome === undefined) {
      process.env.XDG_STATE_HOME = undefined;
    } else {
      process.env.XDG_STATE_HOME = prevXdgStateHome;
    }
  }
}
