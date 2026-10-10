import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { digestValue } from "../../src/daemon/canonical.ts";
import {
  currentManifest,
  digestWorkUnits,
  inputContext,
  planDigestAt,
  recordStepManifest,
} from "../../src/daemon/design-digests.ts";
import * as designGraph from "../../src/daemon/design-graph.ts";
import {
  DESIGN_TABLE,
  type StepRow,
  isSnapshotInput,
  stepRow,
} from "../../src/daemon/design-graph.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getInput } from "../../src/db/repos/ticket-input.ts";
import {
  getTicket,
  insertTicket,
  setTicketStage,
  setTicketTrack,
} from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { makeTestDb } from "../helpers/db.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  git,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

// A step that dispatched an agent starts a background leftover check (ENG-485 section 9.1); one still
// running when the test ends keeps the command temp folder.
afterEach(pendingLeftoverChecks);

const rows = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");

test(
  "every design step records its manifest, fingerprint and scheme at success; the plan its digest",
  async () => {
    const t = makeDesignTicket(); // two behavioural units: full track, design:review runs
    await driveUntil(t, atStep("checks:dispatch"));
    for (const row of rows) {
      const step = getByKey(t.db, t.ticketId, row.stepKey);
      expect(step?.status).toBe("succeeded");
      const manifest = JSON.parse(step?.input_manifest ?? "null") as Record<string, string>;
      expect(Object.keys(manifest).sort()).toEqual(
        [...row.inputs(inputContext(t.db, t.ticketId))].sort(),
      );
      expect(step?.input_fingerprint).toBe(digestValue(manifest));
      expect(step?.fingerprint_scheme).toBe(1);
      expect(manifest).toEqual(currentManifest(t.db, t.ticketId, row)); // stable on recompute
      if (row.fileOutput)
        expect(step?.output_digest).toBe(planDigestAt(t.repo, "feat/ENG-1", "ENG-1"));
      else expect(step?.output_digest).toBeNull();
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "provision run while the ticket is in implement records its manifest too (§5.2)",
  async () => {
    const t = makeDesignTicket();
    setTicketStage(t.db, t.ticketId, "implement");
    insertWorkUnit(t.db, { ticketId: t.ticketId, seq: 1, kind: "backend", status: "verifying" });
    const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    expect(outcome).toEqual({ kind: "stepped", stepKey: "provision" });
    expect(getByKey(t.db, t.ticketId, "provision")?.input_manifest).not.toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:dispatch escalates at once, retrying nothing, when its plan is not committed at the branch head",
  async () => {
    // The target repository ignores docs/plans/: the agent writes the plan, the postcondition sees
    // it in the worktree, the commit stages nothing, and the digest would be the empty list forever.
    const t = makeDesignTicket({
      repoSetup: (repo) => {
        writeFileSync(join(repo, ".gitignore"), "docs/plans/\n");
        git(repo, ["add", ".gitignore"]);
        git(repo, ["commit", "-q", "-m", "ignore the plans"]);
      },
    });
    await driveUntil(t, atStep("design:dispatch"));
    const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    // operator ruling, 2026-10-10: not retryable (a StepPrerequisiteError): the step records
    // attempt 1, its one execution, and no retry is spent; the operator is told what to change
    expect(outcome).toEqual({ kind: "escalated", stepKey: "design:dispatch" });
    expect(t.calls.counts["design:dispatch"]).toBe(1);
    const step = getByKey(t.db, t.ticketId, "design:dispatch");
    expect(step?.status).toBe("failed");
    expect(step?.attempt).toBe(1);
    expect(getTicket(t.db, t.ticketId)?.status).toBe("waiting");
    const reason = listPending(t.db, t.ticketId).find(
      (p) => p.signal_type === "human_resume",
    )?.reason;
    expect(reason).toContain("the plan for ENG-1 is not committed");
    expect(reason).toContain("remove docs/plans/ from .gitignore");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a table step does not run without a snapshot; the run stops loudly",
  async () => {
    const { db } = makeTestDb({ seedTicket: false });
    const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/x" });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-3" });
    const registry = new StepRegistry();
    let ran = false;
    registry.register("provision", () => {
      ran = true;
      return {};
    });
    await expect(
      advanceOneStep(db, ticketId, registry, { config: DEFAULT_RUNTIME_CONFIG }),
    ).rejects.toThrow("ticket_input is missing");
    expect(ran).toBe(false);
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

// ── Beyond the brief: the success transaction's contents and order (spec §5.2, §6.2) ──────────

test(
  "the step's own commit runs inside its success transaction, before its manifest",
  async () => {
    const { db, ticketId } = makeTestDb();
    const registry = new StepRegistry();
    // Recorded, then asserted after: an expect inside the transaction would fail the step instead.
    const atCommit: Array<{ status?: string; manifest?: string | null; result: unknown }> = [];
    registry.register("provision", () => ({ made: 1 }), {
      commit: (cdb, tid, result) => {
        const s = getByKey(cdb, tid, "provision");
        atCommit.push({ status: s?.status, manifest: s?.input_manifest, result });
      },
    });
    const outcome = await advanceOneStep(db, ticketId, registry);
    expect(outcome).toEqual({ kind: "stepped", stepKey: "provision" });
    // already marked succeeded (same transaction), manifest not yet written (commit comes first)
    expect(atCommit).toEqual([{ status: "succeeded", manifest: null, result: { made: 1 } }]);
    expect(getByKey(db, ticketId, "provision")?.input_manifest).not.toBeNull();
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a failing commit leaves no success, no manifest, no fingerprint and none of the commit's writes",
  async () => {
    const { db, ticketId } = makeTestDb();
    const registry = new StepRegistry();
    registry.register("provision", () => ({}), {
      commit: (cdb, tid) => {
        setTicketTrack(cdb, tid, "full");
        throw new Error("commit boom");
      },
    });
    const outcome = await advanceOneStep(db, ticketId, registry);
    expect(outcome).toEqual({ kind: "escalated", stepKey: "provision" }); // a provision failure escalates
    const step = getByKey(db, ticketId, "provision");
    expect(step?.status).toBe("failed");
    expect(JSON.parse(step?.error_json ?? "{}").message).toBe("commit boom");
    expect(step?.result_json).toBeNull();
    expect(step?.input_manifest).toBeNull();
    expect(step?.input_fingerprint).toBeNull();
    expect(step?.fingerprint_scheme).toBeNull();
    expect(step?.output_digest).toBeNull();
    expect(getTicket(db, ticketId)?.track).toBeNull();
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a design:dispatch result without a plan digest fails the step loudly and rolls its commit back",
  async () => {
    const { db, ticketId } = makeTestDb();
    const registry = new StepRegistry();
    registry.register("provision", () => ({}));
    registry.register("design:dispatch", () => ({ plan: "ok" }), {
      commit: (cdb, tid) => setTicketTrack(cdb, tid, "full"),
    });
    expect(await advanceOneStep(db, ticketId, registry)).toEqual({
      kind: "stepped",
      stepKey: "provision",
    });
    const outcome = await advanceOneStep(db, ticketId, registry);
    expect(outcome).toEqual({ kind: "retry", stepKey: "design:dispatch" });
    const step = getByKey(db, ticketId, "design:dispatch");
    expect(JSON.parse(step?.error_json ?? "{}").message).toBe(
      "design:dispatch succeeded without a plan digest",
    );
    expect(step?.result_json).toBeNull();
    expect(step?.input_manifest).toBeNull();
    expect(step?.output_digest).toBeNull();
    expect(getTicket(db, ticketId)?.track).toBeNull();
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the manifest is recorded before the verdict: a redesign that deletes the units leaves the manifest of the units reviewed, and the stale plan digest is never read",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: () => [
          {
            severity: "critical",
            category: "feasibility",
            location: "plan:Task 1",
            rationale: "not feasible",
            factors: null,
            deferral_candidate: false,
            work_unit_seq: null,
          },
        ],
      },
    });
    await driveUntil(t, atStep("design:review"));
    const reviewed = digestWorkUnits(t.db, t.ticketId);
    expect(listUnits(t.db, t.ticketId)).toHaveLength(2);
    const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    expect(outcome).toEqual({ kind: "loopback", stepKey: "design:review" });
    expect(listUnits(t.db, t.ticketId)).toEqual([]); // the verdict deleted them
    expect(digestWorkUnits(t.db, t.ticketId)).not.toBe(reviewed);
    const manifest = JSON.parse(
      getByKey(t.db, t.ticketId, "design:review")?.input_manifest ?? "null",
    ) as Record<string, string>;
    expect(manifest.workUnits).toBe(reviewed);
    // The redesign returned design:dispatch to pending with its old digest still on the row: that
    // digest is no longer the plan's, so a manifest that reads the plan throws instead of using it.
    const dispatch = getByKey(t.db, t.ticketId, "design:dispatch");
    expect(dispatch?.status).toBe("pending");
    expect(dispatch?.output_digest).not.toBeNull();
    const extract = stepRow("design:extract");
    expect(extract).toBeDefined();
    if (!extract) return;
    expect(() => currentManifest(t.db, t.ticketId, extract)).toThrow(
      `ticket ${t.ticketId}: the plan has no recorded digest (design:dispatch is pending)`,
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a manifest that needs the plan's digest before design:dispatch recorded one throws loudly",
  () => {
    const { db, ticketId } = makeTestDb();
    const extract = stepRow("design:extract");
    expect(extract).toBeDefined();
    if (!extract) return;
    expect(() => currentManifest(db, ticketId, extract)).toThrow(
      `ticket ${ticketId}: the plan has no recorded digest (design:dispatch is absent)`,
    );
    // plan findings are never a fingerprinted input
    expect(() =>
      currentManifest(db, ticketId, { ...extract, inputs: () => ["planFindings"] }),
    ).toThrow("plan findings are read only by the gate");
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a table step checks the design table before it runs; a broken table stops the run before the handler",
  async () => {
    const { db, ticketId } = makeTestDb();
    const registry = new StepRegistry();
    let ran = false;
    registry.register("provision", () => {
      ran = true;
      return {};
    });
    const check = spyOn(designGraph, "ensureDesignTableChecked").mockImplementation(() => {
      throw new Error("the declared design table breaks its own rules");
    });
    try {
      await expect(advanceOneStep(db, ticketId, registry)).rejects.toThrow(
        "the declared design table breaks its own rules",
      );
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      check.mockRestore();
    }
    expect(ran).toBe(false);
    expect(getByKey(db, ticketId, "provision")).toBeNull(); // no row, no attempt spent
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

for (const complexityGrading of [false, true]) {
  test(
    `each manifest entry is its input's own digest, the snapshot row's or the upstream output's (grading ${complexityGrading ? "on" : "off"})`,
    async () => {
      // Checked against the digests where they are kept, never against currentManifest itself.
      const t = makeDesignTicket({ config: { complexityGrading } });
      await driveUntil(t, atStep("checks:dispatch"));
      const plan = getByKey(t.db, t.ticketId, "design:dispatch")?.output_digest;
      expect(plan).toBe(planDigestAt(t.repo, "feat/ENG-1", "ENG-1"));
      const outputs: Record<string, string | null | undefined> = {
        plan,
        workUnits: digestWorkUnits(t.db, t.ticketId), // unchanged since design:extract wrote them
      };
      let entries = 0;
      for (const row of rows) {
        const manifest = JSON.parse(
          getByKey(t.db, t.ticketId, row.stepKey)?.input_manifest ?? "null",
        ) as Record<string, string>;
        for (const [name, digest] of Object.entries(manifest)) {
          const kept = isSnapshotInput(name)
            ? getInput(t.db, t.ticketId, name)?.digest
            : outputs[name];
          expect(`${row.stepKey} ${name} ${digest}`).toBe(`${row.stepKey} ${name} ${kept}`);
          entries++;
        }
      }
      // provision 3, design:dispatch 6, design:extract 7, design:size 2 (6 with grading on),
      // design:review 5
      expect(entries).toBe(complexityGrading ? 27 : 23);
    },
    STEP_TEST_TIMEOUT_MS,
  );
}

test(
  "a manifest that needs the plan's digest while design:dispatch is failed throws, naming its status",
  async () => {
    const t = makeDesignTicket({
      repoSetup: (repo) => {
        writeFileSync(join(repo, ".gitignore"), "docs/plans/\n");
        git(repo, ["add", ".gitignore"]);
        git(repo, ["commit", "-q", "-m", "ignore the plans"]);
      },
    });
    await driveUntil(t, atStep("design:dispatch"));
    await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    expect(getByKey(t.db, t.ticketId, "design:dispatch")?.status).toBe("failed");
    const extract = stepRow("design:extract");
    expect(extract).toBeDefined();
    if (!extract) return;
    expect(() => currentManifest(t.db, t.ticketId, extract)).toThrow(
      `ticket ${t.ticketId}: the plan has no recorded digest (design:dispatch is failed)`,
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "recording design:dispatch's manifest without the digest of its file output throws, naming the step",
  () => {
    const { db, ticketId } = makeTestDb();
    const dispatch = stepRow("design:dispatch");
    expect(dispatch?.fileOutput).toBe(true);
    if (!dispatch) return;
    // Thrown before anything is read or written, so no step row is needed.
    expect(() => recordStepManifest(db, ticketId, 0, dispatch, null)).toThrow(
      "design:dispatch succeeded without the digest of its file output",
    );
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);
