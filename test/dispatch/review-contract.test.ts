import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getLatestForTicket } from "../../src/db/repos/dispatch.ts";
import { listByTicket as events } from "../../src/db/repos/event-log.ts";
import { listByTicket as signals } from "../../src/db/repos/ground-truth-signal.ts";
import { requiredCodeFindings } from "../../src/db/repos/review-round.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { reviewJobs, runCodeReview } from "../../src/dispatch/code-review.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { worktreeHead } from "../../src/dispatch/worktree.ts";
import { makeTestDb } from "../helpers/db.ts";

const sidecar = (value: unknown) => `\`\`\`styre-sidecar\n${JSON.stringify(value)}\n\`\`\``;
const finding = {
  severity: "major",
  category: "correctness",
  location: "README.md:1",
  rationale: "Synthetic disputed claim",
  factors: null,
  deferral_candidate: true,
  work_unit_seq: 1,
};
const evidence = [{ kind: "source", path: "README.md", line: 1 }];
function fixture() {
  const f = makeTestDb();
  const root = mkdtempSync(join(tmpdir(), "styre-review-contract-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root });
    if (!r.success) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "README.md"), "candidate\n");
  git("commit", "-am", "candidate");
  f.db.query("UPDATE project SET target_repo=? WHERE id=?").run(root, f.projectId);
  f.db.query("UPDATE ticket SET stage='review' WHERE id=?").run(f.ticketId);
  const unit = insertWorkUnit(f.db, {
    ticketId: f.ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    filesToTouch: ["README.md"],
    verifyCheckTypes: ["test"],
    status: "verified",
  });
  f.db.query("UPDATE work_unit SET base_sha=? WHERE id=?").run(base, unit.id);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: root,
    components: [{ name: "app", kind: "node", paths: ["**"], commands: { test: "true" } }],
  });
  const registry = (runner: FakeAgentRunner) =>
    buildDispatchRegistry({
      runner,
      profile,
      agentConfig: DEFAULT_AGENT_CONFIG,
      worktreeRoot: mkdtempSync(join(tmpdir(), "styre-review-wt-")),
    });
  const ticket = getTicket(f.db, f.ticketId);
  if (!ticket) throw new Error("missing fixture ticket");
  return { ...f, root, git, unit, profile, registry, ticket };
}

test("deferral suggestion → no-change dispute → independent invalidation → push eligibility", async () => {
  const f = fixture();
  let reviews = 0;
  let repairs = 0;
  const runner = new FakeAgentRunner((input) => {
    if (input.prompt.includes("independent code reviewer")) {
      reviews++;
      return {
        completed: true,
        exitCode: 0,
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        stderr: "",
        stdout: sidecar(
          reviews === 1
            ? { findings: [finding] }
            : {
                findings: [],
                resolutions: requiredCodeFindings(f.db, f.ticketId).map((x) => ({
                  finding_id: x.id,
                  disposition: "invalid",
                  rationale: "Independently checked the source counterexample",
                  evidence,
                })),
              },
        ),
      };
    }
    repairs++;
    expect(input.prompt).toContain("Treat each rationale as a claim");
    return {
      completed: true,
      exitCode: 0,
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
      stderr: "",
      stdout: sidecar({
        new_files: [],
        review_responses: requiredCodeFindings(f.db, f.ticketId).map((x) => ({
          finding_id: x.id,
          action: "disputed",
          rationale: "Source contradicts the allegation",
          evidence,
        })),
      }),
    };
  });
  const registry = f.registry(runner);
  for (let i = 0; i < 20 && getTicket(f.db, f.ticketId)?.stage !== "merge"; i++)
    await advanceOneStep(f.db, f.ticketId, registry);
  expect(getTicket(f.db, f.ticketId)?.stage).toBe("merge");
  expect(reviews).toBe(2);
  expect(repairs).toBe(1);
  expect(requiredCodeFindings(f.db, f.ticketId)).toEqual([]);
  expect(
    f.db.query<{ status: string }, []>("SELECT status FROM review_finding").get()?.status,
  ).toBe("wont-fix");
  expect(events(f.db, f.ticketId).filter((e) => e.reason === "review-responses")).toHaveLength(1);
  expect(events(f.db, f.ticketId).filter((e) => e.reason === "review-completed")).toHaveLength(2);
  f.db.close();
});

test.each([[], [{ finding_id: 999, disposition: "fixed", rationale: "wrong ID", evidence }]])(
  "empty/foreign resolution cannot erase a prior finding: %j",
  async (resolutions) => {
    const f = fixture();
    let round = 0;
    const registry = f.registry(
      new FakeAgentRunner(() => ({
        completed: true,
        exitCode: 0,
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        stderr: "",
        stdout: sidecar(++round === 1 ? { findings: [finding] } : { findings: [], resolutions }),
      })),
    );
    await advanceOneStep(f.db, f.ticketId, registry);
    f.db.query("UPDATE ticket SET stage='review' WHERE id=?").run(f.ticketId);
    await advanceOneStep(f.db, f.ticketId, registry);
    expect(requiredCodeFindings(f.db, f.ticketId)).toHaveLength(1);
    expect(getByKey(f.db, f.ticketId, "review")?.status).not.toBe("succeeded");
    expect(events(f.db, f.ticketId).filter((e) => e.reason === "review-completed")).toHaveLength(1);
    f.db.close();
  },
);

test.each(["missing-response", "discarded-citation"])(
  "invalid repair output rolls back edits before recording response: %s",
  async (mode) => {
    const f = fixture();
    let review = true;
    let repairRoot = "";
    const registry = f.registry(
      new FakeAgentRunner((input) => {
        if (review) {
          review = false;
          return {
            completed: true,
            exitCode: 0,
            timedOut: false,
            costUsd: 1.25,
            tokensIn: 42,
            tokensOut: 7,
            stderr: "",
            stdout: sidecar({ findings: [finding] }),
          };
        }
        repairRoot = input.cwd;
        writeFileSync(join(input.cwd, "README.md"), "unvalidated edit\n");
        if (mode === "discarded-citation")
          writeFileSync(join(input.cwd, "throwaway.txt"), "citation that will be discarded\n");
        return {
          completed: true,
          exitCode: 0,
          timedOut: false,
          costUsd: 1.25,
          tokensIn: 42,
          tokensOut: 7,
          stderr: "",
          stdout: sidecar({
            new_files: [],
            review_responses:
              mode === "missing-response"
                ? []
                : requiredCodeFindings(f.db, f.ticketId).map((x) => ({
                    finding_id: x.id,
                    action: "disputed",
                    rationale: "unsupported citation",
                    evidence: [{ kind: "source", path: "throwaway.txt", line: 1 }],
                  })),
          }),
        };
      }),
    );
    await advanceOneStep(f.db, f.ticketId, registry);
    const before = getLatestForTicket(f.db, f.ticketId)?.branch_head_sha;
    await advanceOneStep(f.db, f.ticketId, registry, {
      config: { ...DEFAULT_RUNTIME_CONFIG, implementDisposition: "discard" },
    });
    expect(readFileSync(join(repairRoot, "README.md"), "utf8")).toBe("candidate\n");
    if (!before) throw new Error("missing reviewed SHA");
    expect(worktreeHead(repairRoot)).toBe(before);
    expect(events(f.db, f.ticketId).filter((e) => e.reason === "review-responses")).toHaveLength(0);
    expect(getLatestForTicket(f.db, f.ticketId)?.cost_usd).toBe(1.25);
    expect(getLatestForTicket(f.db, f.ticketId)?.tokens_in).toBe(42);
    expect(getLatestForTicket(f.db, f.ticketId)?.tokens_out).toBe(7);
    expect(requiredCodeFindings(f.db, f.ticketId)).toHaveLength(1);
    f.db.close();
  },
);

test("review requests only a declared job and receives recorded execution evidence", async () => {
  const f = fixture();
  const step = insertPending(f.db, {
    ticketId: f.ticketId,
    stepKey: "review",
    stepType: "dispatch",
  });
  let turn = 0;
  let executions = 0;
  const result = await runCodeReview(
    {
      db: f.db,
      ticket: f.ticket,
      step,
      workUnitId: null,
      config: DEFAULT_RUNTIME_CONFIG,
    },
    {
      profile: f.profile,
      worktreePath: f.root,
      timeoutMs: 500,
      dispatch: async (context) => {
        turn++;
        if (turn === 2) {
          expect(context).toContain('"signal_type": "review-probe"');
          expect(JSON.parse(JSON.parse(context).measurements[0].detail_json).exitCode).toBe(0);
        }
        return {
          dispatchId: `review-${turn}`,
          sha: worktreeHead(f.root),
          output: sidecar(
            turn === 1
              ? { findings: [], verification_requests: [reviewJobs(f.profile)[0]?.id] }
              : { findings: [] },
          ),
        };
      },
      executeProbe: async (command) => {
        executions++;
        expect(command).toBe("true");
        return {
          exitCode: 0,
          stdout: "actual execution",
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      },
    },
  );
  expect(executions).toBe(1);
  expect(result.reviewCompletion.output.findings).toEqual([]);
  expect(signals(f.db, f.ticketId).at(-1)?.branch_head_sha).toBe(worktreeHead(f.root));
  f.db.close();
});

test("symlinked job cwd cannot escape the worktree", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "styre-review-outside-"));
  symlinkSync(outside, join(f.root, "component"));
  const profile = parseProfile({
    ...f.profile,
    components: [{ ...f.profile.components[0], dir: "component" }],
  });
  const step = insertPending(f.db, {
    ticketId: f.ticketId,
    stepKey: "review",
    stepType: "dispatch",
  });
  let executed = false;
  await expect(
    runCodeReview(
      {
        db: f.db,
        ticket: f.ticket,
        step,
        workUnitId: null,
        config: DEFAULT_RUNTIME_CONFIG,
      },
      {
        profile,
        worktreePath: f.root,
        timeoutMs: 500,
        dispatch: async () => ({
          dispatchId: "request",
          sha: worktreeHead(f.root),
          output: sidecar({ findings: [], verification_requests: [reviewJobs(profile)[0]?.id] }),
        }),
        executeProbe: async () => {
          executed = true;
          throw new Error("must not execute");
        },
      },
    ),
  ).rejects.toThrow("escapes the worktree");
  expect(executed).toBe(false);
  f.db.close();
});

test("dirty verification output is restored and reported as error, never a passing measurement", async () => {
  const f = fixture();
  const step = insertPending(f.db, {
    ticketId: f.ticketId,
    stepKey: "review",
    stepType: "dispatch",
  });
  let turn = 0;
  await runCodeReview(
    {
      db: f.db,
      ticket: f.ticket,
      step,
      workUnitId: null,
      config: DEFAULT_RUNTIME_CONFIG,
    },
    {
      profile: f.profile,
      worktreePath: f.root,
      timeoutMs: 500,
      dispatch: async () => ({
        dispatchId: `review-${++turn}`,
        sha: worktreeHead(f.root),
        output: sidecar(
          turn === 1
            ? { findings: [], verification_requests: [reviewJobs(f.profile)[0]?.id] }
            : { findings: [] },
        ),
      }),
      executeProbe: async () => {
        writeFileSync(join(f.root, "README.md"), "test mutation");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
      },
    },
  );
  expect(readFileSync(join(f.root, "README.md"), "utf8")).toBe("candidate\n");
  expect(signals(f.db, f.ticketId).at(-1)?.result).toBe("error");
  f.db.close();
});

test("verification request allowance survives a failed review and cannot buy a fourth command", async () => {
  const f = fixture();
  const step = insertPending(f.db, {
    ticketId: f.ticketId,
    stepKey: "review",
    stepType: "dispatch",
  });
  let executions = 0;
  const ctx = {
    db: f.db,
    ticket: f.ticket,
    step,
    workUnitId: null,
    config: DEFAULT_RUNTIME_CONFIG,
  };
  const deps = {
    profile: f.profile,
    worktreePath: f.root,
    timeoutMs: 500,
    dispatch: async () => ({
      dispatchId: "request",
      sha: worktreeHead(f.root),
      output: sidecar({ findings: [], verification_requests: [reviewJobs(f.profile)[0]?.id] }),
    }),
    executeProbe: async () => {
      executions++;
      return { exitCode: 1, stdout: "failed check", stderr: "", timedOut: false, truncated: false };
    },
  };
  await expect(runCodeReview(ctx, deps)).rejects.toThrow("request limit");
  expect(executions).toBe(3);
  await expect(runCodeReview(ctx, deps)).rejects.toThrow("request limit");
  expect(executions).toBe(3);
  expect(
    events(f.db, f.ticketId).filter((e) => e.reason === "review-probe-requested"),
  ).toHaveLength(3);
  f.db.close();
});

test("a reviewer cannot execute an arbitrary command as a verification request", async () => {
  const f = fixture();
  const step = insertPending(f.db, {
    ticketId: f.ticketId,
    stepKey: "review",
    stepType: "dispatch",
  });
  let executed = false;
  await expect(
    runCodeReview(
      {
        db: f.db,
        ticket: f.ticket,
        step,
        workUnitId: null,
        config: DEFAULT_RUNTIME_CONFIG,
      },
      {
        profile: f.profile,
        worktreePath: f.root,
        timeoutMs: 500,
        dispatch: async () => ({
          dispatchId: "request",
          sha: worktreeHead(f.root),
          output: sidecar({ findings: [], verification_requests: ["echo invented-command"] }),
        }),
        executeProbe: async () => {
          executed = true;
          throw new Error("must not execute");
        },
      },
    ),
  ).rejects.toThrow("unknown verification job");
  expect(executed).toBe(false);
  expect(
    events(f.db, f.ticketId).filter((e) => e.reason === "review-probe-requested"),
  ).toHaveLength(0);
  f.db.close();
});
