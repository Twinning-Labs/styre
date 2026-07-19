import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listWorkUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

// This test proves the fix for Bug B (design-over-decomposition, the darkreader scenario)
// generically: a design:extract attempt that over-decomposes (a vacuous zero-files work unit)
// is rejected, and the retry — informed by the general dispatch retry-feedback primitive
// (run-dispatch.ts CL-RETRY) — recovers with a valid plan instead of blindly repeating the
// mistake until the attempt budget is exhausted.

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-erf-"));
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

// Reused from test/dispatch/design-extract.test.ts.
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

// Reused from test/dispatch/design-extract.test.ts.
const sidecar = (json: string) =>
  `Here is the breakdown.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// Reused from test/dispatch/design-extract.test.ts: design:dispatch must be 'succeeded' and stage
// 'design' so the resolver routes to design:extract. provision (hoisted to the top of case
// "design") must also be seeded done, or the resolver serves it first.
function readyForExtract(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const p = insertPending(db, { ticketId, stepKey: "provision", stepType: "provision" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(p.id);
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
}

// A vacuous extraction (the darkreader over-decomposition shape): the last unit declares no
// files to touch, which validateExtraction rejects.
const VACUOUS_UNITS = [
  {
    seq: 1,
    kind: "backend",
    title: "logic",
    description: "d",
    behavioral: false,
    test_plan: null,
    files_to_touch: ["src/a.ts"],
    verify_check_types: [],
    depends_on: [],
  },
  {
    seq: 2,
    kind: "docs",
    title: "redundant",
    description: "d",
    behavioral: false,
    test_plan: null,
    files_to_touch: [],
    verify_check_types: [],
    depends_on: [1],
  },
];

// A corrected, valid extraction: every unit names at least one file.
const VALID_UNITS = [
  VACUOUS_UNITS[0],
  {
    seq: 2,
    kind: "docs",
    title: "readme",
    description: "d",
    behavioral: false,
    test_plan: null,
    files_to_touch: ["README.md"],
    verify_check_types: [],
    depends_on: [1],
  },
];

test("design:extract: an informed retry recovers from a vacuous over-decomposition (Bug B, darkreader)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);

  const runner = new FakeAgentRunner((input) => ({
    completed: true,
    exitCode: 0,
    stdout: input.prompt.includes("previous attempt")
      ? sidecar(JSON.stringify({ units: VALID_UNITS }))
      : sidecar(JSON.stringify({ units: VACUOUS_UNITS })),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));

  const registry = registryFor(repo, runner);
  let o: Awaited<ReturnType<typeof advanceOneStep>>;
  do {
    o = await advanceOneStep(db, ticketId, registry);
  } while (o.kind === "retry");

  const step = getByKey(db, ticketId, "design:extract");
  const units = listWorkUnits(db, ticketId);
  const events = listEvents(db, ticketId);
  db.close();

  // The retry recovered: design:extract succeeded, no escalation happened.
  expect(step?.status).toBe("succeeded");
  expect(units.length).toBe(2);
  expect(events.some((e) => e.kind === "escalated")).toBe(false);

  // The retry was INFORMED: attempt 2's prompt carries attempt 1's rejection.
  expect(runner.inputs.length).toBeGreaterThanOrEqual(2);
  expect(runner.inputs[1]?.prompt ?? "").toContain("previous attempt");
  expect(runner.inputs[1]?.prompt ?? "").toContain("no files_to_touch");
});

test("design:extract: a genuinely stuck agent still escalates on attempt exhaustion", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);

  // Emits the same vacuous extraction on every attempt, informed retry or not.
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(JSON.stringify({ units: VACUOUS_UNITS })),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));

  const registry = registryFor(repo, runner);
  let o: Awaited<ReturnType<typeof advanceOneStep>>;
  do {
    o = await advanceOneStep(db, ticketId, registry);
  } while (o.kind === "retry");

  const events = listEvents(db, ticketId);
  const ticket = getTicket(db, ticketId);
  db.close();

  expect(o.kind).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  const escalation = events.find((e) => e.kind === "escalated");
  expect(escalation).toBeDefined();
  expect(escalation?.reason).toBe("step 'design:extract' failed");
});
