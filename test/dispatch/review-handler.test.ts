import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rv-"));
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
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rvwt-")),
  });
}

const sidecar = (json: string) => `Reviewed.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// Put the ticket at stage='review' with a unit present so the resolver routes to review.
function readyForReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
}

test("review handler files findings with daemon-computed blocks_ship", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        findings: [
          {
            severity: "major",
            category: "correctness",
            location: "src/a.ts:1",
            rationale: "bug",
            factors: null,
            deferral_candidate: false,
            work_unit_seq: 1,
          },
          {
            severity: "nit",
            category: "maintainability",
            location: null,
            rationale: "style",
            factors: null,
            deferral_candidate: false,
            work_unit_seq: null,
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
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  // Findings stay 'open' after code-loopback — round isolation is via dispatch-scoping,
  // not by mutating status. Both findings remain open.
  const open = listOpenByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "review");
  db.close();
  expect(open.length).toBe(2);
  const major = open.find((f) => f.severity === "major");
  expect(major?.blocks_ship).toBe(1); // daemon-computed
  expect(major?.work_unit_id).not.toBeNull(); // mapped from work_unit_seq=1
  expect(major?.status).toBe("open"); // findings stay open after loopback
  const nit = open.find((f) => f.severity === "nit");
  expect(nit?.blocks_ship).toBe(0);
  expect(nit?.status).toBe("open"); // findings stay open after loopback
  // step status is governed by the verdict (Task 5); here we only assert findings were written.
  expect(step).not.toBeNull();
});

test("review handler throws on an absent findings sidecar (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "no block here",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "review");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(open.length).toBe(0);
});
