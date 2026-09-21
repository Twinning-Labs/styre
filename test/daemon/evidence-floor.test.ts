import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { classifyAcCheck, insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertSignal, suiteDetail } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { carryVerifiedVerdictForward } from "../../src/dispatch/carry-forward.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { suiteReceipt } from "../../src/testing/suite-adapters.ts";
import {
  declaredSuiteRequirements,
  requirementsHash,
} from "../../src/testing/suite-requirements.ts";
import { makeTestDb } from "../helpers/db.ts";

/**
 * ENG-439 — THE EVIDENCE FLOOR, AT THE TRANSITION THAT MAKES THE CLAIM.
 *
 * EVERY test here drives `nextStepKey` (or `advanceOneStep` over it). That is not a style
 * preference. ENG-424's floor was tested by calling `applyAcCheckGateVerdict` directly, and one of
 * those tests asserted that "a ticket with NO ac-checks at all still faces the floor" — while the
 * resolver only schedules the step that floor lived in when the ticket HAS ac-checks. The test
 * proved a route production cannot take, and the hole it was meant to close stayed open on exactly
 * the ticket shape it named. A floor that lives on a transition can only be tested through the
 * thing that decides transitions.
 */

/** What a real `verify:integration` records: the jobs it ran, tagged with their kind. */
function ranJobs(...jobs: Array<[string, "build" | "test" | "repo", number]>) {
  return jobs.map(([label, kind, exitCode]) => ({ label, kind, exitCode, timedOut: false }));
}

async function succeed(db: Database, ticketId: number, stepKey: string) {
  await runStep(db, { ticketId, stepKey, stepType: "dispatch", execute: () => ({ ok: true }) });
}

/** A ticket in `implement` with one verified unit and a dispatch recording `sha` as the head —
 *  i.e. everything the resolver needs to be standing at the implement → review transition. */
async function atTheTransition(sha = "SHIP"): Promise<{ db: Database; ticketId: number }> {
  const { db, ticketId } = makeTestDb();
  setTicketStage(db, ticketId, "implement");
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  await succeed(db, ticketId, "provision");
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: sha });
  return { db, ticketId };
}

/** The advisory integration signal at `sha`. `jobs` is its run record. */
function integration(
  db: Database,
  ticketId: number,
  sha: string,
  result: "pass" | "fail",
  jobs: ReturnType<typeof ranJobs>,
  extra: Record<string, unknown> = {},
) {
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result,
    branchHeadSha: sha,
    detail: suiteDetail(jobs, { advisory: true, ...extra }),
  });
}

// ── A · the floor is reachable on the ticket shapes that skip the gate ────────

test("A: an EMPTY ticket description (no criteria at all) + nothing executed → escalate", async () => {
  // One of the two routes that author zero ac_check rows, and therefore never schedule
  // `verify:checks-gate`: a description `ac-checklist.ts` parses to nothing, which is only an
  // empty or whitespace-only one. (The other route is the test below. Note for anyone reading the
  // ticket: it lists "no parseable AC checklist" as a route and that is wrong — a non-empty
  // description always yields one `whole-description` criterion.)
  const { db, ticketId } = await atTheTransition();
  // integration RAN and recorded a verdict, which is all the resolver's §8c routing needs...
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const d = nextStepKey(db, ticketId);
  db.close();
  // ...but it is not evidence of anything having passed, and there is no AC to prove instead.
  expect(d.kind).toBe("escalate");
  expect(d).toMatchObject({ signature: "evidence-floor" });
  expect(d.kind === "escalate" && d.reason).toMatch(/verified nothing/);
});

test("A: the escalation is filed under its own signature, not the stuck-head one", async () => {
  // Both conditions reach `advance.ts` through the same descriptor. The signature used to be
  // hardcoded to `gate-stuck-head`, against step `verify:checks-gate` — which, on this exact
  // ticket, never ran at all. `event_log.signature` is the audit key for why a run stopped.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const outcome = await advanceOneStep(db, ticketId, new StepRegistry());
  const escalated = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  const ticket = getTicket(db, ticketId);
  const pending = listPending(db, ticketId).map((s) => s.signal_type);
  db.close();
  expect(outcome).toEqual({ kind: "escalated", stepKey: "verify:integration" });
  expect(escalated).toHaveLength(1);
  expect(escalated[0]?.signature).toBe("evidence-floor");
  expect(ticket?.stage).toBe("implement"); // never left the stage
  expect(ticket?.status).toBe("waiting");
  expect(pending).toContain("human_resume"); // → run-ticket reports paused/needs_you
});

test("A: a green integration at the shipping sha lets it through", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(
    db,
    ticketId,
    "SHIP",
    "pass",
    ranJobs(["api:build", "build", 0], ["api:test", "test", 0]),
  );
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

// ── B · a pass that executed nothing is not evidence ──────────────────────────

test("B: a reviewer-only degraded pass does not satisfy the floor", async () => {
  // handlers.ts writes `test`/`pass` with `{degraded:"reviewer-only"}` when every impacted stack
  // declared the check unavailable. Nothing ran. The old floor counted it.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "test",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: suiteDetail([], { degraded: "reviewer-only", unavailable: ["app"] }),
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("B: an inert-only pass ('no code gates ran') does not satisfy the floor", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "test",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: suiteDetail([], { reason: "inert-only", note: "no code gates ran" }),
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("B: an integration that ran only BUILD jobs does not satisfy the floor", async () => {
  // Compiling is not exercising. The kind is tagged by the producer, so this does not depend on
  // reading anything out of the label text. Note the deliberate asymmetry: a `repo` job DOES
  // count (see the repoCommand test below), so a repo whose only repo-wide command is a linter
  // satisfies the floor on a linter — the stated cost of not making the floor unsatisfiable for
  // every repo whose suite lives in `repoCommands`.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "pass", ranJobs(["api:build", "build", 0]));
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("B: a unit's REAL test sweep at the shipping sha does satisfy it", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["other:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "test",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: suiteDetail([{ component: "api", kind: "test", exitCode: 0 }], { advisory: true }),
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a failing integration does NOT count, even flagged `preexisting`", async () => {
  // An earlier version of this accepted `detail.preexisting === true` — "the suite ran and its
  // failure predates the change". The flag cannot carry that weight. `runAtBaseline` adds a
  // DETACHED worktree under tmpdir and runs the raw command there with nothing provisioned, so a
  // repo whose tests need an install exits 127 at the baseline and `preexistingFrom` maps every
  // non-zero exit to `true`. A suite this run genuinely broke is stamped pre-existing. ENG-457
  // owns the baseline re-run; until it is sound the floor must not read the flag.
  const { db, ticketId } = await atTheTransition();
  integration(
    db,
    ticketId,
    "SHIP",
    "fail",
    ranJobs(["api:test", "test", 0], ["old:test", "test", 1]),
    {
      preexisting: true,
    },
  );
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("D: a unit's pass at an EARLIER sha is not evidence about the sha being shipped", async () => {
  // The second unit has changed the code since the first unit's suite ran. Counting unit 1's pass
  // would certify HEAD on the strength of a run against code that no longer exists.
  const { db, ticketId } = await atTheTransition("SHIP");
  const u1 = insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "backend",
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  insertSignal(db, {
    ticketId,
    workUnitId: u1.id,
    signalType: "test",
    result: "pass",
    branchHeadSha: "EARLIER",
    detail: suiteDetail([{ component: "api", kind: "test", exitCode: 0 }], { advisory: true }),
  });
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

// ── C · per acceptance criterion, not per run ─────────────────────────────────

/** The gate's own verdict signal. Present on every real run that reaches the transition with
 *  ac-checks: the resolver refuses to fall through to integration until the gate has passed at the
 *  head. The floor is a SECOND question asked after it, never a replacement for it. */
function gatePassed(db: Database, ticketId: number, sha: string) {
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "ac-check-gate",
    result: "pass",
    branchHeadSha: sha,
    detail: { stillRed: [], tampered: [], advisory: [] },
  });
}

/** An AC plus its check, and (optionally) a green post-implement result for it at `sha`. */
function ac(db: Database, ticketId: number, seq: number, green: string | null) {
  const a = insertAc(db, { ticketId, seq, text: `criterion ${seq}`, source: "checklist" });
  const c = insertAcCheck(db, { ticketId, acId: a.id, selector: `s${seq}`, testPath: `t${seq}` });
  // `assertion` = a GATING class. The floor judges the same set `buildVerifyReport` does, so an
  // unclassified check gates nothing and would make every fixture here escalate for the wrong
  // reason.
  classifyAcCheck(db, { acCheckId: c.id, redClass: "assertion" });
  if (green !== null) {
    insertSignal(db, {
      ticketId,
      signalType: "ac-check-post-implement",
      result: "pass",
      branchHeadSha: green,
      detail: { acCheckId: c.id, acId: a.id, coarse: "green", outcome: "green" },
    });
  }
  return { a, c };
}

test("C: one green criterion out of three does NOT satisfy the floor for the other two", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  ac(db, ticketId, 1, "SHIP");
  ac(db, ticketId, 2, null);
  ac(db, ticketId, 3, null);
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  // Names the ones that were not proven, not just the count.
  expect(d.kind === "escalate" && d.reason).toMatch(/AC2/);
  expect(d.kind === "escalate" && d.reason).toMatch(/AC3/);
});

test("C: all three green, with no CLEAN suite result → advances on the AC channel alone", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  ac(db, ticketId, 1, "SHIP");
  ac(db, ticketId, 2, "SHIP");
  ac(db, ticketId, 3, "SHIP");
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a criterion whose check was DISPOSITIONED is not evidence — nothing executed for it", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const { c } = ac(db, ticketId, 1, null);
  db.query("UPDATE ac_check SET disposition = 'not-expressible' WHERE id = ?").run(c.id);
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  expect(d.kind === "escalate" && d.reason).toMatch(/no check that could gate it/);
});

test("a still-red ENVIRONMENTAL criterion does NOT escalate a run whose suite went green", async () => {
  // The non-repeal. `environmental` is an advisory class by design: the check could not execute,
  // the PR body says so. Promoting it to a hard block here would repeal that policy for every run
  // in one line, on an LLM adjudicator's label. Both design reviewers raised this independently.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "pass", ranJobs(["api:test", "test", 0]));
  const { a, c } = ac(db, ticketId, 1, null);
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: "SHIP",
    detail: {
      acCheckId: c.id,
      acId: a.id,
      coarse: "red",
      redClass: "environmental",
      outcome: "advisory-red",
    },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a criterion whose ONLY check is environmental is unproven even when it went green", async () => {
  // `post-implement-rerun.ts` records `outcome:"advisory-red"` with `coarse:"green"` when the
  // blocker cleared and the check passed. Tempting to count — it ran, it passed. It does not,
  // because `environmental` is not a gating class: the RED-first that would have proved the check
  // binds was an environment failure, so a later green establishes nothing about the code.
  // `buildVerifyReport` labels such a criterion `environmental`, never `verified`, and the floor
  // now judges the same set it does.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const a1 = insertAc(db, { ticketId, seq: 1, text: "criterion", source: "checklist" });
  const c1 = insertAcCheck(db, { ticketId, acId: a1.id, selector: "s1", testPath: "t1" });
  classifyAcCheck(db, { acCheckId: c1.id, redClass: "environmental" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: { acCheckId: c1.id, acId: a1.id, coarse: "green", outcome: "advisory-red" },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  expect(d.kind === "escalate" && d.reason).toMatch(/no check that could gate it — environmental/);
});

test("a repo whose only suite is a repoCommand satisfies the floor", async () => {
  // `repoCommands` is where a suite that spans components lives — `prompts/setup-discover.md`
  // offers `{"integration": "..."}` as its own example — and `verify:integration` tags those jobs
  // `kind: "repo"`. The first version of this accepted only `kind: "test"`, which reproduced, by a
  // different mechanism, the exact miss that tagging-at-the-producer was introduced to prevent:
  // such a repo could never satisfy the floor, and was told its suite had not run.
  const { db, ticketId } = await atTheTransition();
  integration(
    db,
    ticketId,
    "SHIP",
    "pass",
    ranJobs(["api:build", "build", 0], ["repo:integration", "repo", 0]),
  );
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a criterion proven by its assertion check is not failed by a DISPOSITIONED sibling", async () => {
  // One AC can own several active checks. Failing the criterion on the dispositioned one without
  // consulting the green one beside it made the escalation say "it never executed" about a
  // criterion that did — and contradicted the PR body, which labels the same AC `verified`.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const { a } = ac(db, ticketId, 1, "SHIP"); // assertion check, green at SHIP
  const sibling = insertAcCheck(db, { ticketId, acId: a.id, selector: "s1b", testPath: "t1b" });
  db.query("UPDATE ac_check SET disposition = 'satisfied' WHERE id = ?").run(sibling.id);
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("AC evidence is read at the sha the checks RAN at, not the head a docs commit moved to", async () => {
  // `docs:revise` runs after the gate and can commit. `carryVerifiedVerdictForward` carries the
  // gate and integration signals to the new head but NOT the post-implement ones, so reading AC
  // evidence at the ticket head would escalate every needs_docs ticket that committed docs.
  // Without this, mutating `acEvidenceSha` back to the ticket head survived the whole suite.
  const { db, ticketId } = await atTheTransition("SHIP");
  ac(db, ticketId, 1, "SHIP"); // proven at the sha the checks ran at
  gatePassed(db, ticketId, "SHIP");
  integration(db, ticketId, "SHIP", "pass", ranJobs(["api:build", "build", 0])); // build-only: NOT evidence
  await succeed(db, ticketId, "docs:revise");
  // ...the docs commit moves the head, and carry-forward stamps its two signals there.
  const d2 = insertDispatch(db, { ticketId, dispatchId: "d-docs", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d2.id, { outcome: "clean-success", branchHeadSha: "DOCS" });
  carryVerifiedVerdictForward(db, ticketId, "DOCS");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("A: ENG-426's shape — real criteria, ZERO checks authored, nothing executed", async () => {
  // THE motivating case, and the one the first version of this file claimed to cover with a
  // fixture that seeded no criteria at all — landing in the other branch entirely, with a
  // different message, while the assertion (/verified nothing/) matched both. A test whose title
  // names a route its fixture does not take is exactly what this file's header condemns.
  //
  // Here: `checks:dispatch` found no component able to execute a check and returned early
  // (handlers.ts), so the criteria exist and have no checks at all.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  insertAc(db, { ticketId, seq: 1, text: "returns 201", source: "checklist" });
  insertAc(db, { ticketId, seq: 2, text: "logs the id", source: "checklist" });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  // The per-AC branch, naming each unproven criterion — NOT the no-criteria branch.
  expect(d.kind === "escalate" && d.reason).toMatch(/AC1 \(no check was authored for it\)/);
  expect(d.kind === "escalate" && d.reason).toMatch(/AC2 \(no check was authored for it\)/);
});

test("a ledger written BEFORE this change still has a working integration channel", async () => {
  // `kind` did not exist until this commit, and `styre run --resume` against a pre-upgrade
  // checkpoint is supported — `park.ts` migrates the schema, which cannot backfill a JSON column.
  // Reading `kind` alone killed the integration channel on every such ledger and told the operator
  // the suite had never run while the record showed it had.
  const { db, ticketId } = await atTheTransition();
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "SHIP",
    // the pre-ENG-439 shape: label, exitCode, timedOut — no kind, no executed
    detail: {
      ran: [
        { label: "api:build", exitCode: 0, timedOut: false },
        { label: "api:test", exitCode: 0, timedOut: false },
      ],
      advisory: true,
    },
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a repo that declares no suite at all is told THAT, not to go fix its suite", async () => {
  // A green integration that ran only builds proves the repo has no test command and no
  // repoCommands — every declared job ran, and none of them could exercise anything. "Fix what
  // stopped the suite from running" is useless advice for a repo that never had one.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "pass", ranJobs(["api:build", "build", 0]));
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  expect(d.kind === "escalate" && d.reason).toMatch(/no component has a runnable `test` command/);
  expect(d.kind === "escalate" && d.reason).not.toMatch(/fix what stopped/);
});

test("ALL of a criterion's live checks must be green, not just one of them", async () => {
  // One AC can own several active checks. "Any" would let a trivially-green check vouch for a
  // criterion whose sibling check failed — finding C's defeat, one level down. The code comment
  // asserts this property; nothing asserted it back until now.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const { a } = ac(db, ticketId, 1, "SHIP"); // first check green at SHIP
  const second = insertAcCheck(db, { ticketId, acId: a.id, selector: "s1b", testPath: "t1b" });
  classifyAcCheck(db, { acCheckId: second.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: "SHIP",
    detail: { acCheckId: second.id, acId: a.id, coarse: "red", outcome: "gated-red" },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  expect(d.kind === "escalate" && d.reason).toMatch(new RegExp(`check ${second.id} did not come`));
});

test("AC evidence comes from the NEWEST round, not the first one recorded", async () => {
  // A gate round that went red, looped back and re-ran green at the current head must not be
  // judged on the measurements at the previous head.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "pass", ranJobs(["api:build", "build", 0])); // not evidence
  const a = insertAc(db, { ticketId, seq: 1, text: "criterion", source: "checklist" });
  const c = insertAcCheck(db, { ticketId, acId: a.id, selector: "s1", testPath: "t1" });
  classifyAcCheck(db, { acCheckId: c.id, redClass: "assertion" });
  for (const [sha, coarse] of [
    ["OLD", "red"],
    ["SHIP", "green"],
  ] as const) {
    insertSignal(db, {
      ticketId,
      signalType: "ac-check-post-implement",
      result: coarse === "green" ? "pass" : "fail",
      branchHeadSha: sha,
      detail: { acCheckId: c.id, acId: a.id, coarse, outcome: coarse },
    });
  }
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("the NEWEST integration signal at the head decides, not the first", async () => {
  // A re-run at an unchanged head appends a second signal. Reading the first would let a
  // superseded green vouch for a red re-run.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "pass", ranJobs(["api:test", "test", 0]));
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("suiteDetail cannot be talked into claiming an execution it has no record of", async () => {
  // `{...extra, ran, executed}` — extra FIRST. That spread order IS the protection, and it
  // silently survived the whole suite until this test existed.
  const { db, ticketId } = await atTheTransition();
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: suiteDetail([], {
      executed: true,
      ran: [{ label: "api:test", kind: "test", exitCode: 0 }],
      advisory: true,
    }),
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("a criterion proven by its gating check is not failed by a still-red ENVIRONMENTAL sibling", async () => {
  // The same disagreement the dispositioned-sibling fix closed, one class over, and missed by that
  // fix: `buildVerifyReport` judges on gating checks only and calls this criterion `verified`,
  // while the floor was requiring every undispositioned check green — environmental included.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const { a } = ac(db, ticketId, 1, "SHIP"); // gating check, green
  const env = insertAcCheck(db, { ticketId, acId: a.id, selector: "s1env", testPath: "t1env" });
  classifyAcCheck(db, { acCheckId: env.id, redClass: "environmental" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: "SHIP",
    detail: { acCheckId: env.id, acId: a.id, coarse: "red", outcome: "advisory-red" },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a gating check that could not START (coarse 'error') is not green", async () => {
  // `rerunOne` returns `coarse:"error"` when the component or framework cannot be resolved.
  // Reading `!== "green"` rather than `=== "red"` is what covers it; nothing asserted the
  // difference until now, and the producer writes it.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const a1 = insertAc(db, { ticketId, seq: 1, text: "criterion", source: "checklist" });
  const c1 = insertAcCheck(db, { ticketId, acId: a1.id, selector: "s1", testPath: "t1" });
  classifyAcCheck(db, { acCheckId: c1.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: "SHIP",
    detail: { acCheckId: c1.id, acId: a1.id, coarse: "error", outcome: "gated-red" },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("an all-green run record beside result:'fail' is not evidence (the A1 gate's shape)", async () => {
  // `verify:check` runs the component suites green, then the A1 behavioral gate overwrites
  // `result` to "fail" (behavioral-no-test / delivered-test-does-not-bind) while `ran` keeps every
  // zero exit. `isExecutedPass`'s `result !== "pass"` line is the only thing between that and a
  // false "verified"; it survived every mutation until this test.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "test",
    result: "fail",
    branchHeadSha: "SHIP",
    detail: suiteDetail([{ component: "api", kind: "test", exitCode: 0 }], {
      reason: "delivered-test-does-not-bind",
      advisory: true,
    }),
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("a legacy BUILD-ONLY ledger is not evidence either", async () => {
  // The legacy fallback reads labels because those rows carry nothing else. It must still draw the
  // same line: a pre-upgrade ledger whose integration ran only builds proves no more than a
  // current one does.
  const { db, ticketId } = await atTheTransition();
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: { ran: [{ label: "api:build", exitCode: 0, timedOut: false }], advisory: true },
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("a legacy ledger whose only suite is a repoCommand still counts", async () => {
  // The other direction of the same fallback — the miss that the `kind:"repo"` fix exists to
  // prevent, reproduced for pre-upgrade rows.
  const { db, ticketId } = await atTheTransition();
  insertSignal(db, {
    ticketId,
    workUnitId: null,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: {
      ran: [
        { label: "api:build", exitCode: 0, timedOut: false },
        { label: "repo:integration", exitCode: 0, timedOut: false },
      ],
      advisory: true,
    },
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("a run whose suite FAILED is told to fix the suite, not that it has none", async () => {
  // The negative half of the no-suite-declared diagnostic. The discriminator is that the sweep
  // PASSED — only then did every declared job run, so only then does "no test job present" mean
  // "this repo has none". Here the BUILD failed first and the sweep stopped, so no test job
  // appears in the record for a quite different reason, and saying "every job it had was a build"
  // would be a lie about a repo that has a suite.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:build", "build", 1]));
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  expect(d.kind === "escalate" && d.reason).toMatch(/fix what stopped the checks or the suite/);
  expect(d.kind === "escalate" && d.reason).not.toMatch(/offers the floor nothing it can read/);
});

test("a docs commit must not destroy the UNIT evidence channel it cannot carry", async () => {
  // `carryVerifiedVerdictForward` replicates the integration signal to the post-docs head but not
  // the per-unit sweeps. Pinning the unit channel to the head alone made the floor escalate a
  // ticket that had advanced moments earlier — integration non-green, unit sweep green, then a
  // docs commit. The carried signal names the head it came from and the unit channel follows it.
  const { db, ticketId } = await atTheTransition("PRE");
  integration(db, ticketId, "PRE", "fail", ranJobs(["api:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "test",
    result: "pass",
    branchHeadSha: "PRE",
    detail: suiteDetail([{ component: "api", kind: "test", exitCode: 0 }], { advisory: true }),
  });
  await succeed(db, ticketId, "docs:revise");
  const d2 = insertDispatch(db, { ticketId, dispatchId: "d-docs", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d2.id, { outcome: "clean-success", branchHeadSha: "DOCS" });
  integration(db, ticketId, "DOCS", "fail", ranJobs(["api:test", "test", 1]), {
    carriedForward: true,
    carriedFrom: "PRE",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("the carriedFrom hop reaches exactly the sha it names, not any older one", async () => {
  // The single guard on the docs-commit relaxation is the sha equality. Without it the hop becomes
  // "any unit pass this ticket ever recorded", which is defect D again — and it would be open on
  // every needs_docs ticket, the exact population the hop exists for.
  const { db, ticketId } = await atTheTransition("PRE");
  integration(db, ticketId, "PRE", "fail", ranJobs(["api:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "test",
    result: "pass",
    branchHeadSha: "MUCH-OLDER", // a third commit, not the one the carry names
    detail: suiteDetail([{ component: "api", kind: "test", exitCode: 0 }], { advisory: true }),
  });
  await succeed(db, ticketId, "docs:revise");
  const d2 = insertDispatch(db, { ticketId, dispatchId: "d-docs", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d2.id, { outcome: "clean-success", branchHeadSha: "DOCS" });
  integration(db, ticketId, "DOCS", "fail", ranJobs(["api:test", "test", 1]), {
    carriedForward: true,
    carriedFrom: "PRE",
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("a unit's NEWEST sweep at the head decides, not an earlier pass at the same head", async () => {
  // A re-implement that commits nothing leaves the head frozen — the state the resolver already
  // models as stuck-HEAD — so a pass and a later fail can sit at one sha. `.some()` would let the
  // superseded pass win, which is what the integration channel's `.at(-1)` already guards against.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  for (const result of ["pass", "fail"] as const) {
    insertSignal(db, {
      ticketId,
      workUnitId: 1,
      signalType: "test",
      result,
      branchHeadSha: "SHIP",
      detail: suiteDetail(
        [{ component: "api", kind: "test", exitCode: result === "pass" ? 0 : 1 }],
        {
          advisory: true,
        },
      ),
    });
  }
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("a criterion left with a rejected re-author is NOT proven, even when its check is green", async () => {
  // `checks:reauthor` records `disposition:"rejected"` and deliberately leaves the old check
  // active with its frozen `red_class`. A later implement round can turn it green — at which point
  // the shared gating set alone calls the criterion proven while `buildVerifyReport` labels it
  // `check-unreplaced`, "never verified", and drops `allClean`. The floor holding is what lets the
  // run reach the PR body that then contradicts it, so this is reachable end to end, not latent.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const { a, c } = ac(db, ticketId, 1, "SHIP"); // assertion check, green at SHIP
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "fail",
    branchHeadSha: "SHIP",
    detail: { acId: a.id, acCheckId: c.id, disposition: "rejected" },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
  expect(d.kind === "escalate" && d.reason).toMatch(/rejected re-author/);
});

test("a green sweep of a NON-test check type is not test evidence", async () => {
  // A unit declares its own check types (free vocabulary), so `verify:check` writes a real
  // `suiteDetail(ran, …)` green record under `signalType: "build"` for a unit with
  // `["build","test"]`. The integration channel's mirror of this — `kind:"build"` excluded — is
  // pinned above; the per-unit channel's `signal_type === "test"` filter was not, and a mutation
  // relaxing it let a green BUILD sweep alone satisfy the floor.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  insertSignal(db, {
    ticketId,
    workUnitId: 1,
    signalType: "build",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: suiteDetail([{ component: "api", kind: "build", exitCode: 0 }], { advisory: true }),
  });
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d.kind).toBe("escalate");
});

test("an `absence`-class check gates its criterion, the same as an `assertion` one", async () => {
  // `classifyAcCheck` writes `absence` from two settled-red paths. Every other fixture here uses
  // `assertion`, so the second half of the shared gating predicate had nothing asserting it.
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["api:test", "test", 1]));
  const a1 = insertAc(db, { ticketId, seq: 1, text: "criterion", source: "checklist" });
  const c1 = insertAcCheck(db, { ticketId, acId: a1.id, selector: "s1", testPath: "t1" });
  classifyAcCheck(db, { acCheckId: c1.id, redClass: "absence" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: "SHIP",
    detail: { acCheckId: c1.id, acId: a1.id, coarse: "green", outcome: "green" },
  });
  gatePassed(db, ticketId, "SHIP");
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "advance", from: "implement", to: "review" });
});

test("an earlier green AC round cannot satisfy the floor at a changed untested head", async () => {
  const { db, ticketId } = await atTheTransition("NEW");
  ac(db, ticketId, 1, "OLD");
  // Routing facts at NEW do not themselves establish that the AC measurements still apply.
  gatePassed(db, ticketId, "NEW");
  integration(db, ticketId, "NEW", "pass", ranJobs(["api:build", "build", 0]));
  const decision = nextStepKey(db, ticketId);
  expect(decision).toMatchObject({ kind: "escalate", signature: "evidence-floor" });
  db.close();
});

test("a required browser suite cannot be excused by a green Python job", async () => {
  const { db, ticketId } = await atTheTransition();
  integration(db, ticketId, "SHIP", "fail", ranJobs(["python:test", "test", 0]), {
    requiredSuites: ["browser:test"],
  });
  expect(nextStepKey(db, ticketId)).toMatchObject({ signature: "evidence-floor" });
  db.close();
});

for (const passed of [true, false])
  test(`required browser suite documentation carry preserves ${passed ? "pass" : "failure"}`, async () => {
    const { db, ticketId } = await atTheTransition("PRE");
    const jobs = [
      {
        label: "browser:test",
        kind: "test" as const,
        exitCode: passed ? 0 : 1,
        timedOut: false,
        observation: {
          version: 1 as const,
          sha: "PRE",
          command: "npm test",
          cwd: "/repo",
          outcome: passed ? ("completed-zero" as const) : ("completed-nonzero" as const),
          exitCode: passed ? 0 : 1,
          timedOut: false,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          karma: {
            verdict: passed ? ("pass" as const) : ("fail" as const),
            completion: {
              version: 1 as const,
              browsers: [
                {
                  id: "1",
                  name: "Firefox",
                  completed: true,
                  runtimeErrors: 0,
                  success: passed ? 1 : 0,
                  failed: passed ? 0 : 1,
                  skipped: 0,
                  total: 1,
                  error: false,
                  disconnected: false,
                },
              ],
              success: passed ? 1 : 0,
              failed: passed ? 0 : 1,
              exitCode: passed ? 0 : 1,
              error: false,
              disconnected: false,
            },
          },
        },
      },
    ];
    const components = parseProfile({
      slug: "fixture",
      targetRepo: "/repo",
      components: [
        {
          name: "browser",
          kind: "node",
          paths: ["**"],
          commands: { test: "npm test" },
          testEnvironment: {
            version: 1,
            adapter: "karma",
            policy: "existing",
            suiteCommand: "npm test",
            manager: "npm",
            configFile: "karma.conf.js",
            browsers: ["Firefox"],
          },
        },
      ],
    }).components;
    const contract = declaredSuiteRequirements(components, "/repo");
    insertSignal(db, {
      ticketId,
      signalType: "suite-requirements",
      result: "pass",
      detail: contract,
    });
    const { karma, ...observation } = jobs[0].observation;
    const genericJobs = [
      {
        ...jobs[0],
        observation: {
          ...observation,
          suite: suiteReceipt(
            "npm test",
            "/repo",
            contract.requirements[0].binding,
            karma.completion,
            observation,
          ),
        },
      },
    ];
    insertSignal(db, {
      ticketId,
      signalType: "integration",
      result: passed ? "pass" : "fail",
      branchHeadSha: "PRE",
      detail: suiteDetail(genericJobs, {
        advisory: true,
        suiteRequirementsHash: requirementsHash(contract),
      }),
    });
    await succeed(db, ticketId, "docs:revise");
    const d = insertDispatch(db, { ticketId, dispatchId: "docs", seq: nextSeq(db, ticketId) });
    completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "DOCS" });
    carryVerifiedVerdictForward(db, ticketId, "DOCS");
    expect(nextStepKey(db, ticketId).kind).toBe(passed ? "advance" : "escalate");
    db.close();
  });

for (const kind of ["python", "node"] as const)
  test(`required ${kind} suite cannot be excused by green AC evidence or another passing job`, async () => {
    const { db, ticketId } = await atTheTransition();
    try {
      ac(db, ticketId, 1, "SHIP");
      gatePassed(db, ticketId, "SHIP");
      const components = parseProfile({
        slug: "fixture",
        targetRepo: "/repo",
        components: [
          {
            name: "required",
            kind,
            paths: ["**"],
            commands: { test: "test -f regression" },
            testPolicy: { suite: "required" },
          },
        ],
      }).components;
      const contract = declaredSuiteRequirements(components, "/repo");
      insertSignal(db, {
        ticketId,
        signalType: "suite-requirements",
        result: "pass",
        detail: contract,
      });
      integration(db, ticketId, "SHIP", "pass", ranJobs(["other:test", "test", 0]), {
        suiteRequirementsHash: requirementsHash(contract),
        requiredSuites: [],
      });
      expect(nextStepKey(db, ticketId)).toMatchObject({
        kind: "escalate",
        signature: "evidence-floor",
      });
    } finally {
      db.close();
    }
  });

test("resume at the transition synchronizes changed profile obligations before resolving", async () => {
  const { db, ticketId } = await atTheTransition();
  try {
    integration(db, ticketId, "SHIP", "pass", ranJobs(["other:test", "test", 0]));
    insertSignal(db, {
      ticketId,
      signalType: "suite-requirements",
      result: "pass",
      detail: { version: 1, requirements: [] },
    });
    expect(nextStepKey(db, ticketId)).toMatchObject({ kind: "advance" });
    const { buildDispatchRegistry } = await import("../../src/dispatch/handlers.ts");
    const { FakeAgentRunner } = await import("../../src/agent/fake-runner.ts");
    const { DEFAULT_AGENT_CONFIG } = await import("../../src/config/agent-config.ts");
    const registry = buildDispatchRegistry({
      profile: parseProfile({
        slug: "fixture",
        targetRepo: "/repo",
        components: [
          {
            name: "required",
            kind: "python",
            paths: ["**"],
            commands: { test: "python3 -m pytest" },
            testPolicy: { suite: "required" },
          },
        ],
      }),
      runner: new FakeAgentRunner(() => {
        throw Error("must not dispatch");
      }),
      agentConfig: DEFAULT_AGENT_CONFIG,
      worktreeRoot: "/new-checkout",
    });
    expect(await advanceOneStep(db, ticketId, registry)).toMatchObject({
      kind: "escalated",
      stepKey: "verify:integration",
    });
  } finally {
    db.close();
  }
});

for (const stage of ["review", "merge", "merge-after-push"] as const)
  test(`resume in ${stage} cannot publish with newly required unmeasured suites`, async () => {
    const { db, ticketId } = await atTheTransition();
    try {
      setTicketStage(db, ticketId, stage === "review" ? "review" : "merge");
      if (stage === "merge-after-push") await succeed(db, ticketId, "merge:push");
      integration(db, ticketId, "SHIP", "pass", ranJobs(["other:test", "test", 0]));
      const { buildDispatchRegistry } = await import("../../src/dispatch/handlers.ts");
      const { FakeAgentRunner } = await import("../../src/agent/fake-runner.ts");
      const { DEFAULT_AGENT_CONFIG } = await import("../../src/config/agent-config.ts");
      const registry = buildDispatchRegistry({
        profile: parseProfile({
          slug: "fixture",
          targetRepo: "/repo",
          components: [
            {
              name: "required",
              kind: "python",
              paths: ["**"],
              commands: { test: "python3 -m pytest" },
              testPolicy: { suite: "required" },
            },
          ],
        }),
        runner: new FakeAgentRunner(() => {
          throw Error("must not dispatch");
        }),
        agentConfig: DEFAULT_AGENT_CONFIG,
        worktreeRoot: "/new-checkout",
      });
      const outcome = await advanceOneStep(db, ticketId, registry);
      expect(outcome).toMatchObject({
        kind: "paused-noprogress",
        reason: expect.stringContaining("Required suites"),
      });
      expect(
        db.query("SELECT count(*) AS n FROM projection_outbox WHERE target='forge'").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
