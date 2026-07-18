import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import {
  classifyAcCheck,
  listByTicket as listAcChecks,
  listActiveByAc,
  reauthorRoundsForAc,
  supersedeByAc,
} from "../../src/db/repos/ac-check.ts";
import { listByTicket as listDispatches } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, resetToPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ch-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

// Drive the loop until it steps `checks:dispatch` (design:dispatch done + a unit + fast track already set).
async function markDesignDone(db: Parameters<typeof runStep>[0], ticketId: number) {
  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
}

test("checks:dispatch authors, verifies identity, runs RED-first, and persists a coarse red", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  // A checklist description → deriveAndPersistAcs yields two ACs.
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] returns ok\n- [ ] rejects bad input\n",
    ticketId,
  );
  // Force the resolver to the design→(provision→checks)→implement seam:
  //   design:dispatch done + one unit + track=fast (skips review) → provision, then checks:dispatch.
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // The agent authors one NEW test file per AC and returns the sidecar. ac_id = the AC DB ids (1,2).
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1.py"), "def test_ac1():\n    assert False\n");
    writeFileSync(join(dir, "ac2.py"), "def test_ac2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"},' +
        '{"ac_id":2,"test_file":"checks/ac2.py","test_name":"test_ac2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    // Inject the RED-first runner: a failing (red) run for every check (decision 4).
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  // The loop collapses design→provision (no prepare → no-op) then steps checks:dispatch.
  let outcome = await advanceOneStep(db, ticketId, registry); // provision
  outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch
  const checks = listAcChecks(db, ticketId);
  const signals = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-red-first");
  const step = getByKey(db, ticketId, "checks:dispatch");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(checks.length).toBe(2);
  expect(checks.every((c) => c.red_first_result === "red")).toBe(true);
  expect(checks.every((c) => c.selector !== "" && c.test_path !== null)).toBe(true);
  // Vocab map (§9): red → fail in ground_truth_signal (never 'red').
  expect(signals.length).toBe(2);
  expect(signals.every((s) => s.result === "fail")).toBe(true);
  // M3: the per-check exit code + framework + command are recorded at the source (detail_json).
  const details = signals.map((s) => JSON.parse(s.detail_json ?? "{}"));
  expect(details.every((d) => d.exitCode === 1)).toBe(true);
  expect(details.every((d) => d.framework === "pytest")).toBe(true);
  expect(details.every((d) => typeof d.command === "string" && d.command.length > 0)).toBe(true);
});

test("checks:dispatch rejects a MODIFIED file (identity: added-only) → postcondition fails", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // The agent EDITS the pre-existing README.md instead of adding a new file → identity reject.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "README.md"), "edited\ndef test_x(): pass\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"README.md","test_name":"test_x"}]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt2-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch → postcondition fail
  const step = getByKey(db, ticketId, "checks:dispatch");
  const checks = listAcChecks(db, ticketId);
  db.close();
  // No AC covered → postcondition throws → failure-policy (retry/escalate), nothing persisted.
  // `checks:dispatch` is a generic "dispatch"-type step (not verify/completeness/provision), so a
  // first-attempt failure falls to failure-policy's default branch: bounded retry, reset to
  // 'pending' (mirrors "a failing handler routes through failure-policy (retry)" in advance.test.ts —
  // NOT 'failed', which only survives when maxAttempts is already exhausted at entry).
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(checks.length).toBe(0);
});

test("checks:dispatch reverts its author commit when coverage fails — no invalid test files reach the branch (codex P1)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  // Two ACs — the agent will author a check for only ONE, so coverage fails on the other.
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] first thing\n- [ ] second thing\n",
    ticketId,
  );
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // Author ONLY AC-1's check file (an otherwise-valid added test). AC-2 is left uncovered → the
  // handler's coverage postcondition throws AFTER the daemon commit landed the file.
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1.py"), "def test_ac1():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"}]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-chwt-revert-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot,
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch → coverage fail

  const worktreePath = join(worktreeRoot, "ENG-1");
  const gitAt = (args: string[]) => Bun.spawnSync(["git", "-C", worktreePath, ...args]);
  // The rejected author left NO commit on the branch: its test file is absent at HEAD.
  const fileAtHead = gitAt(["cat-file", "-e", "HEAD:checks/ac1.py"]);
  // And it is gone from the working tree too (reset --hard + clean).
  const fileOnDisk = Bun.spawnSync(["test", "-f", join(worktreePath, "checks", "ac1.py")]);
  const dispatches = listDispatches(db, ticketId);
  const step = getByKey(db, ticketId, "checks:dispatch");
  db.close();

  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending"); // reset for the bounded retry
  expect(fileAtHead.success).toBe(false); // HEAD:checks/ac1.py does not exist → commit was reverted
  expect(fileOnDisk.success).toBe(false); // working tree cleaned too
  // The dispatch is recorded `reverted` (not clean-success) so getLatestForTicket never returns the
  // discarded author sha.
  expect(dispatches.some((d) => d.outcome === "reverted")).toBe(true);
});

test("checks:dispatch on a checks re-author loopback re-authors ONLY the flagged AC — the other AC's row is untouched", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] first thing\n- [ ] second thing\n",
    ticketId,
  );
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-chwt-scoped-"));
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
  });
  const runCheckCommand = async () => ({
    exitCode: 1,
    stdout: "1 failed",
    stderr: "",
    timedOut: false,
  });

  // Round 1: fresh dispatch — no checks-loopback event yet → whole-ticket author, both ACs covered.
  const runner1 = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1.py"), "def test_ac1():\n    assert False\n");
    writeFileSync(join(dir, "ac2.py"), "def test_ac2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"},' +
        '{"ac_id":2,"test_file":"checks/ac2.py","test_name":"test_ac2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry1 = buildDispatchRegistry({
    runner: runner1,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
    runCheckCommand,
  });
  await advanceOneStep(db, ticketId, registry1); // provision
  await advanceOneStep(db, ticketId, registry1); // checks:dispatch (whole-ticket)

  const checksBefore = listAcChecks(db, ticketId);
  expect(checksBefore.length).toBe(2);
  const ac1CheckBefore = checksBefore.find((c) => c.ac_id === 1);
  const ac2CheckBefore = checksBefore.find((c) => c.ac_id === 2);
  expect(ac1CheckBefore).toBeDefined();
  expect(ac2CheckBefore).toBeDefined();

  // AC-2's check is already classified (M3) — this row must survive a scoped re-author untouched.
  classifyAcCheck(db, {
    acCheckId: (ac2CheckBefore as (typeof checksBefore)[number]).id,
    redClass: "assertion",
  });

  // A checks re-author loopback flags ONLY AC-1.
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "checks",
    routeTo: "checks:classify",
    signature: "checks:1",
    payload: { acIds: [1], findings: [{ acId: 1, reason: "prior check was vacuous" }] },
  });
  const dispatchStep = getByKey(db, ticketId, "checks:dispatch");
  if (!dispatchStep) throw new Error("checks:dispatch step missing before scoped round");
  resetToPending(db, dispatchStep.id);

  // Round 2: the scoped re-author — the agent sees/authors only AC-1's replacement check.
  const runner2 = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1_v2.py"), "def test_ac1_v2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1_v2.py","test_name":"test_ac1_v2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry2 = buildDispatchRegistry({
    runner: runner2,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
    runCheckCommand,
  });
  const outcome = await advanceOneStep(db, ticketId, registry2); // checks:dispatch (scoped)
  const checksAfter = listAcChecks(db, ticketId);
  const stepAfter = getByKey(db, ticketId, "checks:dispatch");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(stepAfter?.status).toBe("succeeded");
  expect(checksAfter.length).toBe(2);

  const ac1CheckAfter = checksAfter.find((c) => c.ac_id === 1);
  const ac2CheckAfter = checksAfter.find((c) => c.ac_id === 2);
  expect(ac1CheckAfter).toBeDefined();
  expect(ac2CheckAfter).toBeDefined();

  // AC-1's row was replaced (new id, new test path) — the flagged AC IS re-authored.
  expect(ac1CheckAfter?.id).not.toBe(ac1CheckBefore?.id);
  expect(ac1CheckAfter?.test_path).toBe("checks/ac1_v2.py");

  // AC-2's row (id, selector, classification) is FROZEN — untouched by the scoped re-author.
  expect(ac2CheckAfter?.id).toBe(ac2CheckBefore?.id);
  expect(ac2CheckAfter?.test_path).toBe(ac2CheckBefore?.test_path);
  expect(ac2CheckAfter?.red_class).toBe("assertion");
});

test("checks:dispatch scoped re-author is insert-only (deleteActiveByAc): a crash-resume re-run dedupes its own fresh insert without touching superseded history or the escalate counter", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] first thing\n- [ ] second thing\n",
    ticketId,
  );
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-chwt-resume-"));
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
  });
  const runCheckCommand = async () => ({
    exitCode: 1,
    stdout: "1 failed",
    stderr: "",
    timedOut: false,
  });

  // Round 1: fresh dispatch — whole-ticket author, both ACs covered.
  const runner1 = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1.py"), "def test_ac1():\n    assert False\n");
    writeFileSync(join(dir, "ac2.py"), "def test_ac2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"},' +
        '{"ac_id":2,"test_file":"checks/ac2.py","test_name":"test_ac2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry1 = buildDispatchRegistry({
    runner: runner1,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
    runCheckCommand,
  });
  await advanceOneStep(db, ticketId, registry1); // provision
  await advanceOneStep(db, ticketId, registry1); // checks:dispatch (whole-ticket)

  const checksRound1 = listAcChecks(db, ticketId);
  const ac1Round1 = checksRound1.find((c) => c.ac_id === 1);
  const ac2Round1 = checksRound1.find((c) => c.ac_id === 2);
  expect(ac1Round1).toBeDefined();
  expect(ac2Round1).toBeDefined();

  // Simulate the verdict (Task 3d): it SUPERSEDES AC-1's round-1 row (never deletes it) — the one
  // round the escalate counter must see, and the baseline `reauthorRoundsForAc` must stay pinned at.
  supersedeByAc(db, 1);
  expect(reauthorRoundsForAc(db, 1)).toBe(1);

  // The verdict's loopback flags ONLY AC-1 for re-authoring.
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "checks",
    routeTo: "checks:classify",
    signature: "checks:1",
    payload: { acIds: [1], findings: [{ acId: 1, reason: "prior check was vacuous" }] },
  });
  const dispatchStep = getByKey(db, ticketId, "checks:dispatch");
  if (!dispatchStep) throw new Error("checks:dispatch step missing before scoped round");

  // Round 2: the scoped re-author dispatch inserts a fresh active AC-1 check.
  const runner2 = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1_v2.py"), "def test_ac1_v2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1_v2.py","test_name":"test_ac1_v2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry2 = buildDispatchRegistry({
    runner: runner2,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
    runCheckCommand,
  });
  resetToPending(db, dispatchStep.id);
  await advanceOneStep(db, ticketId, registry2); // checks:dispatch (scoped, first run)

  const activeAc1AfterFirstRun = listActiveByAc(db, 1);
  expect(activeAc1AfterFirstRun.length).toBe(1);
  const ac1FirstFreshInsert = activeAc1AfterFirstRun[0];
  expect(ac1FirstFreshInsert?.id).not.toBe(ac1Round1?.id);
  expect(ac1FirstFreshInsert?.test_path).toBe("checks/ac1_v2.py");
  expect(reauthorRoundsForAc(db, 1)).toBe(1); // dispatch never supersedes — round count untouched

  // Simulate a crash-resume: the SAME round's dispatch step is re-run (no new loopback, no new
  // supersede) — it must dedupe its own not-yet-classified active insert, not double-insert.
  const runner3 = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1_v2.py"), "def test_ac1_v2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1_v2.py","test_name":"test_ac1_v2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry3 = buildDispatchRegistry({
    runner: runner3,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
    runCheckCommand,
  });
  resetToPending(db, dispatchStep.id);
  await advanceOneStep(db, ticketId, registry3); // checks:dispatch (scoped, resumed)

  const activeAc1AfterResume = listActiveByAc(db, 1);
  const checksAfterResume = listAcChecks(db, ticketId);
  const ac2AfterResume = checksAfterResume.find((c) => c.ac_id === 2);
  const roundsAfterResume = reauthorRoundsForAc(db, 1);
  db.close();

  // Exactly ONE active AC-1 row survives the resume — the resume's deleteActiveByAc cleared the
  // first run's fresh insert before inserting its own.
  expect(activeAc1AfterResume.length).toBe(1);
  expect(activeAc1AfterResume[0]?.id).not.toBe(ac1FirstFreshInsert?.id);
  expect(roundsAfterResume).toBe(1); // resume did NOT inflate the round counter

  // AC-2 (never flagged) is untouched by either scoped round.
  expect(ac2AfterResume?.id).toBe(ac2Round1?.id);
  expect(ac2AfterResume?.test_path).toBe(ac2Round1?.test_path);
});

test("checks:dispatch reconciles a divergent path: written under styre_checks/, declared flat → ac_check.test_path is the REAL written path", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] bug no longer reproduces\n",
    ticketId,
  );
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  const ident = (
    db.query("SELECT ident FROM ticket WHERE id = ?").get(ticketId) as { ident: string }
  ).ident;
  // ENG-296 discrepancy from the brief: deriveAndPersistAcs runs INSIDE the checks:dispatch handler
  // (not before), so the acceptance_criterion row doesn't exist yet at this point in the test — query
  // acId lazily inside the FakeAgentRunner callback, which only runs once the handler has dispatched.
  const runner = new FakeAgentRunner((input) => {
    const acId = (
      db
        .query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1")
        .get(ticketId) as {
        id: number;
      }
    ).id;
    const dir = join(input.cwd, "tests", "styre_checks");
    mkdirSync(dir, { recursive: true });
    // WROTE the canonical name under styre_checks/, but DECLARE a flat, different path.
    writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_bug():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":${acId},"test_file":"tests/${ident}_ac${acId}_test.py","test_name":"test_bug"}]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  // Drive until checks:dispatch resolves (correct arg order: db, ticketId, registry). Stop on its
  // status so we don't over-advance into checks:classify/implement.
  for (let i = 0; i < 12; i++) {
    await advanceOneStep(db, ticketId, registry);
    if (getByKey(db, ticketId, "checks:dispatch")?.status === "succeeded") break;
  }

  const checks = listAcChecks(db, ticketId);
  expect(checks.length).toBe(1);
  expect(checks[0]?.test_path).toBe(`tests/styre_checks/${ident}_ac${checks[0]?.ac_id}_test.py`); // REAL written path, not declared
});

test("checks:dispatch backward-compat: non-canonical name declared correctly still works (no regression)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] bug no longer reproduces\n",
    ticketId,
  );
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // ENG-296 discrepancy from the brief: same as the divergence test above — deriveAndPersistAcs runs
  // inside the checks:dispatch handler, so query acId lazily inside the runner callback.
  const runner = new FakeAgentRunner((input) => {
    const acId = (
      db
        .query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1")
        .get(ticketId) as {
        id: number;
      }
    ).id;
    const dir = join(input.cwd, "tests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "regression_x.py"), "def test_x():\n    assert False\n"); // NON-canonical name
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":${acId},"test_file":"tests/regression_x.py","test_name":"test_x"}]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  for (let i = 0; i < 12; i++) {
    await advanceOneStep(db, ticketId, registry);
    if (getByKey(db, ticketId, "checks:dispatch")?.status === "succeeded") break;
  }

  const checks = listAcChecks(db, ticketId);
  expect(checks.length).toBe(1);
  expect(checks[0]?.test_path).toBe("tests/regression_x.py"); // fallback (b): declared path honored
});

test("checks:dispatch discards an undeclared loose file instead of rejecting", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  const ident = (
    db.query("SELECT ident FROM ticket WHERE id = ?").get(ticketId) as { ident: string }
  ).ident;

  // The agent authors the canonical (declared) RED-first test AND drops an undeclared loose
  // scratch file at the worktree root — not under styre_checks/, not declared, not canonical for
  // any other AC. checks:dispatch sets disposition:"discard" (Task 2), so this must be silently
  // discarded rather than rejecting the whole dispatch.
  const runner = new FakeAgentRunner((input) => {
    const acId = (
      db
        .query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1")
        .get(ticketId) as { id: number }
    ).id;
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_x():\n    assert False\n");
    writeFileSync(join(input.cwd, "scratch.py"), "# undeclared loose throwaway\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":${acId},` +
        `"test_file":"checks/${ident}_ac${acId}_test.py","test_name":"test_x"}]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-chwt-discard-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot,
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch

  const step = getByKey(db, ticketId, "checks:dispatch");
  const events = listEvents(db, ticketId);
  const worktreePath = join(worktreeRoot, ident);
  db.close();

  expect(outcome.kind).toBe("stepped"); // succeeded, not a retry/escalation
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(worktreePath, "scratch.py"))).toBe(false); // never committed, swept from disk
  const notes = events.filter((e) => e.reason?.startsWith("scope-discarded"));
  expect(notes.length).toBeGreaterThan(0);
});
