import { expect, test } from "bun:test";
import {
  insertSignal,
  isExecutedPass,
  listByTicket,
} from "../../src/db/repos/ground-truth-signal.ts";
import { carryVerifiedVerdictForward } from "../../src/dispatch/carry-forward.ts";
import { frameworkFor } from "../../src/dispatch/check-selector.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import {
  observeSuiteCommand,
  suiteObservation,
  suiteResult,
} from "../../src/dispatch/suite-observation.ts";
import { suiteRequirement, testCapabilities } from "../../src/testing/capabilities.ts";
import { receiptVerdict, suiteBinding, suiteReceipt } from "../../src/testing/suite-adapters.ts";
import {
  declaredSuiteRequirements,
  requiredSuiteProblem,
  requirementsHash,
} from "../../src/testing/suite-requirements.ts";
import { makeTestDb } from "../helpers/db.ts";

function component(kind: "python" | "node") {
  return parseProfile({
    slug: "test",
    targetRepo: "/repo",
    components: [
      {
        name: kind,
        kind,
        paths: ["**"],
        commands: { test: kind === "python" ? "python3 -m pytest" : "npm test" },
        testEnvironment:
          kind === "python"
            ? {
                version: 1,
                adapter: "python",
                policy: "existing",
                suiteCommand: "python3 -m pytest",
                framework: "pytest",
                checkLauncher: "python3 -m pytest",
              }
            : {
                version: 1,
                adapter: "node",
                policy: "existing",
                suiteCommand: "npm test",
                framework: "jest",
                checkLauncher: "npm test --",
                manager: "npm",
              },
      },
    ],
  }).components[0];
}
for (const kind of ["python", "node"] as const) {
  test(`${kind} suite requirements and authored-check support are independent`, () => {
    const c = component(kind);
    if (!c.testEnvironment) throw Error("fixture missing plan");
    expect(testCapabilities(c.testEnvironment).authoredChecks).toBe("supported");
    expect(suiteRequirement(c)).toBe("advisory");
    c.testPolicy = { suite: "required" };
    expect(suiteRequirement(c)).toBe("required");
    expect(testCapabilities(c.testEnvironment, c.testPolicy).authoredChecks).toBe("supported");
    c.testPolicy = { authoredChecks: "disabled" };
    c.testAction = { framework: "pytest", launcher: "invented" };
    expect(frameworkFor(c)).toBeNull();
    expect(suiteRequirement(c)).toBe("required");
    c.testPolicy.suite = "advisory";
    expect(suiteRequirement(c)).toBe("advisory");
  });
}
function fixture() {
  const { db, ticketId } = makeTestDb();
  const c = component("python");
  c.testPolicy = { suite: "required" };
  const contract = declaredSuiteRequirements([c], "/repo");
  insertSignal(db, {
    ticketId,
    signalType: "suite-requirements",
    result: "pass",
    detail: contract,
  });
  const requirement = contract.requirements[0];
  const run = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  const observation = {
    ...suiteObservation({ command: requirement.command, cwd: requirement.cwd, sha: "HEAD" }, run),
    suite: suiteReceipt(requirement.command, requirement.cwd, requirement.binding, null, run),
  };
  const job = { label: requirement.label, kind: "test", exitCode: 0, timedOut: false, observation };
  const report: Record<string, unknown> = {
    suiteRequirementsHash: requirementsHash(contract),
    ran: [job],
  };
  const insert = (detail: unknown = report, sha = "HEAD") =>
    insertSignal(db, {
      ticketId,
      signalType: "integration",
      result: "pass",
      branchHeadSha: sha,
      detail,
    });
  return {
    db,
    ticketId,
    contract,
    job,
    report,
    insert,
    problem: (head = "HEAD") => requiredSuiteProblem(listByTicket(db, ticketId), head),
  };
}

test("new process receipts are honest about evidence strength and pass native command observation", async () => {
  const o = await observeSuiteCommand({
    sha: "HEAD",
    command: "printf proof",
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  expect(o.suite?.evidence).toBe("process");
  expect(o.suite?.payload).toBeNull();
  expect(suiteResult(o)).toBe("pass");
  expect(o.stdout).toBe("proof");
});

test("a required non-browser suite passes only against its independent declaration", () => {
  const f = fixture();
  try {
    expect(f.problem()).toBeDefined();
    f.insert();
    expect(f.problem()).toBeUndefined();
  } finally {
    f.db.close();
  }
});

const corruptions: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  "missing report": (f) => {
    f.report = {};
  },
  "missing required job": (f) => {
    f.report.ran = [];
  },
  "duplicate job": (f) => {
    f.report.ran = [f.job, f.job];
  },
  "wrong job kind": (f) => {
    f.job.kind = "build";
  },
  "stale SHA": (f) => {
    f.job.observation.sha = "OLD";
  },
  "wrong command": (f) => {
    f.job.observation.command = "true";
  },
  "wrong cwd": (f) => {
    f.job.observation.cwd = "/other";
  },
  "wrong contract": (f) => {
    f.job.observation.suite.contractHash = "0".repeat(64);
  },
  "wrong protocol": (f) => {
    f.job.observation.suite.binding.protocol = "unknown-v1";
  },
  "unsupported receipt version": (f) => {
    Object.assign(f.job.observation.suite, { version: 2 });
  },
  "missing receipt": (f) => {
    Object.assign(f.job.observation, { suite: undefined });
  },
  "process promoted to structured": (f) => {
    f.job.observation.suite.evidence = "structured";
  },
  "timeout hidden by aggregate": (f) => {
    f.job.observation.timedOut = true;
  },
  "failed exit hidden by aggregate": (f) => {
    f.job.observation.exitCode = 1;
    f.job.observation.outcome = "completed-nonzero";
  },
  "deleted expected contract reference": (f) => {
    f.report.suiteRequirementsHash = undefined;
  },
};
for (const [name, corrupt] of Object.entries(corruptions))
  test(`required-suite rejection: ${name}`, () => {
    const f = fixture();
    try {
      corrupt(f);
      f.insert(f.report);
      expect(f.problem()).toBeDefined();
    } finally {
      f.db.close();
    }
  });

test("deleting a report's requirement list cannot excuse a required suite", () => {
  const f = fixture();
  try {
    for (const requiredSuites of [undefined, null, {}, []]) {
      f.insert({
        suiteRequirementsHash: requirementsHash(f.contract),
        requiredSuites,
        ran: [{ label: "other:test", kind: "test", exitCode: 0, timedOut: false }],
      });
      expect(f.problem()).toBeDefined();
    }
  } finally {
    f.db.close();
  }
});

test("latest missing evidence supersedes a prior valid pass at the same head", () => {
  const f = fixture();
  try {
    f.insert();
    expect(f.problem()).toBeUndefined();
    f.insert({});
    expect(f.problem()).toBeDefined();
  } finally {
    f.db.close();
  }
});

test("one-hop documentation carry validates the original contract and measurement", () => {
  const f = fixture();
  try {
    f.insert();
    carryVerifiedVerdictForward(f.db, f.ticketId, "DOCS");
    expect(f.problem("DOCS")).toBeUndefined();
    carryVerifiedVerdictForward(f.db, f.ticketId, "DOCS2");
    expect(f.problem("DOCS2")).toContain("one-hop");
  } finally {
    f.db.close();
  }
});
for (const field of ["ran", "suiteRequirementsHash"])
  test(`documentation carry rejects altered ${field}`, () => {
    const f = fixture();
    try {
      f.insert();
      f.insert(
        {
          ...f.report,
          carriedForward: true,
          carriedFrom: "HEAD",
          [field]: field === "ran" ? [] : "changed",
        },
        "DOCS",
      );
      expect(f.problem("DOCS")).toBeDefined();
    } finally {
      f.db.close();
    }
  });

test("generic pass reader rejects invalid structured evidence instead of trusting exit0", () => {
  const f = fixture();
  try {
    f.job.observation.suite.verdict = "error";
    f.insert();
    const last = listByTicket(f.db, f.ticketId).at(-1);
    if (!last) throw Error("missing fixture signal");
    expect(isExecutedPass(last)).toBe(false);
  } finally {
    f.db.close();
  }
});

test("declared browser count cannot be replaced by the observed count", () => {
  const binding = { protocol: "karma-v1", parameters: { browsers: ["Firefox", "Chrome"] } };
  const partial = {
    version: 1,
    browsers: [
      {
        id: "1",
        name: "Firefox",
        success: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        error: false,
        completed: true,
        runtimeErrors: 0,
        disconnected: false,
      },
    ],
    success: 1,
    failed: 0,
    exitCode: 0,
    error: false,
    disconnected: false,
  };
  const run = { exitCode: 0, timedOut: false };
  const r = suiteReceipt("npm test", "/repo", binding, partial, run);
  expect(r.verdict).toBe("error");
  const forged = suiteReceipt(
    "npm test",
    "/repo",
    { ...binding, parameters: { browsers: ["Firefox"] } },
    partial,
    run,
  );
  expect(forged.verdict).toBe("pass");
  expect(receiptVerdict(forged, "npm test", "/repo", run, binding)).toBe("error");
});

test("unknown adapters cannot inherit process execution or stale authored-check authority", () => {
  const c = component("python");
  if (!c.testEnvironment) throw Error("fixture missing plan");
  Object.assign(c.testEnvironment, { adapter: "toString" });
  expect(testCapabilities(c.testEnvironment).suite).toBe("unsupported");
  expect(frameworkFor(c)).toBeNull();
  expect(() => suiteBinding(c.testEnvironment)).toThrow("No suite adapter");
});

test("native receipts without their independent declaration cannot masquerade as legacy evidence", () => {
  const f = fixture();
  try {
    f.db.query("DELETE FROM ground_truth_signal WHERE signal_type='suite-requirements'").run();
    f.insert({ ran: [f.job] });
    expect(f.problem()).toContain("independent declaration");
  } finally {
    f.db.close();
  }
});

test("malformed declarations and duplicate obligations fail loudly", () => {
  const f = fixture();
  try {
    f.insert();
    for (const declaration of [
      {},
      { ...f.contract, version: 2 },
      { ...f.contract, requirements: [...f.contract.requirements, ...f.contract.requirements] },
    ]) {
      insertSignal(f.db, {
        ticketId: f.ticketId,
        signalType: "suite-requirements",
        result: "pass",
        detail: declaration,
      });
      expect(f.problem()).toContain("Malformed");
    }
  } finally {
    f.db.close();
  }
});

test("a changed required contract invalidates an old completed sweep", () => {
  const f = fixture();
  try {
    f.insert();
    const changed = structuredClone(f.contract);
    changed.requirements[0].command = "python3 -m pytest tests/new.py";
    insertSignal(f.db, {
      ticketId: f.ticketId,
      signalType: "suite-requirements",
      result: "pass",
      detail: changed,
    });
    expect(f.problem()).toContain("matching integration contract");
  } finally {
    f.db.close();
  }
});

test("explicit required suite cannot be hidden by a non-primary role", () => {
  expect(() =>
    parseProfile({
      slug: "test",
      targetRepo: "/repo",
      components: [
        {
          name: "web",
          kind: "node",
          role: "example",
          paths: ["**"],
          commands: { test: "npm test" },
          testPolicy: { suite: "required" },
        },
      ],
    }),
  ).toThrow();
});

for (const op of ["push", "pr_create"])
  test(`already queued ${op} cannot drain around a missing required suite`, async () => {
    const f = fixture();
    try {
      const { enqueue, listPending } = await import("../../src/db/repos/projection-outbox.ts");
      const { drainOutbox } = await import("../../src/daemon/projector.ts");
      const { fakeIssueTracker } = await import(
        "../../src/integrations/adapters/fake-issue-tracker.ts"
      );
      enqueue(f.db, {
        ticketId: f.ticketId,
        target: "forge",
        op,
        payload:
          op === "push"
            ? { branch: "fix/test", sha: "HEAD", remote: "origin", repoPath: "/repo" }
            : {},
        idempotencyKey: `test-${op}`,
      });
      const result = await drainOutbox(f.db, { issueTracker: fakeIssueTracker() });
      expect(result.sent).toBe(0);
      const pending = listPending(f.db);
      expect(pending).toHaveLength(1);
      expect(pending[0].error).toContain("Required suites");
    } finally {
      f.db.close();
    }
  });

test("unchanged required contracts can resume merge; new head or failed snapshot cannot publish", async () => {
  const f = fixture();
  try {
    const { buildDispatchRegistry } = await import("../../src/dispatch/handlers.ts");
    const { FakeAgentRunner } = await import("../../src/agent/fake-runner.ts");
    const { DEFAULT_AGENT_CONFIG } = await import("../../src/config/agent-config.ts");
    const { insertDispatch, completeDispatch } = await import("../../src/db/repos/dispatch.ts");
    const { setTicketStage } = await import("../../src/db/repos/ticket.ts");
    f.db.query("UPDATE project SET target_repo='/repo'").run();
    setTicketStage(f.db, f.ticketId, "merge");
    const dispatch = insertDispatch(f.db, { ticketId: f.ticketId, dispatchId: "d1", seq: 1 });
    completeDispatch(f.db, dispatch.id, { outcome: "clean-success", branchHeadSha: "HEAD" });
    const c = component("python");
    c.testPolicy = { suite: "required" };
    const profile = parseProfile({ slug: "test", targetRepo: "/repo", components: [c] });
    const registry = buildDispatchRegistry({
      profile,
      inPlace: true,
      worktreeRoot: "/unused",
      runner: new FakeAgentRunner(() => {
        throw Error("must not dispatch");
      }),
      agentConfig: DEFAULT_AGENT_CONFIG,
    });
    f.insert();
    expect(() => registry.synchronize(f.db, f.ticketId)).not.toThrow();
    completeDispatch(f.db, dispatch.id, { outcome: "clean-success", branchHeadSha: "CHANGED" });
    expect(() => registry.synchronize(f.db, f.ticketId)).toThrow("Required suites");
    profile.components.push(profile.components[0]);
    expect(() => registry.synchronize(f.db, f.ticketId)).toThrow("Duplicate component");
    expect(f.problem()).toContain("Malformed required-suite declaration");
  } finally {
    f.db.close();
  }
});
