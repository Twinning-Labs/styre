import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import {
  classifyAcCheck,
  insertAcCheck,
  listByTicket as listAcCheckRows,
  listActiveByTicket as listActiveAcChecks,
} from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  insertSignal,
  latestReauthorAtSha,
  listByTicket as listSignals,
} from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import type { RegistryDeps } from "../../src/dispatch/handlers.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): { root: string; initSha: string } {
  const root = mkdtempSync(join(tmpdir(), "styre-arb-e2e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  const initSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
    .stdout.toString()
    .trim();
  return { root, initSha };
}

function head(repo: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
}

function commitAll(repo: string, message: string): string {
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-m", message], { cwd: repo });
  return head(repo);
}

function registryWith(
  repo: string,
  runner: FakeAgentRunner,
  runCheckCommand: RegistryDeps["runCheckCommand"],
) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb-e2e-wt-")),
    runCheckCommand,
  });
}

/** A python component scoped to `checks/**` only (mirrors verify-gate-e2e.test.ts). Listed FIRST so
 *  `impactedComponents(...)[0]` prefers it over "app" for check-file paths. */
const CHECKS_COMPONENT = { name: "checks", kind: "python", paths: ["checks/**"], commands: {} };

/** The "real code" component every implement no-op dispatch writes into — never touches `checks/`. */
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

/** A SECOND, distinct blocking finding (different location — review-verdict's no-progress detector
 *  signs on sorted `category:location`, so an identical-shaped finding on a 2nd round would be read
 *  as "no progress" and escalate for a DIFFERENT reason than the one Flow 6 tests). */
const blockingCodeFinding2 = sidecar(
  JSON.stringify({
    findings: [
      {
        severity: "major",
        category: "correctness",
        location: "src/b.ts:20",
        rationale: "unchecked array access",
        factors: null,
        deferral_candidate: false,
        work_unit_seq: 1,
      },
    ],
  }),
);

/** Seed one AC + one active `ac_check` (already graded `red_class='assertion'`) authored at
 *  `authoringSha`, with its check file committed unchanged into `repo` at `checks/ac1_test.py`.
 *  Mirrors verify-gate-e2e.test.ts's fixture of the same name. */
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

/** A scripted checks:dispatch-shaped author response: writes a new added test file into `input.cwd`
 *  and echoes a `checksAuthored` sidecar for `acId`. */
function authorResponse(acId: number, testFile: string, testName: string, body: string) {
  return (input: { cwd: string }) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, testFile.split("/").pop() as string), body);
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [{ ac_id: acId, test_file: testFile, test_name: testName }],
      })}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  };
}

/** A scripted checks:classify-shaped response: classifies whatever `ac_check_id` the prompt echoes
 *  as `cls`. */
function classifyResponse(cls: string, reason: string) {
  return (input: { prompt: string }) => {
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
        classifications: [{ ac_check_id: id, class: cls, reason }],
      })}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  };
}

/** A `checks:arbitrate`-shaped response: blames every echoed `ac_check_id` `code-wrong`. */
function codeWrongArbitration(
  checkIds: number[],
  reason = "the check faithfully encodes the AC; the code never satisfies it",
) {
  return {
    ...ok,
    stdout: sidecar(
      JSON.stringify({
        arbitrations: checkIds.map((id) => ({ ac_check_id: id, blame: "code-wrong", reason })),
      }),
    ),
  };
}

/** A `checks:arbitrate`-shaped response: blames EVERY `ac_check_id` the prompt echoes `check-wrong`
 *  (dynamic — works across however many rounds/checks are currently being arbitrated). */
function checkWrongArbitrationAll(reason: string) {
  return (input: { prompt: string }) => {
    const ids = [...input.prompt.matchAll(/ac_check_id=(\d+)/g)].map((m) => Number(m[1]));
    return {
      ...ok,
      stdout: sidecar(
        JSON.stringify({
          arbitrations: ids.map((id) => ({ ac_check_id: id, blame: "check-wrong", reason })),
        }),
      ),
    };
  };
}

function isClassifyPrompt(prompt: string): boolean {
  return prompt.includes("adjudicat") || prompt.includes("Checks to classify");
}

function isArbitratePrompt(prompt: string): boolean {
  return prompt.includes("Adjudicate blame");
}

function isAuthorPrompt(prompt: string): boolean {
  return prompt.includes("authoring acceptance checks");
}

function isReviewPrompt(prompt: string): boolean {
  return prompt.includes("independent code reviewer");
}

/** Drive `advanceOneStep` in a bounded loop, tolerating the (registered, but sometimes
 *  environment-sensitive) merge steps once a ticket has left `implement` — mirrors
 *  verify-gate-e2e.test.ts's Flow 4 pattern. Stops early on escalate or once `stopWhen` is true. */
async function driveToStopOrWaiting(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  registry: ReturnType<typeof buildDispatchRegistry>,
  stopWhen: (t: NonNullable<ReturnType<typeof getTicket>>) => boolean,
  maxIterations = 40,
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const t = getTicket(db, ticketId);
    if (!t) return;
    if (t.status === "waiting" || stopWhen(t)) return;
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch (err) {
      if (err instanceof Error && /merge:push|merge:pr-ensure/.test(err.message)) return;
      throw err;
    }
  }
}

test("checks:reauthor: RED-first-valid + assertion-classified re-author installs (supersede old, insert new active, fresh red-first at the reauthor sha)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo, initSha } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ? WHERE id = ?").run("ENG-1", ticketId);

  const ac = insertAc(db, { ticketId, seq: 1, text: "persists a pref", source: "checklist" });
  const oldCheck = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "checks/old_test.py::test_old",
    testPath: "checks/old_test.py",
    redFirstResult: "red",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: initSha, // §5.2: the frozen clean-HEAD baseline
    detail: {
      rawOutput: "",
      exitCode: 1,
      framework: "pytest",
      command: null,
      acCheckId: oldCheck.id,
    },
  });

  const roundSha = "ROUND-SHA-1";
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "reauthor", // FIX I1: NOT "checks" — a distinct label from the design-stage re-author loop.
    routeTo: "checks:reauthor",
    signature: `arbiter:${ac.id}`,
    payload: { acIds: [ac.id], sha: roundSha },
  });

  const runner = new FakeAgentRunner((input) => {
    if (isClassifyPrompt(input.prompt)) {
      return classifyResponse("assertion", "real behavioral assert")(input);
    }
    return authorResponse(
      ac.id,
      "checks/new_test.py",
      "test_new",
      "def test_new():\n    assert save_pref() == 1\n",
    )(input);
  });

  // RED at the baseline replay (pytest exit 1).
  const registry = registryWith(repo, runner, async () => ({
    exitCode: 1,
    stdout: "1 failed",
    stderr: "",
    timedOut: false,
  }));

  const handler = registry.resolve("checks:reauthor");
  if (!handler) throw new Error("checks:reauthor handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:reauthor",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "implement",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });

  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === oldCheck.id);
  const active = listActiveAcChecks(db, ticketId);
  const dispositions = latestReauthorAtSha(db, ticketId, roundSha);
  db.close();

  expect(oldRow?.superseded_at).not.toBeNull(); // the old (check-wrong) generation is superseded
  expect(active.length).toBe(1);
  expect(active[0]?.id).not.toBe(oldCheck.id); // a fresh row, never the superseded id
  expect(active[0]?.red_class).toBe("assertion");
  expect(dispositions).toEqual([{ acId: ac.id, acCheckId: oldCheck.id, disposition: "installed" }]);
});

test("checks:reauthor: a re-author that GREENS at the baseline replay is rejected — the old check stays active, no supersede", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo, initSha } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ? WHERE id = ?").run("ENG-1", ticketId);

  const ac = insertAc(db, { ticketId, seq: 1, text: "persists a pref", source: "checklist" });
  const oldCheck = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "checks/old_test.py::test_old",
    testPath: "checks/old_test.py",
    redFirstResult: "red",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: initSha,
    detail: {
      rawOutput: "",
      exitCode: 1,
      framework: "pytest",
      command: null,
      acCheckId: oldCheck.id,
    },
  });

  const roundSha = "ROUND-SHA-1";
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "reauthor",
    routeTo: "checks:reauthor",
    signature: `arbiter:${ac.id}`,
    payload: { acIds: [ac.id], sha: roundSha },
  });

  const runner = new FakeAgentRunner((input) => {
    if (isClassifyPrompt(input.prompt)) {
      // Should never be reached: a green-at-baseline replay rejects BEFORE classification.
      throw new Error("unexpected classify dispatch on a green-at-baseline re-author");
    }
    return authorResponse(
      ac.id,
      "checks/new_test.py",
      "test_new",
      "def test_new():\n    assert True\n",
    )(input);
  });

  // GREEN at the baseline replay (pytest exit 0) — the RED-first oracle rejects.
  const registry = registryWith(repo, runner, async () => ({
    exitCode: 0,
    stdout: "1 passed",
    stderr: "",
    timedOut: false,
  }));

  const handler = registry.resolve("checks:reauthor");
  if (!handler) throw new Error("checks:reauthor handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:reauthor",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "implement",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });

  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === oldCheck.id);
  const active = listActiveAcChecks(db, ticketId);
  const dispositions = latestReauthorAtSha(db, ticketId, roundSha);
  db.close();

  expect(oldRow?.superseded_at).toBeNull(); // NOT superseded — no silent pass
  expect(active.length).toBe(1);
  expect(active[0]?.id).toBe(oldCheck.id); // the old check is still the (only) active one
  expect(dispositions).toEqual([{ acId: ac.id, acCheckId: oldCheck.id, disposition: "rejected" }]);
});

// ─── Task 8: the whole arbiter loop, driven through the REAL resolver/registry (gate → arbitrate →
// reauthor across multiple advanceOneStep calls, exactly as the daemon would run it) ───────────────

test("Flow 1 — code-wrong loop: the arbiter blames from the REAL post-implement rawOutput trace (FIX I2), the re-code prompt carries the blame reason (gateFeedback), and the ticket escalates cleanly at GATE_ROUND_CAP", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F1",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  // Round 1 skips straight to the gate (mirrors verify-gate-e2e.test.ts): the unit already
  // "verified" once, seeded via a manual completed dispatch giving the gate its branch_head_sha.
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const { checkId } = seedGatedAssertionCheck(db, ticketId, commitA);
  const disp = insertDispatch(db, { ticketId, dispatchId: "seed-1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: commitA });

  const blameReason =
    "the check faithfully encodes the AC (201); the code returns 200 (assert 200 == 201)";
  let n = 0;
  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) return codeWrongArbitration([checkId], blameReason);
    n += 1;
    writeFileSync(join(input.cwd, `note-${n}.ts`), "export const x = 1;\n"); // never touches checks/
    return { ...ok, stdout: "{}" };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb1-wt-")),
    // The post-implement rerun stays red, carrying a distinctive real assertion trace.
    runCheckCommand: async () => ({
      exitCode: 1,
      stdout: "F\n...\nE   assert 200 == 201\n1 failed in 0.01s",
      stderr: "",
      timedOut: false,
    }),
  });

  await advanceOneStep(db, ticketId, registry); // provision (no-op)

  let finalOutcome: Awaited<ReturnType<typeof advanceOneStep>> | undefined;
  for (let i = 0; i < 40; i++) {
    finalOutcome = await advanceOneStep(db, ticketId, registry);
    if (finalOutcome.kind === "escalated") break;
  }

  const ticket = getTicket(db, ticketId);
  const blameSigs = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-blame");
  const arbitrateCalls = runner.inputs.filter((i) => isArbitratePrompt(i.prompt));
  const recodePromptSawFeedback = runner.inputs.some(
    (i) => !isArbitratePrompt(i.prompt) && i.prompt.includes(blameReason),
  );
  const arbiterLoopbackEvents = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "checks:arbitrate",
  );
  db.close();

  // Terminal: a clean, bounded escalate — NOT an advance.
  expect(finalOutcome?.kind).toBe("escalated");
  expect(ticket?.status).toBe("waiting");

  expect(blameSigs.length).toBeGreaterThan(0);
  for (const s of blameSigs) {
    expect(s.result).toBe("fail");
    expect(JSON.parse(s.detail_json ?? "{}").blame).toBe("code-wrong");
  }
  expect(arbiterLoopbackEvents.length).toBeGreaterThan(0);

  // FIX I2: the arbiter's captured dispatch prompt carries the REAL persisted `ac-check-post-implement`
  // rawOutput trace — not the literal coarse bucket string.
  expect(arbitrateCalls.length).toBeGreaterThan(0);
  expect(arbitrateCalls.some((i) => i.prompt.includes("assert 200 == 201"))).toBe(true);

  // gateFeedback threads the arbiter's blame reason into the re-code prompt.
  expect(recodePromptSawFeedback).toBe(true);
});

test("Flow 2 — check-wrong re-author installs: RED-first-validates at baseline, the gate re-runs GREEN at the re-author HEAD, the ticket advances past implement, and NO implement loopback ever fires (pure check-wrong; applyReauthorVerdict re-serves the gate directly)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F2",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
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

  let gateReruns = 0;
  const runCheckCommand: RegistryDeps["runCheckCommand"] = async (_cmd, opts) => {
    if (opts.cwd.includes("styre-baseline-wt-")) {
      // The re-author's clean-HEAD replay: RED → the RED-first oracle allows install.
      return { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false };
    }
    gateReruns += 1;
    // Round 1 (the ORIGINAL check) is still red; round 2 (the re-author, post-install) flips green.
    return gateReruns === 1
      ? { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }
      : { exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false };
  };

  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) {
      return checkWrongArbitrationAll(
        "the AC says 201; the check asserts 200 — the check contradicts the AC",
      )(input);
    }
    if (isClassifyPrompt(input.prompt)) {
      return classifyResponse("assertion", "real behavioral assert")(input);
    }
    if (isAuthorPrompt(input.prompt)) {
      return authorResponse(
        acId,
        "checks/reauthored1_test.py",
        "test_reauthored1",
        "def test_reauthored1():\n    assert False\n",
      )(input);
    }
    if (isReviewPrompt(input.prompt)) return { ...ok, stdout: cleanFindings };
    writeFileSync(join(input.cwd, "note.ts"), "export const x = 1;\n");
    return { ...ok, stdout: "{}" };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb2-wt-")),
    runCheckCommand,
  });

  await driveToStopOrWaiting(db, ticketId, registry, (t) => t.stage !== "implement");

  const ticket = getTicket(db, ticketId);
  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === checkId);
  const active = listActiveAcChecks(db, ticketId);
  const reauthorSigs = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-reauthor",
  );
  const gatePasses = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-gate" && s.result === "pass",
  );
  const implementLoopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement",
  );
  db.close();

  expect(ticket?.status).not.toBe("waiting");
  expect(ticket?.stage).not.toBe("implement"); // advanced implement → review (or beyond)

  expect(oldRow?.superseded_at).not.toBeNull(); // the check-wrong generation is superseded
  expect(active.length).toBe(1);
  expect(active[0]?.id).not.toBe(checkId); // a fresh row, never the superseded id

  expect(reauthorSigs.length).toBeGreaterThan(0);
  expect(
    reauthorSigs.some((s) => JSON.parse(s.detail_json ?? "{}").disposition === "installed"),
  ).toBe(true);

  expect(gatePasses.length).toBeGreaterThan(0);
  expect(implementLoopbacks.length).toBe(0); // pure check-wrong: never a real re-code loop
});

test("Flow 3 — a code-conforming re-author is REJECTED by the RED-first oracle: greens at baseline never installs, never supersedes, drives a real implement loopback, and escalates at the cap", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F3",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
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

  let authorRound = 0;
  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) {
      return checkWrongArbitrationAll(
        "the AC says 201; the check asserts 200 — the check contradicts the AC",
      )(input);
    }
    if (isClassifyPrompt(input.prompt)) {
      throw new Error(
        "unexpected classify dispatch: a green-at-baseline re-author must reject BEFORE classification",
      );
    }
    if (isAuthorPrompt(input.prompt)) {
      authorRound += 1;
      return authorResponse(
        acId,
        `checks/conforms${authorRound}_test.py`,
        `test_conforms${authorRound}`,
        `def test_conforms${authorRound}():\n    assert True\n`,
      )(input);
    }
    writeFileSync(join(input.cwd, "note.ts"), "export const x = 1;\n");
    return { ...ok, stdout: "{}" };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb3-wt-")),
    runCheckCommand: async (_cmd, opts) =>
      opts.cwd.includes("styre-baseline-wt-")
        ? { exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false } // GREENS at baseline → rejects
        : { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }, // the real gate rerun stays red
  });

  await advanceOneStep(db, ticketId, registry); // provision

  let finalOutcome: Awaited<ReturnType<typeof advanceOneStep>> | undefined;
  for (let i = 0; i < 40; i++) {
    finalOutcome = await advanceOneStep(db, ticketId, registry);
    if (finalOutcome.kind === "escalated") break;
  }

  const ticket = getTicket(db, ticketId);
  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === checkId);
  const active = listActiveAcChecks(db, ticketId);
  const reauthorSigs = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-reauthor",
  );
  const implementLoopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "checks:reauthor",
  );
  db.close();

  // Terminal: a clean, bounded escalate — NEVER an advance (the oracle blocks conforming the check
  // to the code).
  expect(finalOutcome?.kind).toBe("escalated");
  expect(ticket?.status).toBe("waiting");

  expect(oldRow?.superseded_at).toBeNull(); // NEVER superseded — no silent pass
  expect(active.length).toBe(1);
  expect(active[0]?.id).toBe(checkId); // the original check is still the only active one

  expect(reauthorSigs.length).toBeGreaterThan(0);
  expect(
    reauthorSigs.every((s) => JSON.parse(s.detail_json ?? "{}").disposition === "rejected"),
  ).toBe(true);
  // A rejected re-author drives a REAL re-code loop (any-rejected route), not a silent re-serve.
  expect(implementLoopbacks.length).toBeGreaterThan(0);
});

test("Flow 4 — AC-silent dispute: the arbiter correctly returns code-wrong when the AC is silent on the disputed detail; the check is NEVER re-authored, and the ticket escalates cleanly at the cap (never a false-green)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F4",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(
    join(repo, "checks", "ac1_test.py"),
    "def test_ac():\n    assert data['name'] == 'x'\n",
  );
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const { checkId } = seedGatedAssertionCheck(db, ticketId, commitA);
  const disp = insertDispatch(db, { ticketId, dispatchId: "seed-1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: commitA });

  const acSilentReason =
    "the AC is silent on the JSON key; the check's assertion conforms with the AC's stated behavior, so the code is at fault (hard rule #2)";
  let n = 0;
  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) return codeWrongArbitration([checkId], acSilentReason);
    n += 1;
    writeFileSync(join(input.cwd, `note-${n}.ts`), "export const x = 1;\n");
    return { ...ok, stdout: "{}" };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb4-wt-")),
    runCheckCommand: async () => ({
      exitCode: 1,
      stdout: "KeyError: 'name'",
      stderr: "",
      timedOut: false,
    }),
  });

  await advanceOneStep(db, ticketId, registry); // provision

  let finalOutcome: Awaited<ReturnType<typeof advanceOneStep>> | undefined;
  for (let i = 0; i < 40; i++) {
    finalOutcome = await advanceOneStep(db, ticketId, registry);
    if (finalOutcome.kind === "escalated") break;
  }

  const ticket = getTicket(db, ticketId);
  const blameSigs = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-blame");
  const reauthorSigs = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-reauthor",
  );
  const active = listActiveAcChecks(db, ticketId);
  db.close();

  expect(finalOutcome?.kind).toBe("escalated");
  expect(ticket?.status).toBe("waiting");

  expect(blameSigs.length).toBeGreaterThan(0);
  for (const s of blameSigs) {
    expect(JSON.parse(s.detail_json ?? "{}").blame).toBe("code-wrong");
    expect(JSON.parse(s.detail_json ?? "{}").reason).toBe(acSilentReason);
  }
  // Pure code-wrong: the check is never touched — no reauthor pipeline ever runs.
  expect(reauthorSigs.length).toBe(0);
  expect(active.length).toBe(1);
  expect(active[0]?.id).toBe(checkId); // the SAME check throughout — never silently conformed to code
});

test("Flow 5 — environmental-classify rejection: a re-author that RED-first-validates at baseline but classifies environmental is REJECTED (never installed) — belt-and-suspenders: a re-author can never un-gate via environmental->advisory", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F5",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
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

  let authorRound = 0;
  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) {
      return checkWrongArbitrationAll(
        "the AC says 201; the check asserts 200 — the check contradicts the AC",
      )(input);
    }
    if (isClassifyPrompt(input.prompt)) {
      return classifyResponse("environmental", "flaky external dependency")(input);
    }
    if (isAuthorPrompt(input.prompt)) {
      authorRound += 1;
      return authorResponse(
        acId,
        `checks/env${authorRound}_test.py`,
        `test_env${authorRound}`,
        `def test_env${authorRound}():\n    assert False\n`,
      )(input);
    }
    writeFileSync(join(input.cwd, "note.ts"), "export const x = 1;\n");
    return { ...ok, stdout: "{}" };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb5-wt-")),
    // RED both at the baseline replay (structurally installable) AND at the real gate rerun (stays
    // gated) — only the classify verdict (environmental) drives the rejection here.
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  await advanceOneStep(db, ticketId, registry); // provision

  let finalOutcome: Awaited<ReturnType<typeof advanceOneStep>> | undefined;
  for (let i = 0; i < 40; i++) {
    finalOutcome = await advanceOneStep(db, ticketId, registry);
    if (finalOutcome.kind === "escalated") break;
  }

  const ticket = getTicket(db, ticketId);
  const allChecks = listAcCheckRows(db, ticketId);
  const oldRow = allChecks.find((c) => c.id === checkId);
  const active = listActiveAcChecks(db, ticketId);
  const reauthorSigs = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-reauthor",
  );
  db.close();

  expect(finalOutcome?.kind).toBe("escalated");
  expect(ticket?.status).toBe("waiting");

  expect(oldRow?.superseded_at).toBeNull(); // never superseded — no install
  expect(active.length).toBe(1);
  expect(active[0]?.id).toBe(checkId);

  expect(reauthorSigs.length).toBeGreaterThan(0);
  expect(
    reauthorSigs.every((s) => JSON.parse(s.detail_json ?? "{}").disposition === "rejected"),
  ).toBe(true);
});

test("Flow 6 — counter no-false-escalate: repeated review loopbacks (nits) never accumulate toward the gate-round cap; the ticket still reaches merge, and the gate's attempt resets to ≤1 at every genuine pass (§6)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F6",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert True\n");
  commitAll(repo, "author check");

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  }); // pending: drives the REAL implement pipeline on every loopback round
  seedGatedAssertionCheck(db, ticketId, head(repo));

  let reviewAttempt = 0;
  let noteN = 0;
  const runner = new FakeAgentRunner((input) => {
    if (isReviewPrompt(input.prompt)) {
      reviewAttempt += 1;
      // Two DISTINCT nits, then clean — TWO real code loopbacks before the ticket is allowed to
      // merge. (Distinct locations: an identical-shaped 2nd finding would trip review-verdict's own
      // separate "no progress: identical review findings" no-op detector, not the §6 gate counter
      // this flow is about.)
      if (reviewAttempt === 1) return { ...ok, stdout: blockingCodeFinding };
      if (reviewAttempt === 2) return { ...ok, stdout: blockingCodeFinding2 };
      return { ...ok, stdout: cleanFindings };
    }
    noteN += 1;
    writeFileSync(join(input.cwd, `note-${noteN}.ts`), "export const x = 1;\n"); // never touches checks/
    return { ...ok, stdout: "{}" };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb6-wt-")),
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }), // always flips green
  });

  const gateAttemptsAtPass: number[] = [];
  let priorPassCount = 0;
  for (let i = 0; i < 40; i++) {
    const t = getTicket(db, ticketId);
    if (t?.stage === "merge") break;
    if (t?.status === "waiting") break; // safety: an unexpected escalate
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch (err) {
      if (err instanceof Error && /merge:push|merge:pr-ensure/.test(err.message)) break;
      throw err;
    }
    const passCount = listSignals(db, ticketId).filter(
      (s) => s.signal_type === "ac-check-gate" && s.result === "pass",
    ).length;
    if (passCount > priorPassCount) {
      gateAttemptsAtPass.push(getByKey(db, ticketId, "verify:checks-gate")?.attempt ?? -1);
      priorPassCount = passCount;
    }
  }

  const ticket = getTicket(db, ticketId);
  const codeLoopbackEvents = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement" && e.route_to === "review",
  );
  db.close();

  expect(ticket?.status).not.toBe("waiting"); // no MAX_TRANSITIONS deadlock, no escalate
  expect(ticket?.stage).toBe("merge");
  expect(codeLoopbackEvents.length).toBe(2); // both nits actually drove codeLoopback

  // The MONEY assertion (§6): THREE genuine gate passes (one per review round), each at attempt ≤ 1 —
  // the counter is reset on every review re-entry, so it never climbs toward GATE_ROUND_CAP from a
  // healthy review loop.
  expect(gateAttemptsAtPass.length).toBeGreaterThanOrEqual(3);
  expect(gateAttemptsAtPass.every((a) => a <= 1)).toBe(true);
});

test("Flow 7 — supersede + id-reuse healing: TWO consecutive check-wrong re-author generations never confuse ids or false-escalate; the second install advances cleanly with strictly-increasing, never-reused ids", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F7",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
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

  let gateReruns = 0;
  const runCheckCommand: RegistryDeps["runCheckCommand"] = async (_cmd, opts) => {
    if (opts.cwd.includes("styre-baseline-wt-")) {
      return { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }; // every replay RED → installs
    }
    gateReruns += 1;
    // round 1 (the original check) red; round 2 (the 1st re-author generation) STILL red (a second
    // generation is needed to heal); round 3 (the 2nd re-author generation) finally green.
    return gateReruns < 3
      ? { exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }
      : { exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false };
  };

  let authorRound = 0;
  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) {
      return checkWrongArbitrationAll("the AC says 201; the check asserts 200")(input);
    }
    if (isClassifyPrompt(input.prompt)) {
      return classifyResponse("assertion", "real behavioral assert")(input);
    }
    if (isAuthorPrompt(input.prompt)) {
      authorRound += 1;
      return authorResponse(
        acId,
        `checks/gen${authorRound}_test.py`,
        `test_gen${authorRound}`,
        `def test_gen${authorRound}():\n    assert False\n`,
      )(input);
    }
    if (isReviewPrompt(input.prompt)) return { ...ok, stdout: cleanFindings };
    writeFileSync(join(input.cwd, "note.ts"), "export const x = 1;\n");
    return { ...ok, stdout: "{}" };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb7-wt-")),
    runCheckCommand,
  });

  await driveToStopOrWaiting(db, ticketId, registry, (t) => t.stage !== "implement");

  const ticket = getTicket(db, ticketId);
  const allChecks = listAcCheckRows(db, ticketId).filter((c) => c.ac_id === acId);
  const superseded = allChecks.filter((c) => c.superseded_at !== null);
  const active = allChecks.filter((c) => c.superseded_at === null);
  const reauthorSigs = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-reauthor",
  );
  const installedCount = reauthorSigs.filter(
    (s) => JSON.parse(s.detail_json ?? "{}").disposition === "installed",
  ).length;
  const implementLoopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "implement",
  );
  db.close();

  expect(ticket?.status).not.toBe("waiting"); // no false escalate across the two generations
  expect(ticket?.stage).not.toBe("implement"); // advanced past implement

  expect(installedCount).toBe(2); // two genuine reauthor generations, BOTH installed
  expect(allChecks.length).toBe(3); // original + gen1 + gen2
  expect(superseded.length).toBe(2); // original + gen1 both superseded (never deleted)
  expect(superseded.some((c) => c.id === checkId)).toBe(true); // the ORIGINAL row is among the history
  expect(active.length).toBe(1); // exactly one active row survives: gen2
  expect(active[0]?.id).not.toBe(checkId); // the active row is never the original id

  const ids = allChecks.map((c) => c.id);
  expect(new Set(ids).size).toBe(3); // strictly distinct — never a reused id
  expect(active[0]?.id).toBe(Math.max(...ids)); // the active row is the NEWEST generation

  // Pure check-wrong across BOTH generations: never a real re-code loop, never a false escalate.
  expect(implementLoopbacks.length).toBe(0);
});

// ─── Task 12: the pure-code-wrong stuck-HEAD (commit-nothing) livelock — driven through the REAL
// driveToTerminal (the actual `styre run` terminal-detection loop, not just advanceOneStep), so the
// no-progress spin (or its fix) is observed exactly as an operator would see it. ────────────────────

test("Flow 8 — LIVENESS: a pure-code-wrong round where the re-implement commits NOTHING (HEAD frozen) escalates cleanly instead of spinning to no-progress", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const { root: repo } = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET ident = ?, stage = 'implement' WHERE id = ?").run(
    "ENG-1F8",
    ticketId,
  );

  mkdirSync(join(repo, "checks"), { recursive: true });
  writeFileSync(join(repo, "checks", "ac1_test.py"), "def test_ac():\n    assert False\n");
  const commitA = commitAll(repo, "author check");

  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  const { checkId } = seedGatedAssertionCheck(db, ticketId, commitA);
  const disp = insertDispatch(db, { ticketId, dispatchId: "seed-1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, disp.id, { outcome: "clean-success", branchHeadSha: commitA });

  const blameReason =
    "the check faithfully encodes the AC (201); the code returns 200 (assert 200 == 201)";
  const runner = new FakeAgentRunner((input) => {
    if (isArbitratePrompt(input.prompt)) return codeWrongArbitration([checkId], blameReason);
    // implement:dispatch (the re-code round) writes NOTHING — commitWorktree() sees a clean
    // worktree and returns the unchanged sha (`changed: false`). This is the reproduce-first
    // case: an empty diff is NOT a dispatch failure (handlers.ts:822), so HEAD never moves.
    return { ...ok, stdout: "{}" };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      checksSystem: "none",
      components: [CHECKS_COMPONENT, appComponent("true")],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-arb8-wt-")),
    // The real post-implement rerun stays red every round (HEAD never moves, so it must).
    runCheckCommand: async () => ({
      exitCode: 1,
      stdout: "F\n...\nE   assert 200 == 201\n1 failed in 0.01s",
      stderr: "",
      timedOut: false,
    }),
  });

  const r = await driveToTerminal(db, registry, {
    ticketId,
    config: DEFAULT_RUNTIME_CONFIG,
    ports: {
      issueTracker: fakeIssueTracker(),
      forge: fakeForge(),
      checks: fakeChecks("passing"),
    },
    profile: { checksSystem: "none" },
    cap: 25, // well below DEFAULT_CAP=200 — a clean escalate must land long before the global cap
  });

  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId);
  const gateStep = getByKey(db, ticketId, "verify:checks-gate");
  db.close();

  // The FIX: a clean, bounded escalate (`waiting` + `human_resume`) — NEVER `no-progress`. The gate
  // step's own `attempt` freezes below GATE_ROUND_CAP (proving this is NOT the gate's own cap check
  // catching it — the resolver detects the stuck replay before the cap is ever reached).
  expect(r.outcome).toBe("blocked");
  expect(ticket?.status).toBe("waiting");
  expect(pending.some((s) => s.signal_type === "human_resume")).toBe(true);
  expect(gateStep?.attempt ?? 0).toBeLessThan(3); // GATE_ROUND_CAP — never reached; not a cap escalate
});
