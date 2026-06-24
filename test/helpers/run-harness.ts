import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { dumpPark } from "../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import type { RunResult } from "../../src/daemon/run-ticket.ts";
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
}

/** Drive a ticket to a `parked` outcome in-process, using the same wiring as `src/cli/run.ts`
 *  but with a session-limit FakeAgentRunner and fake ports. Sets `XDG_STATE_HOME` to a temp dir
 *  before calling `dumpPark` so the dump lands in a test-controlled location. Returns the info
 *  needed for the park-half assertions in `park-resume-e2e.test.ts`. */
export async function runParkedTicket(): Promise<ParkedRunResult> {
  // Point XDG_STATE_HOME at a temp dir so dumpPark / parkDir write there (not ~/.local/state).
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-park-state-"));
  process.env.XDG_STATE_HOME = stateRoot;

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

  // Mirror the run.ts flow: dumpPark checkpoints WAL and closes db, then we set exit code.
  dumpPark(db, dbPath, PARK_SLUG, PARK_IDENT, result.park);

  return {
    slug: PARK_SLUG,
    ident: PARK_IDENT,
    park: result.park,
    exitCode: 75,
    result,
  };
}
