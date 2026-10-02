// ENG-485 section 7.7: the drive loop lets the leftover checks started after agent steps end
// before it returns, so they never write to a database a caller has already closed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import * as door from "../../src/util/process/door.ts";
import {
  __setCwdReadersForTests,
  checkLeftoversInBackground,
  pendingLeftoverChecks,
} from "../../src/util/process/leftovers.ts";
import { makeTestDb } from "../helpers/db.ts";
import { cleanupFixtures, folder, until } from "../helpers/leftover-fixtures.ts";

const profile = parseProfile({
  slug: "demo",
  targetRepo: "/tmp/x",
  defaultBranch: "main",
  checksSystem: "none",
});

beforeEach(() => door.__resetForTests());
afterEach(async () => {
  __setCwdReadersForTests(undefined);
  await pendingLeftoverChecks();
  cleanupFixtures();
  door.__resetForTests();
});

test("driveToTerminal does not return while a leftover check is still running", async () => {
  const { db, ticketId } = makeTestDb();
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
  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("no agent in merge");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rt-")),
  });

  let release: (v: Map<number, string>) => void = () => {};
  let started = false;
  __setCwdReadersForTests({
    async: () =>
      new Promise((r) => {
        started = true;
        release = r;
      }),
  });
  void checkLeftoversInBackground({
    worktree: folder("styre-wt-"),
    since: "0",
    report: () => {},
  });
  expect(await until(() => started)).toBe(true);

  let returned = false;
  const run = driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: {
      issueTracker: fakeIssueTracker(),
      forge: fakeForge(),
      checks: fakeChecks("passing"),
    },
    profile,
  }).then((r) => {
    returned = true;
    return r;
  });
  await Bun.sleep(150);
  expect(returned).toBe(false);
  release(new Map());
  const result = await run;
  expect(result.outcome).toBe("pr-ready");
  db.close();
});
