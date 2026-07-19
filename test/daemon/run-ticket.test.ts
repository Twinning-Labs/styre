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
import type { TelemetryEvent } from "../../src/telemetry/events.ts";
import { makeTestDb } from "../helpers/db.ts";

const profile = parseProfile({
  slug: "demo",
  targetRepo: "/tmp/x",
  defaultBranch: "main",
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

test("emits exactly one ci_handoff on the pr-ready path", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),
    profile, // checksSystem "none"
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready");
  const handoffs = seen.filter((e) => e.type === "ci_handoff");
  expect(handoffs).toHaveLength(1);
  const h = handoffs[0];
  if (h.type === "ci_handoff") {
    expect(h.checks_system).toBe("none");
    expect(h.read).toBe("skipped"); // checksSystem none → skipped, no port touched
    expect(h.pr_url).toContain("/pr/"); // fakeForge emits https://fake/pr/N (NOT "pull")
    expect(h.pr_ref).not.toBeNull(); // external_pr_result delivered before pr-ready fires
  }
  db.close();
});

test("D1: a failing CI read still exits pr-ready (exit disposition decoupled from CI)", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const ghProfile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    checksSystem: "github",
  });
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: fakeChecks("failing") },
    profile: ghProfile,
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready"); // red CI never blocks or loops back
  const h = seen.find((e) => e.type === "ci_handoff");
  expect(h && h.type === "ci_handoff" && h.read).toBe("failing"); // reported, not gated
  db.close();
});

test("the ci_handoff read is fail-safe: a throwing checks port yields not-reported", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const ghProfile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    checksSystem: "github",
  });
  let calls = 0;
  const throwingChecks = {
    status: async () => {
      calls++;
      throw new Error("boom");
    },
  };
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: throwingChecks },
    profile: ghProfile,
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("pr-ready"); // read failure never blocks the terminal
  expect(calls).toBe(1); // the throwing port WAS reached (test isn't vacuous)
  const h = seen.find((e) => e.type === "ci_handoff");
  expect(h && h.type === "ci_handoff" && h.read).toBe("not-reported");
  db.close();
});

test("the ci_handoff read times out on a hung checks port: yields not-reported, still pr-ready", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  const ghProfile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    checksSystem: "github",
  });
  const hangingChecks = {
    status: () => new Promise<never>(() => {}), // never resolves — a slow/unreachable CI API
  };
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: { issueTracker: fakeIssueTracker(), forge: fakeForge(), checks: hangingChecks },
    profile: ghProfile,
    emit: (e) => seen.push(e),
    ciReadTimeoutMs: 20, // drive the load-bearing Promise.race timeout fast
  });
  expect(r.outcome).toBe("pr-ready"); // a hung read never blocks the terminal
  const h = seen.find((e) => e.type === "ci_handoff");
  expect(h && h.type === "ci_handoff" && h.read).toBe("not-reported");
  db.close();
});

test("a non-merge terminal emits zero ci_handoffs", async () => {
  const { db, ticketId } = makeTestDb();
  seedAtMerge(db, ticketId);
  insertPending(db, { ticketId, signalType: "human_resume", reason: "stuck" });
  const seen: TelemetryEvent[] = [];
  const r = await driveToTerminal(db, reg(), {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: ports(),
    profile,
    emit: (e) => seen.push(e),
  });
  expect(r.outcome).toBe("blocked");
  expect(seen.filter((e) => e.type === "ci_handoff")).toHaveLength(0);
  db.close();
});
