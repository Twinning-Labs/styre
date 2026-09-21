import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { recover } from "../../src/daemon/recover.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { resumeVerificationRetries } from "../../src/daemon/verification-retry.ts";
import { completeDispatch, insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket as events } from "../../src/db/repos/event-log.ts";
import { insertSignal, listByTicket as signals } from "../../src/db/repos/ground-truth-signal.ts";
import { hasPendingHumanResume } from "../../src/db/repos/signal.ts";
import { getTicket, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as units } from "../../src/db/repos/work-unit.ts";
import {
  getByKey,
  insertPending,
  markFailed,
  markRunning,
  markSucceeded,
} from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { StepExecutionError } from "../../src/engine/step-journal.ts";
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
  git("add", ".");
  git("commit", "-m", "initial");
  writeFileSync(join(repo, "feature.ts"), "export const value = 1;\n");
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
      components: [{ name: "app", kind: "node", paths: ["**"], commands: { test: command } }],
      repoCommands: scope === "integration" ? { after: "echo should-not-run" } : {},
    }),
    worktreeRoot: join(root, "worktrees"),
    timeoutMs: 150,
  });
  return {
    db,
    ticketId,
    sha,
    registry,
    unitId: unit.id,
    key: scope === "unit" ? "verify:wu1:test" : "verify:integration",
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const scope of ["unit", "integration"] as const) {
  test(`${scope}: explicit resume after recovery grants a window before the next advance`, async () => {
    const f = fixture(scope, "true");
    try {
      const step = insertPending(f.db, {
        ticketId: f.ticketId,
        workUnitId: scope === "unit" ? f.unitId : null,
        stepKey: f.key,
        stepType: "verify",
      });
      for (let i = 0; i < 3; i++) markRunning(f.db, step.id, {});
      recover(f.db, { isAlive: () => false, kill: () => {} });
      expect(getByKey(f.db, f.ticketId, f.key)).toMatchObject({ status: "pending", attempt: 3 });
      f.db.transaction(() => resumeVerificationRetries(f.db, f.ticketId))();
      expect((await advanceOneStep(f.db, f.ticketId, f.registry)).kind).toBe("stepped");
      expect(getByKey(f.db, f.ticketId, f.key)?.attempt).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  test.each(["failed", "running"] as const)(
    `${scope}: persisted %s at attempt three cannot run a fourth attempt`,
    async (status) => {
      const f = fixture(scope, "echo operator-repaired");
      try {
        const step = insertPending(f.db, {
          ticketId: f.ticketId,
          workUnitId: scope === "unit" ? f.unitId : null,
          stepKey: f.key,
          stepType: "verify",
        });
        for (let i = 0; i < 3; i++) markRunning(f.db, step.id, {});
        if (status === "failed")
          markFailed(f.db, step.id, new StepExecutionError("suite execution incomplete"));
        else
          recover(f.db, {
            isAlive: () => false,
            kill: () => {
              throw new Error("no live process");
            },
          });
        expect(await advanceOneStep(f.db, f.ticketId, f.registry)).toEqual({
          kind: "escalated",
          stepKey: f.key,
        });
        expect(getByKey(f.db, f.ticketId, f.key)?.attempt).toBe(3);
        expect(signals(f.db, f.ticketId)).toHaveLength(0);
        // Explicit operator action grants a new bounded window and retains the previous counter.
        f.db.transaction(() => resumeVerificationRetries(f.db, f.ticketId))();
        setTicketStatus(f.db, f.ticketId, "active");
        expect(getByKey(f.db, f.ticketId, f.key)).toMatchObject({ status: "pending", attempt: 0 });
        const grant = events(f.db, f.ticketId).find(
          (e) => e.reason === "verification-retry-window-granted",
        );
        expect(JSON.parse(grant?.payload_json ?? "{}")).toMatchObject({
          priorAttempts: 3,
          maxAttempts: 3,
        });
        expect((await advanceOneStep(f.db, f.ticketId, f.registry)).kind).toBe("stepped");
        expect(getByKey(f.db, f.ticketId, f.key)?.attempt).toBe(1);
      } finally {
        f.cleanup();
      }
    },
  );
  test(`${scope}: a signal-terminated command without a timeout retries and escalates`, async () => {
    const f = fixture(scope, "echo interrupted; kill -KILL $$");
    try {
      for (const decision of ["retry", "retry", "escalated"] as const) {
        expect((await advanceOneStep(f.db, f.ticketId, f.registry)).kind).toBe(decision);
      }
      const rows = signals(f.db, f.ticketId).filter(
        (s) => s.signal_type === (scope === "unit" ? "test" : "integration"),
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.result).toBe("error");
        expect(JSON.parse(row.detail_json ?? "{}").ran[0].observation).toMatchObject({
          outcome: "execution-error",
          exitCode: null,
          timedOut: false,
        });
      }
      expect(units(f.db, f.ticketId)).toHaveLength(1);
      expect(hasPendingHumanResume(f.db, f.ticketId)).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test(`${scope}: real timeouts retain evidence, retry exactly twice, then escalate without coding`, async () => {
    const f = fixture(scope, "echo started; echo diagnostic >&2; sleep 10");
    try {
      for (const [i, decision] of (["retry", "retry", "escalated"] as const).entries()) {
        expect(nextStepKey(f.db, f.ticketId)).toMatchObject({ kind: "step", stepKey: f.key });
        expect(await advanceOneStep(f.db, f.ticketId, f.registry)).toEqual({
          kind: decision,
          stepKey: f.key,
        });
        expect(getByKey(f.db, f.ticketId, f.key)?.attempt).toBe(i + 1);
      }
      expect(getByKey(f.db, f.ticketId, f.key)).toMatchObject({
        status: "failed",
        attempt: 3,
        pid: null,
      });
      expect(getTicket(f.db, f.ticketId)?.status).toBe("waiting");
      expect(hasPendingHumanResume(f.db, f.ticketId)).toBe(true);
      expect(units(f.db, f.ticketId)).toHaveLength(1);
      expect(events(f.db, f.ticketId).filter((e) => e.kind === "loopback")).toHaveLength(0);
      const rows = signals(f.db, f.ticketId).filter(
        (s) => s.signal_type === (scope === "unit" ? "test" : "integration"),
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.result).toBe("error");
        const detail = JSON.parse(row.detail_json ?? "{}");
        expect(detail.ran[0].observation).toMatchObject({
          outcome: "timed-out",
          sha: f.sha,
          timedOut: true,
          exitCode: null,
          stdout: "started\n",
          stderr: "diagnostic\n",
          timing: { timeoutMs: 150 },
        });
        expect(detail.ran[0].observation.timing.durationMs).toBeGreaterThan(0);
        expect(detail).not.toHaveProperty("baseline");
        if (scope === "integration") expect(detail.notExecuted).toEqual(["repo:after"]);
      }
    } finally {
      f.cleanup();
    }
  });

  test.each([0, 1])(
    `${scope}: timeout followed by completed exit %i advances instead of replaying`,
    async (exitCode) => {
      // Marker is runtime state, so the candidate commit is unchanged across attempts.
      const f = fixture(
        scope,
        `if test -f .attempted; then exit ${exitCode}; fi; touch .attempted; sleep 10`,
      );
      try {
        expect((await advanceOneStep(f.db, f.ticketId, f.registry)).kind).toBe("retry");
        expect((await advanceOneStep(f.db, f.ticketId, f.registry)).kind).toBe("stepped");
        expect(getByKey(f.db, f.ticketId, f.key)).toMatchObject({
          status: "succeeded",
          attempt: 2,
        });
        expect(nextStepKey(f.db, f.ticketId)).not.toMatchObject({ kind: "step", stepKey: f.key });
      } finally {
        f.cleanup();
      }
    },
  );

  test(`${scope}: an old completed error checkpoint escalates once, without replay spin or reexecution`, async () => {
    const f = fixture(scope, "echo must-not-run");
    try {
      const step = insertPending(f.db, {
        ticketId: f.ticketId,
        stepKey: f.key,
        stepType: "verify",
      });
      markSucceeded(f.db, step.id, { result: "error" });
      insertSignal(f.db, {
        ticketId: f.ticketId,
        workUnitId: scope === "unit" ? f.unitId : null,
        signalType: scope === "unit" ? "test" : "integration",
        result: "error",
        branchHeadSha: f.sha,
      });
      expect(await advanceOneStep(f.db, f.ticketId, f.registry)).toEqual({
        kind: "escalated",
        stepKey: f.key,
      });
      expect(signals(f.db, f.ticketId)).toHaveLength(1);
      expect(getByKey(f.db, f.ticketId, f.key)?.attempt).toBe(0);
      expect(events(f.db, f.ticketId).at(-1)?.signature).toBe(`step-replay-no-progress:${f.key}`);
      expect(getTicket(f.db, f.ticketId)?.status).toBe("waiting");
    } finally {
      f.cleanup();
    }
  });
}
