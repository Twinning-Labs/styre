import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import {
  insertSignal,
  listByTicket as listSignals,
} from "../../src/db/repos/ground-truth-signal.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { worktreeHead } from "../../src/dispatch/worktree.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dr-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  Bun.write(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function registryWith(repo: string, runner: FakeAgentRunner, worktreeRoot: string) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot,
  });
}

async function runDocsRevise(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  projectId: number,
  registry: ReturnType<typeof registryWith>,
) {
  const handler = registry.resolve("docs:revise");
  if (!handler) throw new Error("docs:revise handler not registered");
  return runStep(db, {
    ticketId,
    stepKey: "docs:revise",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "implement",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });
}

test("a docs-only edit commits and carries the verified verdict forward", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-drwt-"));

  // A verified integration signal + an active ac-check at the pre-edit HEAD ("V"), so we can
  // observe carry-forward actually replicating them at the new commit sha.
  insertSignal(db, {
    ticketId,
    signalType: "integration",
    result: "pass",
    branchHeadSha: "V",
    detail: { ran: [] },
  });
  const ac = insertAc(db, { ticketId, seq: 1, text: "x", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });

  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "docs"), { recursive: true });
    writeFileSync(join(input.cwd, "docs", "api.md"), "updated");
    return {
      completed: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry = registryWith(repo, runner, worktreeRoot);
  const { result } = await runDocsRevise(db, ticketId, projectId, registry);
  expect((result as { docsRevised: boolean }).docsRevised).toBe(true);

  const worktreePath = join(worktreeRoot, "ENG-1");
  const newSha = worktreeHead(worktreePath);
  const atNewSha = listSignals(db, ticketId).filter((s) => s.branch_head_sha === newSha);
  expect(atNewSha.some((s) => s.signal_type === "integration")).toBe(true);
  expect(atNewSha.some((s) => s.signal_type === "ac-check-gate")).toBe(true);
  db.close();
});

test("a source edit is rejected by the commitGuard: nothing commits, no carry-forward", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-drwt-"));

  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "src"), { recursive: true });
    writeFileSync(join(input.cwd, "src", "evil.py"), "bad");
    return {
      completed: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry = registryWith(repo, runner, worktreeRoot);

  await expect(runDocsRevise(db, ticketId, projectId, registry)).rejects.toThrow(
    /docs:revise may only edit documentation/,
  );

  const worktreePath = join(worktreeRoot, "ENG-1");
  // HEAD must be unchanged: still the repo's initial commit (commitGuard rejects before commit).
  expect(worktreeHead(worktreePath)).toBe(worktreeHead(repo));
  // No carry-forward (or any other) signal was written.
  expect(listSignals(db, ticketId).length).toBe(0);
  db.close();
});

test("a no-op dispatch does not commit or carry forward", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-drwt-"));

  // Seed an integration signal so a spurious carry-forward would be observable.
  insertSignal(db, { ticketId, signalType: "integration", result: "pass", branchHeadSha: "V" });

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryWith(repo, runner, worktreeRoot);
  const { result } = await runDocsRevise(db, ticketId, projectId, registry);
  expect((result as { docsRevised: boolean }).docsRevised).toBe(false);

  // Only the one seeded signal exists; nothing was carried forward.
  expect(listSignals(db, ticketId).length).toBe(1);
  db.close();
});
