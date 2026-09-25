import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "../../src/agent/runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import { StepPrerequisiteError } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

// ENG-476: every completed dispatch must report the tool set the agent actually had, and it must
// equal the step's allowlist. Anything else stops the run loudly (a prerequisite failure — no
// retry burns cost against a provider that is not confining the agent).

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-cap-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function ctxFor(db: ReturnType<typeof makeTestDb>["db"], ticketId: number): HandlerContext {
  const step = insertPending(db, {
    ticketId,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG };
}

const spec = {
  handlerKey: "implement:dispatch",
  template: "implement {{ident}}",
  vars: { ident: "ENG-1" },
  postcondition: () => {},
};

function ok(extra: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    completed: true,
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
    costUsd: 0.1,
    tokensIn: 1,
    tokensOut: 1,
    ...extra,
  };
}

/** A runner that returns `result` verbatim — unlike FakeAgentRunner it adds no capabilities. */
function rawRunner(result: (input: AgentRunInput) => AgentRunResult): AgentRunner {
  return { run: async (input) => result(input) };
}

async function dispatchWith(runner: AgentRunner) {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-cap-${Date.now()}-${Math.random()}`);
  const call = runAgentDispatch(
    ctxFor(db, ticketId),
    {
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: parseProfile({ slug: "demo", targetRepo: repo }),
      repoPath: repo,
      worktreePath: wt,
      branch: "feat/ENG-1",
      timeoutMs: 1000,
    },
    spec,
  );
  return { db, ticketId, wt, call };
}

// implement:dispatch with no runner commands = Read, Grep, Glob, Write, Edit (Bash dropped).
const IMPLEMENT_TOOLS = ["Edit", "Glob", "Grep", "Read", "Write"];

test("a dispatch whose agent had an extra tool is refused as a prerequisite failure, uncommitted", async () => {
  const runner = rawRunner((input) => {
    writeFileSync(join(input.cwd, "leak.ts"), "x\n");
    return ok({ capabilities: { tools: [...IMPLEMENT_TOOLS, "Bash"], error: null } });
  });
  const { db, ticketId, wt, call } = await dispatchWith(runner);
  const err = await call.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StepPrerequisiteError);
  expect(String(err)).toContain("unexpected tools: Bash");
  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("dispatch-failed");
  expect(existsSync(join(wt, "leak.ts"))).toBe(false); // the attempt is undone, never committed
  db.close();
});

test("a dispatch whose provider reported an enforcement error is refused", async () => {
  const runner = rawRunner(() =>
    ok({ capabilities: { tools: IMPLEMENT_TOOLS, error: "claude ran in permission mode 'auto'" } }),
  );
  const { db, call } = await dispatchWith(runner);
  const err = await call.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StepPrerequisiteError);
  expect(String(err)).toContain("permission mode 'auto'");
  db.close();
});

test("a completed dispatch with no capability report is refused (never assumed confined)", async () => {
  const { db, call } = await dispatchWith(rawRunner(() => ok()));
  const err = await call.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StepPrerequisiteError);
  expect(String(err)).toContain("did not report");
  db.close();
});

test("a matching dispatch succeeds and records its effective tool set as an event", async () => {
  const runner = rawRunner(() => ok({ capabilities: { tools: IMPLEMENT_TOOLS, error: null } }));
  const { db, ticketId, call } = await dispatchWith(runner);
  await call;
  const note = listEvents(db, ticketId).find((e) => e.reason === "agent-capabilities");
  expect(note).toBeDefined();
  expect(JSON.parse(note?.payload_json ?? "{}")).toEqual({
    tools: IMPLEMENT_TOOLS,
    allowed: ["Read", "Grep", "Glob", "Write", "Edit"],
  });
  db.close();
});

test("FakeAgentRunner reports the step's own tool set by default, so existing tests stay confined", async () => {
  const runner = new FakeAgentRunner(() => ok());
  const { db, call } = await dispatchWith(runner);
  await call;
  db.close();
});

test("a FAILED dispatch the provider stopped for a wrong tool set is refused, not retried as transient", async () => {
  const runner = rawRunner(() => ({
    ...ok(),
    completed: false,
    exitCode: 137,
    cause: "transient",
    capabilities: {
      tools: [...IMPLEMENT_TOOLS, "Bash"],
      error: "stopped at startup: unexpected tools: Bash",
    },
  }));
  const { db, ticketId, call } = await dispatchWith(runner);
  const err = await call.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StepPrerequisiteError);
  expect(String(err)).toContain("stopped at startup");
  const refused = listEvents(db, ticketId).find((e) =>
    e.reason?.startsWith("agent-capabilities-refused"),
  );
  expect(refused?.reason).toBe(
    "agent-capabilities-refused: stopped at startup: unexpected tools: Bash",
  );
  expect(JSON.parse(refused?.payload_json ?? "{}")).toMatchObject({
    fault: "stopped at startup: unexpected tools: Bash",
    tools: [...IMPLEMENT_TOOLS, "Bash"],
  });
  expect(listByTicket(db, ticketId)[0]?.cost_usd).toBe(0.1); // the paid run's cost is kept
  db.close();
});

test("a failed dispatch with no capability report stays an ordinary transient failure", async () => {
  const runner = rawRunner(() => ({ ...ok(), completed: false, exitCode: 1, cause: "transient" }));
  const { db, call } = await dispatchWith(runner);
  const err = await call.catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(StepPrerequisiteError);
  expect(String(err)).toContain("transport failure");
  db.close();
});

test("the agent's pid is cleared from the journal once the dispatch returns (review round 3)", async () => {
  const { getById } = await import("../../src/db/repos/workflow-step.ts");
  const runner = new FakeAgentRunner(() => ok()); // FakeAgentRunner journals pid 424242 on spawn
  const { db, call } = await dispatchWith(runner);
  await call;
  const step = db.query("SELECT id FROM workflow_step LIMIT 1").get() as { id: number };
  expect(getById(db, step.id)?.pid).toBeNull();
  db.close();
});
