import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import {
  pendingChanges,
  revertWorktree,
  worktreeHasChanges,
  worktreeHead,
} from "../../src/dispatch/worktree.ts";
import { makeTestDb } from "../helpers/db.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const g = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, "app.py"), "print(1)\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return dir;
}

test("pendingChanges lists tracked modifications AND untracked additions", () => {
  const dir = tmpRepo();
  writeFileSync(join(dir, "README.md"), "changed\n"); // tracked mod
  writeFileSync(join(dir, "docs.md"), "new\n"); // untracked add
  const pending = pendingChanges(dir).sort();
  expect(pending).toEqual(["README.md", "docs.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pendingChanges includes a deleted file and both sides of a rename", () => {
  const dir = tmpRepo();
  execFileSync("git", ["-C", dir, "mv", "app.py", "core.py"]); // rename → app.py (old) + core.py (new)
  const pending = pendingChanges(dir);
  expect(pending).toContain("app.py");
  expect(pending).toContain("core.py");
  rmSync(dir, { recursive: true, force: true });
});

test("revertWorktree restores HEAD (tracked + untracked discarded)", () => {
  const dir = tmpRepo();
  const before = worktreeHead(dir);
  writeFileSync(join(dir, "app.py"), "print(2)\n"); // tracked mod
  writeFileSync(join(dir, "evil.py"), "bad\n"); // untracked add
  revertWorktree(dir);
  expect(pendingChanges(dir)).toEqual([]);
  expect(worktreeHead(dir)).toBe(before);
  rmSync(dir, { recursive: true, force: true });
});

// --- commitGuard (Task 2) -----------------------------------------------------------------

function ctxFor(db: ReturnType<typeof makeTestDb>["db"], ticketId: number): HandlerContext {
  const step = insertPending(db, {
    ticketId,
    stepKey: "docs:revise:dispatch",
    stepType: "dispatch",
  });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG };
}

function depsFor(repo: string, wt: string) {
  return {
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    repoPath: repo,
    worktreePath: wt,
    branch: "feat/ENG-1",
    timeoutMs: 1000,
  };
}

function writesFiles(files: Record<string, string>): FakeAgentRunner {
  return new FakeAgentRunner((input) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(input.cwd, rel);
      const dir = rel.split("/").slice(0, -1).join("/");
      if (dir) execFileSync("mkdir", ["-p", join(input.cwd, dir)]);
      writeFileSync(abs, content);
    }
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

test("commitGuard: docs-only edit commits (clean-success)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = tmpRepo();
  const wt = repo;
  const runner = writesFiles({ "docs/x.md": "hi" });
  const out = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "revise docs {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
      commitGuard: ({ pending }) => {
        const offender = pending.find((p) => !p.startsWith("docs/"));
        if (offender) throw new Error(`non-doc path in diff: ${offender}`);
      },
    },
  );
  const rows = listByTicket(db, ticketId);
  db.close();
  rmSync(repo, { recursive: true, force: true });
  expect(out.changed).toBe(true);
  expect(rows[0]?.outcome).toBe("clean-success");
});

test("commitGuard: a non-doc edit (incl a NEW untracked source file) does NOT commit, reverts, head unchanged", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = tmpRepo();
  const wt = repo;
  const preHead = worktreeHead(repo);
  const runner = writesFiles({ "src/evil.py": "bad", "docs/x.md": "hi" });
  const call = runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "revise docs {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
      commitGuard: ({ pending }) => {
        const offender = pending.find((p) => !p.startsWith("docs/"));
        if (offender) throw new Error(`non-doc path in diff: ${offender}`);
      },
    },
  );
  await expect(call).rejects.toThrow(/non-doc path in diff/);
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(worktreeHasChanges(repo)).toBe(false);
  expect(worktreeHead(repo)).toBe(preHead);
  expect(rows[0]?.outcome).toBe("dispatch-failed");
  expect(rows[0]?.branch_head_sha).toBe(preHead);
  rmSync(repo, { recursive: true, force: true });
});

test("no commitGuard → behavior unchanged (commits, clean-success)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = tmpRepo();
  const wt = repo;
  const runner = writesFiles({ "src/foo.py": "x" });
  const out = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "implement:dispatch",
      template: "revise docs {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  );
  const rows = listByTicket(db, ticketId);
  db.close();
  rmSync(repo, { recursive: true, force: true });
  expect(out.changed).toBe(true);
  expect(rows[0]?.outcome).toBe("clean-success");
});
