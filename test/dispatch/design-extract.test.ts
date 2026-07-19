import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};

function registryFor(repo: string, runner: FakeAgentRunner, rc: unknown = ABSENT_RC) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
      runtimeContext: rc,
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")),
  });
}

const sidecar = (json: string) =>
  `Here is the breakdown.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// provision (hoisted) + design:dispatch must be 'succeeded' and stage 'design' so the resolver
// routes to design:extract.
function readyForExtract(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const p = insertPending(db, { ticketId, stepKey: "provision", stepType: "provision" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(p.id);
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
}

test("design:extract inserts units with the behavioral flag honored (carry)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          {
            seq: 1,
            kind: "backend",
            title: "logic",
            description: "d",
            behavioral: true,
            test_plan: "test the logic",
            files_to_touch: ["src/a.ts"],
            verify_check_types: ["test"],
            depends_on: [],
          },
          {
            seq: 2,
            kind: "docs",
            title: "readme",
            description: "d",
            behavioral: false,
            test_plan: null,
            files_to_touch: ["README.md"],
            verify_check_types: ["build"],
            depends_on: [1],
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
  const units = listByTicket(db, ticketId);
  const ticket = getTicket(db, ticketId);
  const step = getByKey(db, ticketId, "design:extract");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(units.length).toBe(2);
  expect(units[0]?.behavioral).toBe(1);
  expect(units[1]?.behavioral).toBe(0); // the carry: non-behavioral lands as 0, not the default 1
  expect(units[1]?.kind).toBe("docs");
  expect(ticket?.track).toBeNull(); // extract no longer sizes — design:size owns sizing now
});

test("design:extract fails the step when the sidecar is absent (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "I could not produce a breakdown.",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "design:extract");
  const units = listByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0);
});

test("design:extract fails the step when a flagged CDOT section is unaddressed", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          {
            seq: 1,
            kind: "backend",
            title: "x",
            description: "d",
            behavioral: false,
            test_plan: null,
            files_to_touch: ["src/x.ts"],
            verify_check_types: [],
            depends_on: [],
          },
        ],
        cdotImpact: { data: { applies: false, analysis: "" } }, // data flagged present, but empty
      }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const rc = { ...ABSENT_RC, data: { presence: "present", detail: "pg" } };
  await advanceOneStep(db, ticketId, registryFor(repo, runner, rc));
  const step = getByKey(db, ticketId, "design:extract");
  const units = listByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0); // gate runs before insert → nothing persisted
});

test("design:extract sets needs_docs when documentation impact applies", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          {
            seq: 1,
            kind: "backend",
            title: "x",
            description: "d",
            behavioral: true,
            test_plan: "t",
            files_to_touch: ["src/a.ts"],
            verify_check_types: ["test"],
            depends_on: [],
          },
        ],
        cdotImpact: { documentation: { applies: true, analysis: "update README" } },
      }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  // ABSENT_RC → docs absent → gate inert; applies:true still flips needs_docs.
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const ticket = getTicket(db, ticketId);
  const step = getByKey(db, ticketId, "design:extract");
  db.close();
  expect(step?.status).toBe("succeeded");
  expect(ticket?.needs_docs).toBe(1);
});

test("design:extract fails the step when completeness checks fail (behavioral, no test_plan)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          {
            seq: 1,
            kind: "backend",
            title: "x",
            description: "d",
            behavioral: true,
            test_plan: "",
            files_to_touch: ["src/a.ts"],
            verify_check_types: ["test"],
            depends_on: [],
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
  const step = getByKey(db, ticketId, "design:extract");
  const units = listByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0);
});
