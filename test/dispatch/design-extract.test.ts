import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { makeTestDb } from "../helpers/db.ts";
import { STEP_TEST_TIMEOUT_MS, reachDesignStep } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

// The steps that dispatch an agent start a background leftover check (ENG-485 section 9.1); one
// still running when the test ends keeps the command temp folder.
afterEach(pendingLeftoverChecks);

function gitRepo(): string {
  const root = makeTempDir("styre-e-");
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, timeout: 30_000 });
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

function profileFor(repo: string, rc: unknown = ABSENT_RC, testFilePattern?: string) {
  return parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [
      {
        name: "app",
        kind: "node",
        paths: ["**"],
        commands: { test: "bun test" },
        testFilePattern,
      },
    ],
    runtimeContext: rc,
  });
}

const roots = new Map<string, string>();
function rootFor(repo: string): string {
  let root = roots.get(repo);
  if (root === undefined) {
    root = makeTempDir("styre-wtroot-");
    roots.set(repo, root);
  }
  return root;
}

function registryFor(
  repo: string,
  runner: FakeAgentRunner,
  rc: unknown = ABSENT_RC,
  testFilePattern?: string,
) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: profileFor(repo, rc, testFilePattern),
    worktreeRoot: rootFor(repo),
  });
}

const sidecar = (json: string) =>
  `Here is the breakdown.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// The real provision and design:dispatch steps run first (spec §8), so the resolver routes to
// design:extract and design:dispatch has recorded the plan digest design:extract's manifest reads.
async function readyForExtract(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  repo: string,
  rc: unknown = ABSENT_RC,
  testFilePattern?: string,
): Promise<void> {
  await reachDesignStep({
    db,
    ticketId,
    profile: profileFor(repo, rc, testFilePattern),
    worktreeRoot: rootFor(repo),
    target: "design:extract",
  });
}

test(
  "design:extract inserts units with the behavioral flag honored (carry)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForExtract(db, ticketId, repo);
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
              files_to_touch: ["src/a.ts", "test/a.test.ts"],
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
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract fails the step when the sidecar is absent (transport failure)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForExtract(db, ticketId, repo);
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
    expect(JSON.parse(step?.error_json ?? "{}").message).toContain(
      "design:extract sidecar absent: no ```styre-sidecar block found",
    );
    expect(units.length).toBe(0);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract fails the step when a flagged CDOT section is unaddressed",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    const rc = { ...ABSENT_RC, data: { presence: "present", detail: "pg" } };
    await readyForExtract(db, ticketId, repo, rc);
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
    await advanceOneStep(db, ticketId, registryFor(repo, runner, rc));
    const step = getByKey(db, ticketId, "design:extract");
    const units = listByTicket(db, ticketId);
    db.close();
    expect(step?.status).not.toBe("succeeded");
    expect(JSON.parse(step?.error_json ?? "{}").message).toContain(
      "design:extract CDOT gate failed: cdotImpact.data must be addressed",
    );
    expect(units.length).toBe(0); // gate runs before insert → nothing persisted
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract sets needs_docs when documentation impact applies",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForExtract(db, ticketId, repo);
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
              files_to_touch: ["src/a.ts", "test/a.test.ts"],
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
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract fails the step when completeness checks fail (behavioral, no test_plan)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForExtract(db, ticketId, repo);
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
              files_to_touch: ["src/a.ts", "test/a.test.ts"],
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
    expect(JSON.parse(step?.error_json ?? "{}").message).toContain(
      "design:extract completeness failed: unit seq 1 is behavioral but has no test_plan",
    );
    expect(units.length).toBe(0);
  },
  STEP_TEST_TIMEOUT_MS,
);

for (const [testPath, pattern] of [
  ["testing/python/integration.py", undefined],
  ["checks/regression.py", "^checks/"],
] as const) {
  test(
    `design:extract persists a production fix with its ${testPath} test`,
    async () => {
      const { db, ticketId, projectId } = makeTestDb();
      const repo = gitRepo();
      db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
      await readyForExtract(db, ticketId, repo, ABSENT_RC, pattern);
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
            units: [
              {
                seq: 1,
                kind: "python",
                title: "Fix compat",
                description: "Regression",
                behavioral: true,
                test_plan: "Exercise decorated callable",
                files_to_touch: ["src/_pytest/compat.py", testPath],
                verify_check_types: ["test"],
                depends_on: [],
              },
            ],
          }),
        ),
      }));
      await advanceOneStep(db, ticketId, registryFor(repo, runner, ABSENT_RC, pattern));
      expect(getByKey(db, ticketId, "design:extract")?.status).toBe("succeeded");
      expect(listByTicket(db, ticketId)).toHaveLength(1);
      db.close();
    },
    STEP_TEST_TIMEOUT_MS,
  );
}
