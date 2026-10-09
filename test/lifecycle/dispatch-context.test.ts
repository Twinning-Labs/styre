// ENG-485 section 7.3 step 6 (final review A F3): the dispatch's context (its row, the untracked
// files before it, its folder) lives in the door's in-flight step record from just before the agent
// is launched until the dispatch row is completed. A stop that lands after the agent's launch has
// left the live set (the adapter's output drain after finish()), but before the dispatch row is
// completed, still records the dispatch and closes its row as interrupted, so resume can undo the
// agent's edits in place.
//
// No process is started here apart from git: the agent is a stand-in in this process.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolNamesFor } from "../../src/agent/capabilities.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "../../src/agent/runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import * as steps from "../../src/db/repos/workflow-step.ts";
import { implementScope } from "../../src/dispatch/commit-scope.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import * as door from "../../src/util/process/door.ts";
import { __resetSignalsForTests, handleStopSignal } from "../../src/util/process/signals.ts";
import { makeTestDb } from "../helpers/db.ts";
import { makeTempDir } from "../helpers/temp.ts";

afterEach(() => {
  door.__resetForTests();
  __resetSignalsForTests();
});

/** The repositories this file made, removed after its tests. */
const repos: string[] = [];
afterAll(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

function gitRepo(): string {
  const root = realpathSync(makeTempDir("styre-dctx-"));
  repos.push(root);
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  writeFileSync(join(root, "cruft.txt"), "already here, untracked");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  return root;
}

const ok: AgentRunResult = {
  completed: true,
  exitCode: 0,
  stdout: "{}",
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
};

test("a stop after the agent has left the live set, before its dispatch row is completed, still records the dispatch", async () => {
  const { db, ticketId } = makeTestDb();
  const dbPath = (db as Database & { filename: string }).filename;
  const repo = gitRepo();
  const step = steps.insertPending(db, {
    ticketId,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  steps.markRunning(db, step.id, {});
  const running = steps.getById(db, step.id) as steps.WorkflowStepRow;
  door.beginStep({
    stepId: step.id,
    startedAt: running.started_at as string,
    ident: "ENG-1",
    headAtStart: null,
  });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");

  // The agent wrote a file and exited; the adapter is still draining its output. Nothing of it is
  // in the live set any more.
  let release: () => void = () => {};
  const drained = new Promise<void>((r) => {
    release = r;
  });
  let agentDone: () => void = () => {};
  const agentExited = new Promise<void>((r) => {
    agentDone = r;
  });
  const runner: AgentRunner = {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
      agentDone();
      await drained;
      return ok;
    },
  };
  const call = runAgentDispatch(
    { db, ticket, step: running, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG },
    {
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: parseProfile({ slug: "demo", targetRepo: repo }),
      repoPath: repo,
      worktreePath: repo,
      branch: "feat/ENG-1",
      timeoutMs: 10_000,
    },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: implementScope,
      postcondition: () => {},
    },
  ).catch((e: unknown) => e);
  await agentExited;
  expect(door.liveLaunches()).toEqual([]);
  const [row] = listByTicket(db, ticketId);
  expect(row.outcome).toBeNull();

  const emitted: unknown[] = [];
  await handleStopSignal(
    "SIGTERM",
    { command: "run", run: { db, dbPath, ticketId, ident: "ENG-1" } },
    {
      stderr: () => {},
      emit: (r) => emitted.push(r),
      reraise: () => {},
      exit: () => {},
      now: () => Date.now(),
      leftovers: () => [],
      noCore: () => {},
    },
  );
  release();
  await call;

  const note = db
    .query<{ payload_json: string }, [number]>(
      "SELECT payload_json FROM event_log WHERE ticket_id = ? AND kind = 'note' AND reason = 'interrupted'",
    )
    .get(ticketId);
  const payload = JSON.parse(note?.payload_json ?? "{}");
  expect(payload.dispatchRowId).toBe(row.id);
  expect(payload.untrackedBefore).toEqual(["cruft.txt"]);
  expect(payload.worktree).toBe(repo);
  expect(listByTicket(db, ticketId)[0]).toMatchObject({ outcome: "interrupted", partial: 1 });
  db.close();
});

test("once the dispatch row is completed, the in-flight step no longer carries its context", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const step = steps.insertPending(db, {
    ticketId,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  steps.markRunning(db, step.id, {});
  const running = steps.getById(db, step.id) as steps.WorkflowStepRow;
  door.beginStep({
    stepId: step.id,
    startedAt: running.started_at as string,
    ident: "ENG-1",
    headAtStart: null,
  });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  let during: door.LaunchContext | null | undefined;
  const runner: AgentRunner = {
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      during = door.inFlightStep()?.dispatch;
      writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
      return {
        ...ok,
        stdout: '{}\n```styre-sidecar\n{"new_files":["feature.ts"]}\n```',
        capabilities: { tools: toolNamesFor(input.allowedTools), error: null },
      };
    },
  };
  await runAgentDispatch(
    { db, ticket, step: running, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG },
    {
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: parseProfile({ slug: "demo", targetRepo: repo }),
      repoPath: repo,
      worktreePath: repo,
      branch: "feat/ENG-1",
      timeoutMs: 10_000,
    },
    {
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: implementScope,
      postcondition: () => {},
    },
  );
  expect(during?.dispatchRowId).toBe(listByTicket(db, ticketId)[0].id);
  expect(door.inFlightStep()?.dispatch ?? null).toBeNull();
  db.close();
});
