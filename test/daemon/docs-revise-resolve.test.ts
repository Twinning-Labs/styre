import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import {
  completeDispatch,
  insertDispatch,
  listByTicket as listDispatches,
  nextSeq,
} from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  insertSignal as insertGtSignal,
  listByTicket as listGtSignals,
} from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setNeedsDocs } from "../../src/db/repos/ticket.ts";
import {
  listByTicket as listWorkUnits,
  setStatus as setWorkUnitStatus,
} from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { gitRepoWithProject } from "../helpers/git-project.ts";

/** A minimal successful (non-sidecar) agent result: no cost/token accounting, no timeout. */
function ok(stdout = ""): AgentRunResult {
  return {
    completed: true,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  };
}

/** A valid empty-findings `review` sidecar — lets a `review` dispatch (served immediately after the
 *  implement→review advance, within the same tick — see resolver.ts/advance.ts) succeed cleanly so
 *  driving further doesn't cascade into unrelated retry/escalate noise. */
const EMPTY_FINDINGS_SIDECAR = 'Done.\n```styre-sidecar\n{"findings":[]}\n```';

type TestDb = ReturnType<typeof gitRepoWithProject>["db"];

/** Seed a ticket (from `gitRepoWithProject()`, at stage='implement' with one pending work_unit) into
 *  exactly the state the resolver requires to serve `docs:revise` next: `needs_docs=1`, the unit
 *  marked `verified`, a dispatch row recording the ticket's HEAD, and an `ac-check-gate` pass +
 *  `integration` signal recorded AT THAT SAME sha ("V").
 *
 *  V is the REAL git sha of the repo's initial commit (not an opaque placeholder string) — load
 *  bearing: `docs:revise`'s worktree is freshly branched off the repo's actual HEAD, so an agent
 *  attempt that never commits (a no-op, or an offense reverted by the commitGuard) leaves the
 *  worktree HEAD at exactly this real sha. Seeding V as the true git sha means every retry's
 *  `branch_head_sha` still matches these seeded signals, so the resolver keeps re-selecting
 *  `docs:revise` on retry instead of detouring into the gate/integration re-check branches. */
function seedDocsReviseReady(db: TestDb, ticketId: number, repoPath: string): string {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoPath });
  if (!head.success) {
    throw new Error(`seedDocsReviseReady: git rev-parse HEAD failed: ${head.stderr.toString()}`);
  }
  const V = head.stdout.toString().trim();

  setNeedsDocs(db, ticketId, 1);
  for (const u of listWorkUnits(db, ticketId)) {
    setWorkUnitStatus(db, u.id, "verified");
  }

  const d = insertDispatch(db, { ticketId, dispatchId: "seed-d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: V });

  insertGtSignal(db, {
    ticketId,
    signalType: "integration",
    result: "pass",
    branchHeadSha: V,
    detail: { ran: [] },
  });

  const ac = insertAc(db, { ticketId, seq: 1, text: "does the thing", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: ac.id, selector: "s1", testPath: "t1" });
  insertGtSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: "pass",
    branchHeadSha: V,
    detail: { stillRed: [] },
  });

  return V;
}

function harness(repoPath: string, runner: FakeAgentRunner) {
  const profile = parseProfile({
    slug: "docs-e2e",
    targetRepo: repoPath,
    defaultBranch: "main",
    checksSystem: "none",
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-dr-resolve-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  const ports = {
    issueTracker: fakeIssueTracker(),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };
  return { profile, registry, ports };
}

test("A (the crux): a real docs edit reaches review — no 'no handler registered' crash, no no-progress wedge", async () => {
  const { db, ticketId, repoPath } = gitRepoWithProject();
  const V = seedDocsReviseReady(db, ticketId, repoPath);

  let callCount = 0;
  const runner = new FakeAgentRunner((input) => {
    callCount++;
    if (callCount === 1) {
      // docs:revise dispatch — a REAL doc edit.
      mkdirSync(join(input.cwd, "docs"), { recursive: true });
      writeFileSync(join(input.cwd, "docs", "x.md"), "sync");
      return ok();
    }
    // Any later dispatch (review, etc.) — succeed cleanly so driving doesn't cascade elsewhere.
    return ok(EMPTY_FINDINGS_SIDECAR);
  });
  const { registry, ports } = harness(repoPath, runner);

  const cap = 20;
  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports,
    profile: { checksSystem: "none" },
    cap,
  });

  // The crux: pre-fix this either threw "no handler registered for 'docs:revise'" (driveToTerminal
  // would have rejected) or silently wedged spinning to the iteration cap. Neither happened.
  expect(result.outcome).not.toBe("no-progress");
  expect(result.iterations).toBeLessThan(cap);

  // Reached stage='review': the resolver's implement→review transition fired.
  const events = listEvents(db, ticketId);
  const reachedReview = events.some(
    (e) => e.kind === "transition" && e.from_stage === "implement" && e.to_stage === "review",
  );
  expect(reachedReview).toBe(true);

  // A docs:revise dispatch row exists and succeeded.
  const docsStep = getByKey(db, ticketId, "docs:revise");
  expect(docsStep?.status).toBe("succeeded");
  const docsDispatch = listDispatches(db, ticketId).find((d) => d.step_id === docsStep?.id);
  expect(docsDispatch).toBeTruthy();
  expect(docsDispatch?.outcome).toBe("clean-success");

  // Carry-forward signals exist at the docs sha (a NEW sha, distinct from the seeded V).
  const docsSha = docsDispatch?.branch_head_sha;
  expect(docsSha).toBeTruthy();
  // Load-bearing: the doc edit MUST have moved HEAD (V→C1) — otherwise this test degrades into the
  // no-op case (C) and no longer proves the carry-forward/wedge fix (T7 review).
  expect(docsSha).not.toBe(V);
  const atDocsSha = listGtSignals(db, ticketId).filter((s) => s.branch_head_sha === docsSha);
  expect(atDocsSha.some((s) => s.signal_type === "integration")).toBe(true);
  expect(atDocsSha.some((s) => s.signal_type === "ac-check-gate")).toBe(true);

  db.close();
});

test("B: an offense (source edit) during docs:revise never wedges silently — retries then escalates, HEAD never carries it", async () => {
  const { db, ticketId, repoPath } = gitRepoWithProject();
  const V = seedDocsReviseReady(db, ticketId, repoPath);

  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "src"), { recursive: true });
    writeFileSync(join(input.cwd, "src", "evil.py"), "bad");
    return ok();
  });
  const { registry, ports } = harness(repoPath, runner);

  const cap = 8;
  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports,
    profile: { checksSystem: "none" },
    cap,
  });

  // Escalated, not silently wedged: 'blocked' (a human_resume pending signal), never 'no-progress'.
  expect(result.outcome).toBe("blocked");
  expect(result.iterations).toBeLessThan(cap);

  const ticket = getTicket(db, ticketId);
  expect(ticket?.status).toBe("waiting");
  expect(listPending(db, ticketId).some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(listEvents(db, ticketId).some((e) => e.kind === "escalated")).toBe(true);

  // Never advanced to review.
  expect(
    listEvents(db, ticketId).some((e) => e.kind === "transition" && e.to_stage === "review"),
  ).toBe(false);

  // The branch HEAD in the real repo never moved past V — src/evil.py never landed.
  const branch = "feat/ENG-1";
  const branchSha = Bun.spawnSync(["git", "rev-parse", branch], { cwd: repoPath })
    .stdout.toString()
    .trim();
  expect(branchSha).toBe(V);
  const showEvil = Bun.spawnSync(["git", "show", `${branch}:src/evil.py`], { cwd: repoPath });
  expect(showEvil.success).toBe(false);

  db.close();
});

test("C: a no-op docs:revise dispatch (no changes) still advances to review", async () => {
  const { db, ticketId, repoPath } = gitRepoWithProject();
  seedDocsReviseReady(db, ticketId, repoPath);

  let callCount = 0;
  const runner = new FakeAgentRunner(() => {
    callCount++;
    return callCount === 1 ? ok() : ok(EMPTY_FINDINGS_SIDECAR);
  });
  const { registry, ports } = harness(repoPath, runner);

  const cap = 20;
  const result = await driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports,
    profile: { checksSystem: "none" },
    cap,
  });

  expect(result.outcome).not.toBe("no-progress");
  expect(result.iterations).toBeLessThan(cap);

  const docsStep = getByKey(db, ticketId, "docs:revise");
  expect(docsStep?.status).toBe("succeeded");
  expect(
    (docsStep && JSON.parse(docsStep.result_json ?? "{}")) as { docsRevised?: boolean },
  ).toEqual({ docsRevised: false });

  const reachedReview = listEvents(db, ticketId).some(
    (e) => e.kind === "transition" && e.from_stage === "implement" && e.to_stage === "review",
  );
  expect(reachedReview).toBe(true);

  db.close();
});
