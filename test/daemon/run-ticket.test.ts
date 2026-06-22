import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

const profile = parseProfile({
  slug: "demo",
  targetRepo: "/tmp/x",
  defaultBranch: "main",
  commands: {},
  checksSystem: "none",
});

function reg() {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("no agent in merge");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rt-")),
  });
}

function seedAtMerge(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'merge' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "sha1" });
}

const ports = () => ({
  issueTracker: fakeIssueTracker(),
  forge: fakeForge(),
  checks: fakeChecks("passing"),
});

test("drives a merge-stage ticket to pr-ready (parked on human_merge_approval)", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),
    profile,
  });
  expect(r.outcome).toBe("pr-ready");
  expect(r.stage).toBe("merge");
  db.close();
});

test("reports blocked when a human_resume escalation is pending", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  insertPending(db, { ticketId, signalType: "human_resume", reason: "stuck" });
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),
    profile,
  });
  expect(r.outcome).toBe("blocked");
  db.close();
});

test("reports no-progress when nothing advances and no terminal is reached", async () => {
  const { db, ticketId } = makeTestDb();
  // Park on external_checks but drive WITHOUT a profile-less tick path: pass an unsupported
  // checksSystem so pollChecks never delivers → the ticket stalls.
  const stalledProfile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    commands: {},
    checksSystem: "external",
  });
  seedAtMerge(db, ticketId);
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),
    profile: stalledProfile,
    cap: 12,
  });
  expect(r.outcome).toBe("no-progress");
  db.close();
});
