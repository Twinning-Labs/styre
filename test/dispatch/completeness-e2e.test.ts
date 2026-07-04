import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import {
  getById as getWorkUnit,
  insertWorkUnit,
  listByTicket as listWorkUnits,
} from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ce-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

// A FakeAgentRunner whose Nth implement dispatch runs writers[N-1](cwd). A no-op writer ⇒ empty diff.
function sequencedRunner(writers: Array<(cwd: string) => void>): FakeAgentRunner {
  let call = 0;
  return new FakeAgentRunner((input) => {
    writers[call]?.(input.cwd);
    call++;
    return {
      completed: true,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
}

async function driveUntilCompleteness(
  db: Database,
  ticketId: number,
  registry: ReturnType<typeof buildDispatchRegistry>,
  unitId: number,
) {
  for (let i = 0; i < 14; i++) {
    if (listByUnit(db, unitId).some((s) => s.signal_type === "completeness")) return;
    await advanceOneStep(db, ticketId, registry);
  }
}

const disposition = (db: Database, unitId: number): string | undefined =>
  JSON.parse(
    listByUnit(db, unitId).find((s) => s.signal_type === "completeness")?.detail_json ?? "{}",
  ).disposition;

test("A1 darkreader: a redundant unit whose declared file a sibling touched is covered-by-sibling (no block)", async () => {
  // Also the min-seq-base regression guard: the cumulative base is the LOWEST-seq unit's
  // base_sha (the ticket fork point), not wu2's own base_sha. Reverting the handler to compare
  // against `unit.base_sha` instead of the min-seq unit's base_sha would flip wu2 from
  // covered-by-sibling to under-delivered, failing this test.
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  // wu1 declares+touches parse.ts (the real fix); wu2 declares parse.ts but produces an empty diff.
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["parse.ts"],
  });
  const wu2 = insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["parse.ts"],
    dependsOn: [1],
  });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "parse.ts"), "export const x = 1;\n"), // wu1
    () => {}, // wu2 → empty diff
  ]);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")),
  });

  await driveUntilCompleteness(db, ticketId, registry, wu2.id);
  const events = listEvents(db, ticketId);
  const d = disposition(db, wu2.id);
  db.close();
  expect(d).toBe("covered-by-sibling");
  expect(events.filter((e) => e.kind === "loopback").length).toBe(0);
});

test("A2 under-delivered: a unit that touches a file it did NOT declare loops back to implement", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const wu1 = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["src/x.ts"],
  });
  const runner = sequencedRunner([
    (cwd) => {
      // touches y.ts, never the declared x.ts
      Bun.spawnSync(["mkdir", "-p", join(cwd, "src")]);
      writeFileSync(join(cwd, "src", "y.ts"), "export const y = 1;\n");
    },
  ]);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")),
  });

  await driveUntilCompleteness(db, ticketId, registry, wu1.id);
  const sig = listByUnit(db, wu1.id).find((s) => s.signal_type === "completeness");
  db.close();
  expect(sig?.result).toBe("fail");
  expect(JSON.parse(sig?.detail_json ?? "{}").disposition).toBe("under-delivered");
  expect(JSON.parse(sig?.detail_json ?? "{}").under).toEqual(["src/x.ts"]);
});

test("over-delivery uses the unit's OWN diff, not the cumulative (guards the two-base split)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["a.ts"],
  });
  insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["b.ts"],
    dependsOn: [1],
  });
  const wu3 = insertWorkUnit(db, {
    ticketId,
    seq: 3,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["c.ts"],
    dependsOn: [2],
  });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "a.ts"), "1"),
    (cwd) => writeFileSync(join(cwd, "b.ts"), "1"),
    (cwd) => writeFileSync(join(cwd, "c.ts"), "1"), // wu3 touches only its declared c.ts
  ]);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")),
  });

  await driveUntilCompleteness(db, ticketId, registry, wu3.id);
  const scope = listByUnit(db, wu3.id).find((s) => s.signal_type === "scope_diff");
  db.close();
  // If `over` used the CUMULATIVE diff it would wrongly be [a.ts, b.ts]; the own-diff makes it [].
  expect(JSON.parse(scope?.detail_json ?? "{}").out_of_scope).toEqual([]);
});

test("A3' honest limit: unrelated work on a sibling-covered declared file is NOT caught (documents §7)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["auth.ts"],
  });
  const wu2 = insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["auth.ts"],
    dependsOn: [1],
  });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "auth.ts"), "1"), // wu1 touches auth.ts
    (cwd) => writeFileSync(join(cwd, "helpers.ts"), "1"), // wu2 does UNRELATED work; auth.ts sibling-covered
  ]);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")),
  });

  await driveUntilCompleteness(db, ticketId, registry, wu2.id);
  const d = disposition(db, wu2.id);
  db.close();
  // Documents the known limit (design §7): file-granularity + sibling coverage cannot see that
  // wu2's real auth.ts work was never done → under=∅, ownTouched≠∅ → completed-by-self → advances.
  // If this ever flips to "under-delivered", §7 must be revisited (it would mean the limit closed).
  expect(d).toBe("completed-by-self");
});

test("reconcile exemption: a reconcile unit with no declared files never comes back under-delivered", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const wu1 = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    filesToTouch: ["a.ts"],
  });
  const runner = sequencedRunner([
    (cwd) => writeFileSync(join(cwd, "a.ts"), "1"), // wu1
    () => {}, // reconcile unit — no fix needed, empty diff
  ]);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt-")),
  });

  // Drive wu1 all the way to verified before the reconcile unit is added (mirrors the real
  // integration-failure loopback in failure-policy.ts, which only inserts the reconcile unit
  // after the other units already exist).
  for (let i = 0; i < 14; i++) {
    if (getWorkUnit(db, wu1.id)?.status === "verified") break;
    await advanceOneStep(db, ticketId, registry);
  }

  // No filesToTouch ⇒ declared=∅, matching failure-policy.ts's reconcile-unit shape.
  const wu2 = insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "reconcile",
    verifyCheckTypes: [],
    dependsOn: [1],
  });
  await driveUntilCompleteness(db, ticketId, registry, wu2.id);
  const d = disposition(db, wu2.id);
  db.close();
  expect(d === "covered-by-sibling" || d === "completed-by-self").toBe(true);
});

// ── A6 plan gate ───────────────────────────────────────────────────────────────

const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
      runtimeContext: ABSENT_RC,
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-cewt6-")),
  });
}

const sidecar = (json: string) =>
  `Here is the breakdown.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// design:dispatch must be 'succeeded' and stage 'design' so the resolver routes to design:extract.
function readyForExtract(db: Database, ticketId: number) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
}

test("A6 plan gate: an extraction with files_to_touch: [] does not persist work units (re-dispatch)", async () => {
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
            files_to_touch: [], // the plan-gate violation: no declared files
            verify_check_types: [],
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
  const units = listWorkUnits(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0);
});
