import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function registryFor(runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: { test: "bun test" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-szwt-")),
  });
}

// design:dispatch succeeded + units present + track null → resolver routes to design:size.
function readyForSize(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  unitCount: number,
) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  for (let i = 1; i <= unitCount; i++) {
    insertWorkUnit(db, {
      ticketId,
      seq: i,
      kind: "backend",
      behavioral: 0,
      verifyCheckTypes: ["test"],
    });
  }
}

test("design:size (grader off) sizes by sprawl: 1 unit → fast", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 1);
  const runner = new FakeAgentRunner(() => {
    throw new Error("grader off: no agent should be dispatched");
  });
  await advanceOneStep(db, ticketId, registryFor(runner)); // runs design:size
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("fast");
});

test("design:size (grader off) sizes by sprawl: 2 units → full", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 2);
  const runner = new FakeAgentRunner(() => {
    throw new Error("grader off: no agent should be dispatched");
  });
  await advanceOneStep(db, ticketId, registryFor(runner));
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});
