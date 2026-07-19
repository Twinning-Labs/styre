import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-h-"));
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")),
  });
}

test("implement:dispatch runs the agent, commits, sets the unit verifying", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "impl.ts"), "export const y = 2;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["impl.ts"]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const afterUnit = getUnit(db, unit.id);
  const dispatches = listByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(afterUnit?.status).toBe("verifying");
  expect(step?.status).toBe("succeeded");
  expect(dispatches[0]?.model).toBe("claude-sonnet-4-6");
});

test("implement:dispatch with an empty diff succeeds the step (empty-diff gating moved to completeness)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const afterUnit = getUnit(db, unit.id);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  // implement:dispatch no longer has a postcondition on the diff — an empty diff dispatch now
  // succeeds; the plan gate guarantees non-empty declared files, and it is the completeness
  // step's under-delivery disposition (Task 7) that gates on an empty/insufficient diff.
  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(afterUnit?.status).toBe("verifying");
});

test("implement:dispatch escalates to the deep tier after a bounce-back", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  // simulate a prior bounce-back of this unit
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "implement",
    routeTo: "verify:wu1:test",
    signature: "x",
  });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "f.ts"), "export const y=2;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["f.ts"]}\n\`\`\``,
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
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-lbwt-")),
  });

  await advanceOneStep(db, ticketId, registry);
  const dispatches = listByTicket(db, ticketId);
  db.close();
  expect(dispatches.length).toBe(1);
  expect(dispatches[0]?.model).toBe("claude-opus-4-8"); // deep tier (escalated), not the standard sonnet
});

test("design:dispatch passes when the agent writes this ticket's plan", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'design' WHERE id = ?").run(ticketId);
  const ident = "ENG-1"; // makeTestDb seeds the ticket with ident ENG-1
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "docs", "plans"), { recursive: true });
    writeFileSync(
      join(input.cwd, "docs", "plans", `${ident}.md`),
      `---\nlinear: ${ident}\n---\n# Plan\n`,
    );
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
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const d = listByTicket(db, ticketId);
  db.close();
  expect(d.at(-1)?.outcome).toBe("clean-success");
});

test("design:dispatch fails the postcondition when no plan for this ticket exists", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'design' WHERE id = ?").run(ticketId);
  const runner = new FakeAgentRunner(() =>
    // writes NO plan
    ({
      completed: true,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    }),
  );
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const d = listByTicket(db, ticketId);
  db.close();
  expect(d.at(-1)?.outcome).toBe("postcondition-failed");
});

// --- implementDisposition: reject (default) vs discard, + the discard-mode sidecar guard ---------

test("implement:dispatch (default reject) rejects an undeclared loose file", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner((input) => {
    // A valid sidecar that declares NO new files — junk.py is undeclared.
    writeFileSync(join(input.cwd, "junk.py"), "# undeclared\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":[]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-implreject-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
    }),
    worktreeRoot,
  });

  const outcome = await advanceOneStep(db, ticketId, registry, { config: DEFAULT_RUNTIME_CONFIG });
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  const worktreePath = join(worktreeRoot, "ENG-1");
  db.close();

  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(worktreePath, "junk.py"))).toBe(false); // reverted, never committed
});

test("implement:dispatch honors implementDisposition=discard", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "impl.ts"), "export const y = 2;\n");
    writeFileSync(join(input.cwd, "junk.py"), "# undeclared throwaway\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["impl.ts"]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-impldiscard-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
    }),
    worktreeRoot,
  });
  const config = RuntimeConfigSchema.parse({ implementDisposition: "discard" });

  const outcome = await advanceOneStep(db, ticketId, registry, { config });
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  const events = listEvents(db, ticketId);
  const worktreePath = join(worktreeRoot, "ENG-1");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(worktreePath, "impl.ts"))).toBe(true); // declared file committed
  expect(existsSync(join(worktreePath, "junk.py"))).toBe(false); // undeclared throwaway discarded
  const notes = events.filter((e) => e.reason?.startsWith("scope-discarded"));
  expect(notes.length).toBeGreaterThan(0);
});

test("implement discard + malformed sidecar re-dispatches (transport failure), does not clean-success", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner((input) => {
    // A tracked-file EDIT only (no new file, so commitScope never rejects it) + a malformed sidecar.
    writeFileSync(join(input.cwd, "README.md"), "edited by agent\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: "```styre-sidecar\n{not valid json\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-implmalformed-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
    }),
    worktreeRoot,
  });
  const config = RuntimeConfigSchema.parse({ implementDisposition: "discard" });

  const outcome = await advanceOneStep(db, ticketId, registry, { config });
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  const dispatches = listByTicket(db, ticketId);
  const worktreePath = join(worktreeRoot, "ENG-1");
  const headContent = existsSync(join(worktreePath, "README.md"))
    ? Bun.file(join(worktreePath, "README.md")).text()
    : Promise.resolve("");
  db.close();

  expect(["retry", "escalated"]).toContain(outcome.kind); // never a clean success
  expect(step?.status).toBe("pending");
  // No dispatch row is left clean-success pointing at the malformed-sidecar commit.
  expect(dispatches.every((d) => d.outcome !== "clean-success")).toBe(true);
  expect(dispatches.some((d) => d.outcome === "reverted")).toBe(true);
  expect(await headContent).not.toBe("edited by agent\n"); // the edit was rolled back
});

test("implement discard + absent sidecar WITH undeclared new files re-dispatches", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "x.ts"), "export const z = 1;\n");
    // NO sidecar at all.
    return {
      completed: true,
      exitCode: 0,
      stdout: "no sidecar here",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-implabsent-"));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
    }),
    worktreeRoot,
  });
  const config = RuntimeConfigSchema.parse({ implementDisposition: "discard" });

  const outcome = await advanceOneStep(db, ticketId, registry, { config });
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  const dispatches = listByTicket(db, ticketId);
  const worktreePath = join(worktreeRoot, "ENG-1");
  const headSha = Bun.spawnSync(["git", "-C", worktreePath, "rev-parse", "HEAD"])
    .stdout.toString()
    .trim();
  db.close();

  expect(["retry", "escalated"]).toContain(outcome.kind); // re-dispatched, not silently accepted
  expect(step?.status).toBe("pending");
  // The undeclared new file (x.ts) was discarded pre-commit (discardPaths, scoped to just that
  // path) — nothing was ever committed, so HEAD never moved and there is nothing to revert. The
  // guard (mirrors checks:dispatch's catch block, ~:748) skips resetWorktreeHard + the re-mark in
  // this case — an unconditional `git clean -fd` here would wipe pre-existing untracked cruft
  // (e.g. the *.egg-info undoAttempt deliberately spares) for no reason. The row legitimately
  // stays `clean-success`; the sidecar transport failure is what drives the re-dispatch.
  expect(dispatches.every((d) => d.outcome === "clean-success")).toBe(true);
  expect(dispatches.every((d) => d.branch_head_sha === headSha)).toBe(true);
  expect(existsSync(join(worktreePath, "x.ts"))).toBe(false); // never left in the worktree
});
