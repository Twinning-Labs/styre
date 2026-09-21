import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { completeDispatch, insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket as signals } from "../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending, markSucceeded } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function fixture(scope: "unit" | "integration", command: string) {
  const { db, ticketId, projectId } = makeTestDb();
  const root = mkdtempSync(join(tmpdir(), "styre-execution-error-"));
  const repo = join(root, "repo");
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "init", "-b", "main", repo]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "base\n");
  writeFileSync(join(repo, "pyproject.toml"), '[project]\nname="pkg"\n');
  git("add", ".");
  git("commit", "-m", "initial");
  writeFileSync(join(repo, "feature.py"), "value = 1\n");
  git("add", ".");
  git("commit", "-m", "base");
  const sha = git("rev-parse", "HEAD");
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
    status: scope === "unit" ? "verifying" : "verified",
  });
  const dispatch = insertDispatch(db, {
    ticketId,
    dispatchId: "T-d0001",
    seq: 1,
    workUnitId: unit.id,
  });
  completeDispatch(db, dispatch.id, { outcome: "clean-success", branchHeadSha: sha });
  for (const [stepKey, stepType] of [
    ["provision", "provision"],
    ["completeness:wu1", "completeness"],
  ]) {
    markSucceeded(db, insertPending(db, { ticketId, stepKey, stepType }).id, {});
  }
  const registry = buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("No author/model call permitted");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "test",
      targetRepo: repo,
      components: [{ name: "app", kind: "python", paths: ["**"], commands: { test: command } }],
      repoCommands: scope === "integration" ? { after: "echo should-not-run" } : {},
    }),
    worktreeRoot: join(root, "worktrees"),
    timeoutMs: 2000,
  });
  return {
    db,
    ticketId,
    sha,
    repo,
    registry,
    unitId: unit.id,
    key: scope === "unit" ? "verify:wu1:test" : "verify:integration",
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Real shell processes prove argv and retained observations. A ready-Python stub would satisfy
// the removed import/collection probes, but it must never replace the selected suite.
for (const scope of ["unit", "integration"] as const) {
  for (const command of ["tox -e unit -- -q", "nox -s tests", "pytest tests/unit -m fast"]) {
    test(`${scope}: executes selected ${command} verbatim without readiness substitution`, async () => {
      const bin = mkdtempSync(join(tmpdir(), "styre-suite-bins-"));
      const probe = join(bin, "unexpected-python-probe");
      const before = process.env.PATH;
      const executable = (name: string, script: string) => {
        const path = join(bin, name);
        writeFileSync(path, `#!/bin/sh\n${script}\n`);
        chmodSync(path, 0o700);
      };
      for (const name of ["python", "python3"]) executable(name, `touch '${probe}'; exit 0`);
      for (const name of ["tox", "nox", "pytest"])
        executable(name, 'printf "arg=%s\\n" "$@"; exit 7');
      process.env.PATH = `${bin}:${before}`;
      const f = fixture(scope, command);
      try {
        expect((await advanceOneStep(f.db, f.ticketId, f.registry)).kind).toBe("stepped");
        const signal = signals(f.db, f.ticketId).find(
          (s) => s.signal_type === (scope === "unit" ? "test" : "integration"),
        );
        expect(signal?.result).toBe("fail");
        expect(signal?.command).toBe(command);
        const observation = JSON.parse(signal?.detail_json ?? "{}").ran[0].observation;
        expect(observation).toMatchObject({
          command,
          sha: f.sha,
          exitCode: 7,
          timedOut: false,
          outcome: "completed-nonzero",
        });
        expect(observation.stdout.trim().split("\n")).toEqual(
          command
            .split(" ")
            .slice(1)
            .map((arg) => `arg=${arg}`),
        );
        expect(existsSync(probe)).toBe(false);
      } finally {
        process.env.PATH = before;
        f.cleanup();
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }
}
