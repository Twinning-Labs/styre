import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { classifyAcCheck, insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  insertSignal,
  listByTicket as listSignals,
} from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

/** A fresh git repo with one commit ("init") on `main`. Mirrors the other *-e2e.test.ts fixtures. */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-vge-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function head(repo: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
}

function commitAll(repo: string, message: string): string {
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-m", message], { cwd: repo });
  return head(repo);
}

/** A python component scoped to `checks/**` only — resolves `pytest` for the AC-check rerun
 *  harness's framework detection, with no real `commands` (never picked for a unit's real diff,
 *  since the check file is baseline/authored via a direct commit, never part of a unit's own diff).
 *  Listed FIRST so `impactedComponents(...)[0]` prefers it over "app" for the check path. */
const CHECKS_COMPONENT = { name: "checks", kind: "python", paths: ["checks/**"], commands: {} };

/** The "real code" component every implement dispatch writes into — a plain shell test command,
 *  never python, so `reuseAwareTestCommand`'s python-reuse probe never fires (kind !== "python"
 *  short-circuits it) and the advisory sweep stays a deterministic, fast shell command. */
function appComponent(testCmd: string) {
  return { name: "app", kind: "backend", paths: ["**"], commands: { test: testCmd } };
}

const ok = {
  completed: true as const,
  exitCode: 0,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
};

const sidecar = (json: string) => `Reviewed.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;
const cleanFindings = sidecar(JSON.stringify({ findings: [] }));
const blockingCodeFinding = sidecar(
  JSON.stringify({
    findings: [
      {
        severity: "major",
        category: "correctness",
        location: "src/a.ts:10",
        rationale: "null dereference",
        factors: null,
        deferral_candidate: false,
        work_unit_seq: 1,
      },
    ],
  }),
);

/** Seed one AC + one active `ac_check` (already graded `red_class='assertion'` — this suite drives
 *  the M4/M5 GATE, not the M2/M3 authoring/classification loop, which `checks-reauthor-e2e.test.ts`
 *  covers separately) authored at `authoringSha`, with its check file committed unchanged into
 *  `repo` at `checks/ac1_test.py`. Returns the AC id + the live ac_check id (the arbiter's
 *  `ac_check_id`). */
function seedGatedAssertionCheck(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  authoringSha: string,
): { acId: number; checkId: number } {
  const ac = insertAc(db, { ticketId, seq: 1, text: "does the thing", source: "checklist" });
  const check = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "'checks/ac1_test.py::test_ac'",
    testPath: "checks/ac1_test.py",
    redFirstResult: "red",
  });
  classifyAcCheck(db, { acCheckId: check.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: authoringSha,
    detail: {
      rawOutput: "",
      exitCode: 1,
      framework: "pytest",
      command: null,
      acCheckId: check.id,
    },
  });
  return { acId: ac.id, checkId: check.id };
}

/** A `FakeAgentRunner` reply for the `checks:arbitrate` prompt: blames every still-red check
 *  `code-wrong` (the M5 default per the prompt's hard rules — no positive AC contradiction here). */
function codeWrongArbitration(checkIds: number[]): { stdout: string } & typeof ok {
  return {
    ...ok,
    stdout: sidecar(
      JSON.stringify({
        arbitrations: checkIds.map((id) => ({
          ac_check_id: id,
          blame: "code-wrong",
          reason: "the check faithfully encodes the AC; the code never satisfies it",
        })),
      }),
    ),
  };
}

// ─── 1. The gate blocks a not-green assertion check: loopback then escalate ─────────────────────

test("the gate defers a not-green (behavioral) assertion check to the arbiter: code-wrong loops implement, repeated code-wrong escalates at the gate-round cap (M5)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  // The unit already "verified" once (round 1 skips straight to the gate); a manual dispatch row
  // gives the gate its branch_head_sha (mirrors resolver.test.ts / checks-gate-verdict.test.ts).
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const { acId, checkId } = seedGatedAssertionCheck(db, ticketId, commitA);
  const disp = insertDispatch(db, { ticketId, dispatchId: "seed-1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: commitA });

  let n = 0;
  const runner = new FakeAgentRunner((input) => {
    if (input.prompt.includes("Adjudicate blame for a still-red")) {
      return codeWrongArbitration([checkId]);
    }
    n += 1;
    writeFileSync(join(input.cwd, `note-${n}.ts`), "export const x = 1;\n"); // never touches checks/
    return { ...ok, stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["note-${n}.ts"]}\n\`\`\`` };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vge1-wt-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }), // stays red
  });

  const outcomeProvision = await advanceOneStep(db, ticketId, registry); // provision (no-op)
  expect(outcomeProvision.kind).toBe("stepped");

  // M5: a BEHAVIORAL still-red (assertion class, no tampering) DEFERS — the gate step still succeeds
  // ("stepped"), but the verdict is "clean" (no route) so the resolver serves the arbiter next.
  const outcomeGate1 = await advanceOneStep(db, ticketId, registry); // verify:checks-gate, round 1
  expect(outcomeGate1.kind).toBe("stepped");

  const gateSig1 = listSignals(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-gate")
    .at(-1);
  expect(gateSig1?.result).toBe("fail");
  expect(JSON.parse(gateSig1?.detail_json ?? "{}").stillRed).toEqual([acId]);

  const outcomeArbitrate1 = await advanceOneStep(db, ticketId, registry); // checks:arbitrate, round 1
  expect(outcomeArbitrate1.kind).toBe("loopback");

  const blameSig1 = listSignals(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-blame")
    .at(-1);
  expect(blameSig1?.result).toBe("fail");
  expect(JSON.parse(blameSig1?.detail_json ?? "{}").blame).toBe("code-wrong");

  const unitAfterLoopback = getUnit(db, unit.id);
  expect(unitAfterLoopback?.status).toBe("pending"); // the arbiter verdict resets all units (Task 5)
  const arbiterLoopbackEvents = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "checks:arbitrate",
  );
  expect(arbiterLoopbackEvents.length).toBe(1);

  // Drive further rounds (re-implement -> completeness -> verify:check -> gate -> arbitrate): the
  // check stays red and every blame is code-wrong -> bounded loopback, escalating once the gate-round
  // counter (verify:checks-gate attempt) reaches GATE_ROUND_CAP.
  let finalOutcome: Awaited<ReturnType<typeof advanceOneStep>> | undefined;
  for (let i = 0; i < 20; i++) {
    finalOutcome = await advanceOneStep(db, ticketId, registry);
    if (finalOutcome.kind === "escalated") break;
  }

  const ticket = getTicket(db, ticketId);
  db.close();

  expect(finalOutcome?.kind).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
});

// ─── 2. The integrity gate fails on a tampered check ─────────────────────────────────────────────

test("the integrity gate fails on a tampered check, even though the scripted re-run would read green", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert True\n");
  const commitA = commitAll(repo, "author check");

  // implement rewrote the check file after authoring — the M4 anti-pattern this gate closes.
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    pass  # weakened\n");
  const commitB = commitAll(repo, "tamper with the check");

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const { acId } = seedGatedAssertionCheck(db, ticketId, commitA);
  const disp = insertDispatch(db, { ticketId, dispatchId: "seed-1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: commitB });

  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => ({ ...ok, stdout: "{}" })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vge2-wt-")),
    // Would read GREEN if it were even trusted — the integrity violation must gate first (§2b).
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }),
  });

  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:checks-gate

  const integritySigs = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-integrity",
  );
  const gateSig = listSignals(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-gate")
    .at(-1);
  db.close();

  expect(outcome.kind).toBe("loopback");
  expect(integritySigs.length).toBeGreaterThan(0);
  expect(integritySigs[0]?.result).toBe("fail");
  expect(gateSig?.result).toBe("fail");
  const stillRed = (JSON.parse(gateSig?.detail_json ?? "{}").stillRed ?? []) as number[];
  expect(stillRed).toContain(acId);
});

// ─── 3. The advisory sweep (per-unit AND repo-wide) never blocks a passing gate ───────────────────

test("a passing AC-check gate advances implement->review despite both a failing component suite and a failing repo-wide integration (advisory, not gating)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert True\n");
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  }); // status: pending — the per-unit verify:check must genuinely run this time
  seedGatedAssertionCheck(db, ticketId, commitA);

  const runner = new FakeAgentRunner((input) => {
    if (input.prompt.includes("independent code reviewer")) {
      return { ...ok, stdout: cleanFindings };
    }
    writeFileSync(join(input.cwd, "note.ts"), "export const x = 1;\n");
    return { ...ok, stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["note.ts"]}\n\`\`\`` };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("false")], // the whole-suite command always fails
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vge3-wt-")),
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }), // AC-check flips green
  });

  for (let i = 0; i < 14; i++) {
    const t = getTicket(db, ticketId);
    if (t?.stage === "review") break;
    if (t?.status === "waiting") break; // safety: a wrongly-gating advisory sweep would escalate
    await advanceOneStep(db, ticketId, registry);
  }

  const ticket = getTicket(db, ticketId);
  const testSig = listSignals(db, ticketId).find((s) => s.signal_type === "test");
  const integrationSig = listSignals(db, ticketId).find((s) => s.signal_type === "integration");
  const gateSig = listSignals(db, ticketId)
    .filter((s) => s.signal_type === "ac-check-gate")
    .at(-1);
  db.close();

  expect(ticket?.stage).toBe("review"); // advanced despite BOTH advisory failures
  expect(ticket?.status).not.toBe("waiting");
  expect(testSig?.result).toBe("fail");
  expect(JSON.parse(testSig?.detail_json ?? "{}").advisory).toBe(true);
  expect(integrationSig?.result).toBe("fail");
  expect(JSON.parse(integrationSig?.detail_json ?? "{}").advisory).toBe(true);
  expect(gateSig?.result).toBe("pass");
});

// ─── 4. A code-loopback re-verifies (FIX 4 end-to-end): the gate genuinely re-runs, not a replay ──

test("a code-review loopback that moves HEAD re-runs verify:checks-gate (reset step, fresh signal) instead of replaying the stale pass, and does not hit MAX_TRANSITIONS", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert True\n");
  commitAll(repo, "author check");

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  }); // pending: drives the REAL implement pipeline both before and after the loopback
  seedGatedAssertionCheck(db, ticketId, head(repo));

  let reviewAttempt = 0;
  let noteN = 0;
  const runner = new FakeAgentRunner((input) => {
    if (input.prompt.includes("independent code reviewer")) {
      reviewAttempt += 1;
      return { ...ok, stdout: reviewAttempt === 1 ? blockingCodeFinding : cleanFindings };
    }
    noteN += 1;
    writeFileSync(join(input.cwd, `note-${noteN}.ts`), "export const x = 1;\n"); // never touches checks/
    return { ...ok, stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["note-${noteN}.ts"]}\n\`\`\`` };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vge4-wt-")),
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }), // always flips green
  });

  for (let i = 0; i < 30; i++) {
    const t = getTicket(db, ticketId);
    if (t?.stage === "merge") break;
    if (t?.status === "waiting") break; // safety: MAX_TRANSITIONS or an unexpected escalate
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch (err) {
      // Expected: the stage inline-advances review->merge, then merge:push has no handler in this
      // test registry (mirrors review-e2e.test.ts's Flow 1/2 pattern).
      if (err instanceof Error && err.message.includes("merge:push")) break;
      throw err;
    }
  }

  const ticket = getTicket(db, ticketId);
  const gatePasses = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-gate" && s.result === "pass",
  );
  const codeLoopbackEvents = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "review",
  );
  db.close();

  expect(ticket?.status).not.toBe("waiting"); // no MAX_TRANSITIONS deadlock, no escalate
  expect(ticket?.stage).toBe("merge");
  expect(codeLoopbackEvents.length).toBe(1); // the blocking finding actually drove codeLoopback
  // The MONEY assertion (FIX 4): TWO distinct gate passes at TWO distinct branch_head_shas — the
  // gate genuinely re-ran after the loopback moved HEAD, not a stale replay of the first pass.
  expect(gatePasses.length).toBeGreaterThanOrEqual(2);
  const shas = new Set(gatePasses.map((s) => s.branch_head_sha));
  expect(shas.size).toBeGreaterThanOrEqual(2);
});
