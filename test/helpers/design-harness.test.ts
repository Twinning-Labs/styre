import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { getInput } from "../../src/db/repos/ticket-input.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "./design-harness.ts";
import {
  ABSENT_RC,
  type ScriptStep,
  defaultScript,
  harnessProfileRaw,
  newCalls,
  scriptedRunner,
  sidecar,
  stepOfPrompt,
  unitsOf,
} from "./design-script.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  gitRepo,
  makeDesignTicket,
} from "./design-steps.ts";
import { makeTempDir } from "./temp.ts";

// Self tests of the design harnesses every later ENG-477 task builds on.

const repoRoot = join(import.meta.dir, "..", "..");

test("stepOfPrompt recognises every real prompt template and refuses anything else", () => {
  const templates: Array<[string, ScriptStep]> = [
    ["design.md", "design:dispatch"],
    ["design-extract.md", "design:extract"],
    ["design-complexity-grade.md", "design:size"],
    ["design-review.md", "design:review"],
    ["checks.md", "checks:dispatch"],
    ["implement.md", "implement"],
    ["review.md", "review"],
  ];
  for (const [file, step] of templates) {
    const text = readFileSync(join(repoRoot, "prompts", file), "utf8");
    expect({ file, step: stepOfPrompt(text) }).toEqual({ file, step });
  }
  expect(() => stepOfPrompt("You are something else")).toThrow("unrecognised prompt");
});

test("unitsOf builds behavioural units with their own test file, and plain ones without", () => {
  expect(unitsOf(2, { behavioral: true }).map((u) => u.files_to_touch)).toEqual([
    ["lib/u1.rb", "test/u1_test.rb"],
    ["lib/u2.rb", "test/u2_test.rb"],
  ]);
  const [ts] = unitsOf(1, { behavioral: true, dir: "src", ext: "ts" });
  expect(ts.files_to_touch).toEqual(["src/u1.ts", "src/u1.test.ts"]);
  expect(ts.verify_check_types).toEqual(["test"]);
  const [plain] = unitsOf(1, { behavioral: false, titleSuffix: " (again)" });
  expect(plain).toMatchObject({
    seq: 1,
    title: "Unit 1 (again)",
    behavioral: false,
    test_plan: null,
    files_to_touch: ["lib/u1.rb"],
    verify_check_types: [],
  });
});

test("defaultScript and harnessProfileRaw give the documented defaults", () => {
  const s = defaultScript({ grade: () => 2 });
  expect([s.ident, s.planFile(1), s.plan(1), s.grade(1), s.parkAt]).toEqual([
    "ENG-1",
    "eng-1-plan.md",
    "Plan body, version 1",
    2,
    null,
  ]);
  const p = harnessProfileRaw("/repo", "slug-x");
  expect(p).toMatchObject({ slug: "slug-x", targetRepo: "/repo", runtimeContext: ABSENT_RC });
});

test("sidecar wraps its value in the styre-sidecar fence", () => {
  const text = sidecar({ a: 1 });
  expect(text.match(/```styre-sidecar\n(.*)\n```/)?.[1]).toBe('{"a":1}');
});

const prompt = (step: string): string =>
  ({
    "design:dispatch": "You are designing ticket ENG-1",
    "design:size": "You are grading the COMPLEXITY",
    implement: "You are implementing work-unit 1 of ENG-1",
    review: "You are the independent code reviewer",
    "checks:dispatch": "You are authoring acceptance checks",
  })[step] ?? step;

const play = (runner: ReturnType<typeof scriptedRunner>, step: string, cwd: string) =>
  runner.run({ prompt: prompt(step), model: "m", allowedTools: [], cwd, timeoutMs: 1000 });

test("scriptedRunner writes the plan, and with renamePlan leaves only the newest file", async () => {
  const cwd = makeTempDir("styre-sr-");
  const calls = newCalls();
  const runner = scriptedRunner(
    defaultScript({ renamePlan: true, planFile: (n) => `p${n}.md`, plan: (n) => `v${n}` }),
    calls,
  );
  await play(runner, "design:dispatch", cwd);
  await play(runner, "design:dispatch", cwd);
  expect(readdirSync(join(cwd, "docs", "plans"))).toEqual(["p2.md"]);
  expect(readFileSync(join(cwd, "docs", "plans", "p2.md"), "utf8")).toBe(
    "---\nlinear: ENG-1\n---\n\nv2\n",
  );
  expect(calls.counts["design:dispatch"]).toBe(2);
  expect(calls.prompts.map((p) => p.step)).toEqual(["design:dispatch", "design:dispatch"]);
});

test("scriptedRunner implements a unit's files, grades, reviews, and refuses checks", async () => {
  const cwd = makeTempDir("styre-sr-");
  const runner = scriptedRunner(defaultScript(), newCalls());
  const first = await play(runner, "implement", cwd);
  expect(first.stdout).toContain('"new_files":["lib/u1.rb","test/u1_test.rb"]');
  const second = await play(runner, "implement", cwd);
  expect(second.stdout).toContain('"new_files":[]');
  expect(readFileSync(join(cwd, "lib", "u1.rb"), "utf8")).toBe(
    "# unit 1, implement call 1\n# implement call 2\n",
  );
  expect((await play(runner, "design:size", cwd)).stdout).toContain('"overall":6');
  expect((await play(runner, "review", cwd)).stdout).toContain('"findings":[]');
  await expect(play(runner, "checks:dispatch", cwd)).rejects.toThrow("not scripted");
});

test("scriptedRunner parks the first call of parkAt, or exactly the parkOnCall-th", async () => {
  const cwd = makeTempDir("styre-sr-");
  const outcome = (r: AgentRunResult) => (r.cause === "session-limit" ? "park" : "ok");
  const once = scriptedRunner(defaultScript({ parkAt: "design:size" }), newCalls());
  const a: string[] = [];
  for (let i = 0; i < 3; i++) a.push(outcome(await play(once, "design:size", cwd)));
  expect(a).toEqual(["park", "ok", "ok"]);
  const nth = scriptedRunner(defaultScript({ parkAt: "design:size", parkOnCall: 2 }), newCalls());
  const b: string[] = [];
  for (let i = 0; i < 3; i++) b.push(outcome(await play(nth, "design:size", cwd)));
  expect(b).toEqual(["ok", "park", "ok"]);
});

test(
  "makeDesignTicket and driveUntil walk the design steps through advanceOneStep",
  async () => {
    const seen: string[] = [];
    const t = makeDesignTicket({ repoSetup: (repo) => seen.push(repo) });
    expect(seen).toEqual([t.repo]);
    const d = await driveUntil(t, atStep("checks:dispatch"));
    expect(d).toMatchObject({ kind: "step", stepKey: "checks:dispatch" });
    expect(t.calls.counts).toMatchObject({
      "design:dispatch": 1,
      "design:extract": 1,
      "design:size": 0,
      "design:review": 1,
    });
    expect(existsSync(join(t.worktreeRoot, "ENG-1", "docs", "plans", "eng-1-plan.md"))).toBe(true);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "makeDesignTicket applies config and script options, and driveUntil gives up after maxSteps",
  async () => {
    const t = makeDesignTicket({ config: { complexityGrading: true }, script: { grade: () => 3 } });
    expect(
      JSON.parse(getInput(t.db, t.ticketId, "config.complexityGrading")?.value_json ?? ""),
    ).toBe(true);
    await driveUntil(t, atStep("checks:dispatch"));
    expect(t.calls.counts["design:size"]).toBe(1);
    await expect(driveUntil(t, () => false, 1)).rejects.toThrow(
      "driveUntil: no stop after 1 steps",
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

const harnesses: DesignHarness[] = [];
const make = (...args: ConstructorParameters<typeof DesignHarness>) => {
  const h = new DesignHarness(...args);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

test(
  "the harness's probe decides the host's tools: nothing found refuses the run (exit 69)",
  async () => {
    const h = make();
    h.probe = () => false;
    expect(await h.fresh()).toBe(69);
    expect(h.calls.prompts).toEqual([]);
    expect(existsSync(h.dbPath())).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "the harness pauses on a scripted session limit, resumes from its checkpoint, and inspects it",
  async () => {
    const h = make();
    expect(await h.fresh({ script: { parkAt: "design:extract" } })).toBe(75);
    const park = JSON.parse(readFileSync(join(h.checkpointDir(), "transcript.json"), "utf8"));
    expect(park.cause).toBe("session-limit");
    expect(existsSync(h.dbPath())).toBe(true);
    expect(h.dbPath()).toBe(join(h.checkpointDir(), "run.db"));
    expect(h.calls.counts["design:extract"]).toBe(1);
    expect(await h.resume({ inspect: true })).toBe(0);
    expect(h.stderr.join("")).toContain(`resume --inspect ${h.ident}`);
    expect(h.calls.counts["design:extract"]).toBe(1);
    expect(await h.resume()).toBe(75); // extract runs again, the run pauses at checks:dispatch
    expect(h.calls.counts["design:extract"]).toBe(2);
    expect(h.calls.counts["checks:dispatch"]).toBe(0); // the pause is the prerequisite, not an agent
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "the harness adopts a given repository and slug, and cleanup removes its folders",
  async () => {
    const repo = gitRepo("styre-dh-adopt-");
    const h = make("worktree", { slug: "harness-two", repoDir: repo });
    expect(h.repoDir).toBe(repo);
    expect(h.checkpointDir()).toContain("harness-two");
    expect(await h.fresh()).toBe(75);
    expect(h.calls.counts["checks:dispatch"]).toBe(0);
    expect(existsSync(h.dbPath())).toBe(true);
    expect(h.read((db, id) => getInput(db, id, "profile.slug")?.value_json)).toBe('"harness-two"');
    h.cleanup();
    for (const d of [h.stateRoot, h.configRoot, h.filesRoot, h.repoDir])
      expect(existsSync(d)).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "the harness captures a run's console.error and stdout, and each invocation starts empty",
  async () => {
    const h = make();
    expect(await h.fresh()).toBe(75);
    // run.ts prints its summary with console.error, which on Bun bypasses process.stderr.write
    expect(h.stderr.join("")).toContain("Paused — needs you to unblock it, then resume.");
    const ndjson = h.stdout.join("").trim().split("\n");
    expect(ndjson.length).toBeGreaterThan(0);
    expect(ndjson.map((l) => JSON.parse(l).type)).toContain("summary");
    expect(await h.resume({ inspect: true })).toBe(0);
    expect(h.stderr.join("")).toContain(`resume --inspect ${h.ident}`);
    expect(h.stderr.join("")).not.toContain("Paused — needs you");
    expect(h.stdout).toEqual([]);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "the harness reads its own ticket by ident, not the lowest id in the database",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-dh-other-"), "reuse.db");
    migrate(dbFile);
    const db = openDb(dbFile);
    const other = insertTicket(db, {
      projectId: insertProject(db, { slug: "other", targetRepo: "/tmp/other" }),
      ident: "OTHER-1",
      status: "waiting",
    });
    db.close();
    expect(await h.fresh({ db: dbFile })).toBe(75);
    const id = h.readAt(dbFile, (_db, ticketId) => ticketId);
    expect(id).not.toBe(other);
    expect(h.readAt(dbFile, (rdb, ticketId) => getTicket(rdb, ticketId)?.ident)).toBe("ENG-1");
  },
  HARNESS_TEST_TIMEOUT_MS,
);

describe("makeDesignTicket's database", () => {
  let kept: Database | null = null;
  test(
    "is open while the test runs",
    () => {
      kept = makeDesignTicket().db;
      expect(kept.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
    },
    STEP_TEST_TIMEOUT_MS,
  );
  test("is closed when the test ends", () => {
    expect(kept).not.toBeNull();
    expect(() => kept?.query("SELECT 1").get()).toThrow();
  });
});
