import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import {
  listByTicket as listAcCheckRows,
  reauthorRoundsForAc,
} from "../../src/db/repos/ac-check.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-re-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("green-on-HEAD check → vacuous → scoped re-author → repeated vacuous → escalate", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] persists a pref\n",
    ticketId,
  );

  // Seed design done + one unit + fast track so the resolver serves provision→checks:dispatch→classify.
  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  let file = 0;
  const runner = new FakeAgentRunner((input) => {
    // checks:dispatch authors a new test file; checks:classify returns a sidecar with no file write.
    const wantsSidecar =
      input.prompt.includes("adjudicat") || input.prompt.includes("Checks to classify");
    if (!wantsSidecar) {
      file += 1;
      const dir = join(input.cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `ac${file}.py`), "def test_ac():\n    assert True\n");
      return {
        completed: true,
        exitCode: 0,
        stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"checks/ac${file}.py","test_name":"test_ac"}]}\n\`\`\``,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Adjudicator: classify the (single) green check vacuous. Extract the ac_check_id from the prompt.
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"classifications":[{"ac_check_id":${id},"class":"vacuous","reason":"asserts True"}]}\n\`\`\``,
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rewt-")),
    // The authored check GREENS on clean HEAD (exit 0) → green-on-HEAD adjudication.
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }),
  });

  // Drive the loop until the ticket escalates (status=waiting) or a bound is hit.
  let escalated = false;
  for (let i = 0; i < 20; i++) {
    const t = getTicket(db, ticketId);
    if (t?.status === "waiting") {
      escalated = true;
      break;
    }
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch {
      // implement:dispatch etc. may throw once the loop would leave design — not expected before escalate.
    }
  }

  // Binding facts:
  // 1. The ticket escalated (repeated (ac_id,"vacuous") signature).
  expect(escalated).toBe(true);
  // 2. At least two checks-loopback events were appended (the scoped re-authors) before escalate.
  const checksLoopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  expect(checksLoopbacks.length).toBeGreaterThanOrEqual(1);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  expect(escalations.length).toBeGreaterThanOrEqual(1);
  db.close();
});

test("a weak classification (surface-only assertion) drives the same re-author loopback as vacuous, and escalates on a 2nd flag", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] returns the created record\n",
    ticketId,
  );

  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  let file = 0;
  const runner = new FakeAgentRunner((input) => {
    const wantsSidecar =
      input.prompt.includes("adjudicat") || input.prompt.includes("Checks to classify");
    if (!wantsSidecar) {
      file += 1;
      const dir = join(input.cwd, "checks");
      mkdirSync(dir, { recursive: true });
      // Status-only assertion — the exact shape Task 1's behavioral-assertion prompt discourages
      // and Task 2's `weak` flag exists to catch.
      writeFileSync(
        join(dir, `ac${file}.py`),
        "def test_ac():\n    assert resp.status_code == 201\n",
      );
      return {
        completed: true,
        exitCode: 0,
        stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"checks/ac${file}.py","test_name":"test_ac"}]}\n\`\`\``,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Adjudicator: the surface-only check is flagged `weak` — every round, same AC, same reason.
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"classifications":[{"ac_check_id":${id},"class":"weak","reason":"status-only"}]}\n\`\`\``,
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-weak-wt-")),
    // The authored check stays RED (a `weak` verdict is only valid on a red coarse bucket, §2/Task 2).
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  let escalated = false;
  for (let i = 0; i < 20; i++) {
    const t = getTicket(db, ticketId);
    if (t?.status === "waiting") {
      escalated = true;
      break;
    }
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch {
      // implement:dispatch etc. may throw once the loop would leave design — not expected before escalate.
    }
  }

  expect(escalated).toBe(true);
  // The re-author loopback fired (weak triggers it exactly like vacuous — §2/Task 3).
  const checksLoopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  expect(checksLoopbacks.length).toBeGreaterThanOrEqual(1);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  expect(escalations.length).toBeGreaterThanOrEqual(1);
  db.close();
});

test("supersede, not delete: a healed AC (vacuous -> re-author -> already-satisfied) is classified clean and does NOT re-appear in the finding set; the superseded row is preserved with a fresh (never-reused) id", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] persists a pref\n",
    ticketId,
  );

  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // Round 1's adjudicator wrongly flags the (green-on-HEAD) check vacuous; round 2's re-authored
  // check — content-identical, GREEN on HEAD exactly like round 1 — is correctly judged
  // already-satisfied. This models the anti-pattern's failure mode directly: under the OLD log-scan-
  // by-(reused)-id design, the healed AC would have stayed flagged (a stale round-1 log line pointing
  // at the reused id) and false-escalated on round 2. The M4 schema fix (SUPERSEDE + table-read finding
  // set) must instead read this AC as resolved.
  let round = 0;
  const runner = new FakeAgentRunner((input) => {
    const wantsSidecar =
      input.prompt.includes("adjudicat") || input.prompt.includes("Checks to classify");
    if (!wantsSidecar) {
      round += 1;
      const dir = join(input.cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `ac${round}.py`), "def test_ac():\n    assert True\n");
      return {
        completed: true,
        exitCode: 0,
        stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"checks/ac${round}.py","test_name":"test_ac"}]}\n\`\`\``,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    const cls = round === 1 ? "vacuous" : "already-satisfied";
    const reason =
      round === 1 ? "asserts True, no real behavior checked" : "now legitimately satisfied";
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"classifications":[{"ac_check_id":${id},"class":"${cls}","reason":"${reason}"}]}\n\`\`\``,
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-heal-wt-")),
    // Green-on-HEAD both rounds — only the ADJUDICATOR's judgment changes between rounds.
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }),
  });

  let advancedPastDesign = false;
  let escalated = false;
  for (let i = 0; i < 20; i++) {
    const t = getTicket(db, ticketId);
    if (t?.status === "waiting") {
      escalated = true;
      break;
    }
    if (t && t.stage !== "design") {
      advancedPastDesign = true;
      break;
    }
    await advanceOneStep(db, ticketId, registry);
  }

  const allChecks = listAcCheckRows(db, ticketId); // ALL rows, including superseded history
  const active = allChecks.filter((c) => c.superseded_at === null);
  const superseded = allChecks.filter((c) => c.superseded_at !== null);
  const acId = allChecks[0]?.ac_id as number;
  const rounds = reauthorRoundsForAc(db, acId);
  db.close();

  // The healed AC advanced cleanly — no false "no progress" escalate (the anti-pattern this milestone
  // fixes: under the old reused-id log-scan, round 2's healed check would have stayed flagged).
  expect(escalated).toBe(false);
  expect(advancedPastDesign).toBe(true);

  // Supersede, not delete: the round-1 (vacuous) row is still present, marked superseded.
  expect(superseded.length).toBe(1);
  expect(superseded[0]?.red_class).toBeNull();
  expect(superseded[0]?.disposition).toBeNull();

  // The fresh round-2 row is ACTIVE, resolved (disposition=satisfied), and — the id-reuse regression
  // this schema rework fixes — carries a NEW id, never the superseded row's (AUTOINCREMENT).
  expect(active.length).toBe(1);
  expect(active[0]?.disposition).toBe("satisfied");
  expect(active[0]?.id).toBeGreaterThan(superseded[0]?.id as number);

  expect(rounds).toBe(1); // exactly one re-author round happened before it healed
});
