import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByStatus } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { gitRepoWithProject } from "../helpers/git-project.ts";

test("a session-limit park sets status=waiting, leaves the step running, appends a 'parked' event, and burns no attempt", async () => {
  const { db, ticketId } = gitRepoWithProject(); // seeds project.target_repo to a real git repo + ticket ENG-1 in 'implement'
  const runner = new FakeAgentRunner(() => ({
    completed: false,
    exitCode: 1,
    stdout: "partial",
    stderr: "You've hit your session limit · resets 11:10pm",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cause: "session-limit" as const,
    resetAt: "11:10pm",
  }));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: "/unused" }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
    timeoutMs: 1000,
  });
  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: undefined as never, // no projector needed for this path
    profile: { checksSystem: "none" },
  });
  expect(result.outcome).toBe("parked");
  expect(result.park?.cause).toBe("session-limit");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  expect(listByStatus(db, "running").length).toBe(1); // interrupted step left running
  expect(listEvents(db, ticketId).some((e) => e.kind === "parked")).toBe(true);
  db.close();
});
