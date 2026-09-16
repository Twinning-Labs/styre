import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dr-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "node", paths: ["**"], commands: { test: "bun test" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-drwt-")),
  });
}

const sidecar = (json: string) => `Reviewed the plan.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// provision (hoisted) + design:dispatch succeeded + units present + track=full → resolver routes
// to design:review.
function readyForDesignReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const p = insertPending(db, { ticketId, stepKey: "provision", stepType: "provision" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(p.id);
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "docs",
    title: "Release note (plan Task 3)",
    description: "Document enum serialization",
    filesToTouch: ["docs/releases/3.0.txt"],
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  setTicketTrack(db, ticketId, "full");
}

test("design:review files plan findings with review_kind=plan and daemon-computed blocks_ship", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        findings: [
          {
            // minor severity → computeBlocksShip returns 0 (non-blocking) → verdict is "clean"
            // → no redesign loopback → no cascade-delete → finding survives for inspection.
            severity: "minor",
            category: "decomposition",
            location: "plan:Task 2",
            rationale: "split",
            factors: null,
            deferral_candidate: false,
            work_unit_seq: 2,
          },
        ],
      }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const open = listOpenByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "design:review");
  const noteUnit = listByTicket(db, ticketId).find((u) => u.seq === 2);
  db.close();
  // Non-blocking finding → clean verdict → step stays succeeded, ticket stays in design.
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:review" });
  expect(step?.status).toBe("succeeded");
  // Handler assertion: exactly 1 open finding with the handler's distinguishing attributes.
  expect(open.length).toBe(1);
  expect(open[0].review_kind).toBe("plan"); // handler always files reviewKind="plan"
  expect(open[0].blocks_ship).toBe(0); // daemon-computed: minor → 0
  expect(open[0].work_unit_id).toBe(noteUnit?.id ?? null);
  // A plan can have Tasks 1/2/3 while extraction merges implementation + tests into seq 1.
  // The reviewer must receive the actual mapping, not invent a seq from the plan headings.
  expect(runner.inputs[0].prompt).toContain('"seq": 2');
  expect(runner.inputs[0].prompt).toContain('"title": "Release note (plan Task 3)"');
  expect(runner.inputs[0].prompt).toContain('"docs/releases/3.0.txt"');
});

test("design:review throws on an absent sidecar (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "no block",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "design:review");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(open.length).toBe(0);
});

test("design:review still rejects a plan heading number absent from stored units", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    stdout: sidecar(
      JSON.stringify({
        findings: [
          {
            severity: "minor",
            category: "completeness",
            location: "plan:Task 3",
            rationale: "Release note missing",
            factors: null,
            deferral_candidate: false,
            work_unit_seq: 3,
          },
        ],
      }),
    ),
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  expect(getByKey(db, ticketId, "design:review")?.status).not.toBe("succeeded");
  expect(listOpenByTicket(db, ticketId)).toHaveLength(0);
  db.close();
});
