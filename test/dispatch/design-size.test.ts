import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { makeTestDb } from "../helpers/db.ts";
import { unitsOf } from "../helpers/design-script.ts";
import { STEP_TEST_TIMEOUT_MS, reachDesignStep } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

// The steps that dispatch an agent start a background leftover check (ENG-485 section 9.1); one
// still running when the test ends keeps the command temp folder.
afterEach(pendingLeftoverChecks);

function gitRepo(): string {
  const root = makeTempDir("styre-sz-");
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, timeout: 30_000 });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function profileFor(repo: string) {
  return parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "node", paths: ["**"], commands: { test: "bun test" } }],
  });
}

const roots = new Map<string, string>();
function rootFor(repo: string): string {
  let root = roots.get(repo);
  if (root === undefined) {
    root = makeTempDir("styre-szwt-");
    roots.set(repo, root);
  }
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
  });
}

/** The real provision, design:dispatch and design:extract steps run first (spec §8), with
 *  `unitCount` backend units that are not behavioural; track stays null so design:size is the next
 *  step the resolver routes to. */
async function readyForSize(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  repo: string,
  unitCount: number,
  config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG,
): Promise<void> {
  // The snapshot says what this run hands its design steps (spec §4): the profile and config the
  // flow runs with, not makeTestDb's defaults, so a manifest records the inputs the step read.
  captureSnapshot(db, ticketId, {
    profile: profileFor(repo),
    unusableComponents: [],
    nonPrimaryComponents: [],
    config,
  });
  await reachDesignStep({
    db,
    ticketId,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
    target: "design:size",
    config,
    units: unitsOf(unitCount, { behavioral: false, dir: "src", ext: "ts" }).map((u) => ({
      ...u,
      verify_check_types: ["test"],
    })),
  });
}

test(
  "design:size (grader off) sizes by sprawl: 1 unit → fast",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForSize(db, ticketId, repo, 1);
    const runner = new FakeAgentRunner(() => {
      throw new Error("grader off: no agent should be dispatched");
    });
    await advanceOneStep(db, ticketId, registryFor(repo, runner)); // runs design:size
    const ticket = getTicket(db, ticketId);
    db.close();
    expect(ticket?.track).toBe("fast");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size (grader off) sizes by sprawl: 2 units → full",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForSize(db, ticketId, repo, 2);
    const runner = new FakeAgentRunner(() => {
      throw new Error("grader off: no agent should be dispatched");
    });
    await advanceOneStep(db, ticketId, registryFor(repo, runner));
    const ticket = getTicket(db, ticketId);
    db.close();
    expect(ticket?.track).toBe("full");
  },
  STEP_TEST_TIMEOUT_MS,
);

const sidecar = (json: string) => `Grade.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;
const gradeRunner = (overall: number) =>
  new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({ dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 }, overall }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
const ON = {
  config: { ...DEFAULT_RUNTIME_CONFIG, onPlanDefect: "escalate" as const, complexityGrading: true },
};

test(
  "grader on: low overall + 3 units → fast (bidirectional: simple multi-piece)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForSize(db, ticketId, repo, 3, ON.config);
    await advanceOneStep(db, ticketId, registryFor(repo, gradeRunner(2)), ON);
    const ticket = getTicket(db, ticketId);
    db.close();
    expect(ticket?.track).toBe("fast");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "grader on: high overall + 1 unit → full (the auth-one-file catch)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForSize(db, ticketId, repo, 1, ON.config);
    await advanceOneStep(db, ticketId, registryFor(repo, gradeRunner(8)), ON);
    const ticket = getTicket(db, ticketId);
    db.close();
    expect(ticket?.track).toBe("full");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "grader on: low overall but 5 units → full (sprawl floor backstop)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForSize(db, ticketId, repo, 5, ON.config);
    await advanceOneStep(db, ticketId, registryFor(repo, gradeRunner(1)), ON);
    const ticket = getTicket(db, ticketId);
    db.close();
    expect(ticket?.track).toBe("full");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "grader on: absent grade sidecar fails the step (transport failure)",
  async () => {
    const { db, ticketId, projectId } = makeTestDb();
    const repo = gitRepo();
    db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
    await readyForSize(db, ticketId, repo, 1, ON.config);
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
    await advanceOneStep(db, ticketId, registryFor(repo, runner), ON);
    const ticket = getTicket(db, ticketId);
    db.close();
    expect(ticket?.track).toBeNull(); // step threw before setting track
  },
  STEP_TEST_TIMEOUT_MS,
);
