import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { adoptUnfingerprinted } from "../../src/daemon/adopt.ts";
import { FINGERPRINT_SCHEME } from "../../src/daemon/canonical.ts";
import {
  EMPTY_PLAN_DIGEST,
  currentManifest,
  planDigestAt,
  ticketPlanFilesAt,
} from "../../src/daemon/design-digests.ts";
import { type DesignStepKey, type StepRow, stepRow } from "../../src/daemon/design-graph.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getByKey, recordManifest } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { resetProvision } from "../../src/dispatch/provision.ts";
import { copyRecordedRun } from "../helpers/db-fixtures.ts";
import { harnessProfileRaw } from "../helpers/design-script.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  git,
  gitRepo,
  makeDesignTicket,
} from "../helpers/design-steps.ts";
import { makeTempDir, onTempCleanup } from "../helpers/temp.ts";

const stepRowOf = (k: DesignStepKey): StepRow => {
  const row = stepRow(k);
  if (!row) throw new Error(`no table row ${k}`);
  return row;
};

test(
  "a run whose design steps all carry manifests adopts nothing and writes no event",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const r = adoptUnfingerprinted(t.db, t.ticketId, { repoPath: t.repo, branch: "feat/ENG-1" });
    expect(r).toEqual({ adopted: [], willRerun: [] });
    expect(listEvents(t.db, t.ticketId).some((e) => e.reason === "adopted")).toBe(false);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a manifest from an older scheme is never adopted again (ruling 2026-10-09)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const step = getByKey(t.db, t.ticketId, "design:extract");
    if (!step?.input_manifest) throw new Error("design:extract recorded no manifest");
    recordManifest(t.db, step.id, {
      manifest: JSON.parse(step.input_manifest) as Record<string, string>,
      fingerprint: step.input_fingerprint ?? "",
      outputDigest: null,
      scheme: FINGERPRINT_SCHEME - 1,
    });
    const r = adoptUnfingerprinted(t.db, t.ticketId, { repoPath: t.repo, branch: "feat/ENG-1" });
    expect(r).toEqual({ adopted: [], willRerun: [] });
    expect(getByKey(t.db, t.ticketId, "design:extract")?.fingerprint_scheme).toBe(
      FINGERPRINT_SCHEME - 1,
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a reused database whose ticket branch is gone: design:dispatch and every step after it will rerun",
  () => {
    // A v8 run paused in implement, its database reused against a repository without the branch.
    const dbPath = join(copyRecordedRun("v8-paused-worktree"), "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    try {
      const ticketId = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
      const repo = gitRepo(); // no feat/ENG-1 here
      captureSnapshot(db, ticketId, {
        profile: parseProfile(harnessProfileRaw(repo, "fixture")),
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: DEFAULT_RUNTIME_CONFIG,
      });
      const willRerun = [
        "design:dispatch",
        "design:extract",
        "design:size",
        "design:review",
      ] as const;
      expect(adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" })).toEqual({
        adopted: ["provision"],
        willRerun: [...willRerun],
      });
      for (const k of willRerun) {
        expect(getByKey(db, ticketId, k)?.input_manifest).toBe("{}");
        expect(getByKey(db, ticketId, k)?.fingerprint_scheme).toBe(1);
      }
      const note = listEvents(db, ticketId).find((e) => e.reason === "adopted");
      expect(JSON.parse(note?.payload_json ?? "{}").willRerun).toEqual(willRerun);
    } finally {
      db.close();
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a v8 run paused during a redesign: the pass stops at the pending design:dispatch and nothing throws (C1)",
  () => {
    // v8's redesign reset design:dispatch, design:extract and design:review but kept design:size
    // succeeded; the regenerated design:dispatch then paused. Adopting design:size (grading on)
    // would read the plan digest of a design:dispatch that has none.
    const dir = copyRecordedRun("v8-redesign-graded-worktree");
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    try {
      const ticketId = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
      const repo = gitRepo();
      captureSnapshot(db, ticketId, {
        profile: parseProfile(harnessProfileRaw(repo, "fixture")),
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: { ...DEFAULT_RUNTIME_CONFIG, complexityGrading: true },
      });
      expect(adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" })).toEqual({
        adopted: ["provision"],
        willRerun: ["design:size"],
      });
      expect(getByKey(db, ticketId, "design:size")?.input_manifest).toBe("{}");
      expect(getByKey(db, ticketId, "design:dispatch")?.input_manifest).toBeNull(); // not succeeded
    } finally {
      db.close();
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

/** A recorded v8 run's private copy: its database migrated to this binary's schema and snapshotted
 *  as a resume would, and its repository restored from the bundle with the ticket branch. */
function restoredRun(name: "v8-paused-worktree" | "v8-redesign-graded-worktree") {
  const dir = copyRecordedRun(name);
  const parent = realpathSync(makeTempDir("styre-adopt-repo-"));
  git(parent, ["clone", "-q", join(dir, "repo.bundle"), "repo"]);
  const repo = join(parent, "repo");
  git(repo, ["branch", "feat/ENG-1", "origin/feat/ENG-1"]);
  const dbPath = join(dir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  onTempCleanup(() => db.close());
  const ticketId = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
  captureSnapshot(db, ticketId, {
    profile: parseProfile(harnessProfileRaw(repo, "fixture")),
    unusableComponents: [],
    nonPrimaryComponents: [],
    config: DEFAULT_RUNTIME_CONFIG,
  });
  return { db, ticketId, repo };
}

const ALL_STEPS = [
  "provision",
  "design:dispatch",
  "design:extract",
  "design:size",
  "design:review",
] as const;

test(
  "a v8 run paused in implement: every design step is adopted in table order, with one note, and the plan read at the branch even when a tag has its name",
  () => {
    const { db, ticketId, repo } = restoredRun("v8-paused-worktree");
    // a tag named like the branch, on a commit without the plan: a bare branch name selects it
    git(repo, ["tag", "feat/ENG-1", "main"]);
    expect(ticketPlanFilesAt(repo, "feat/ENG-1", "ENG-1")).toEqual([]);
    const r = adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" });
    expect(r).toEqual({ adopted: [...ALL_STEPS], willRerun: [] });
    const plan = planDigestAt(repo, "refs/heads/feat/ENG-1", "ENG-1");
    expect(plan).not.toBe(EMPTY_PLAN_DIGEST);
    expect(getByKey(db, ticketId, "design:dispatch")?.output_digest).toBe(plan);
    for (const k of ALL_STEPS) {
      const step = getByKey(db, ticketId, k);
      expect(step?.fingerprint_scheme).toBe(FINGERPRINT_SCHEME);
      expect(JSON.parse(step?.input_manifest ?? "null")).toEqual(
        currentManifest(db, ticketId, stepRowOf(k)),
      );
    }
    const notes = listEvents(db, ticketId).filter((e) => e.reason === "adopted");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.kind).toBe("note");
    expect(JSON.parse(notes[0]?.payload_json ?? "{}")).toEqual({
      event: "adopted",
      stepKeys: [...ALL_STEPS],
      willRerun: [],
      message:
        "these design steps finished under an older Styre; their inputs are recorded as they are now, so an edit made between the pause and the upgrade cannot be detected. Those under willRerun finished after a step that has not, so they run again once it has",
    });
    // a second pass finds nothing left to record and writes no event
    expect(adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" })).toEqual({
      adopted: [],
      willRerun: [],
    });
    expect(listEvents(db, ticketId).filter((e) => e.reason === "adopted")).toHaveLength(1);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a provision reset for a recreated worktree does not stop the pass: the design steps after it are adopted",
  () => {
    const { db, ticketId, repo } = restoredRun("v8-paused-worktree");
    resetProvision(db, ticketId); // what every worktree mode resume does before the pass
    expect(getByKey(db, ticketId, "provision")?.status).toBe("pending");
    expect(adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" })).toEqual({
      adopted: ["design:dispatch", "design:extract", "design:size", "design:review"],
      willRerun: [],
    });
    expect(getByKey(db, ticketId, "provision")?.input_manifest).toBeNull(); // it reruns instead
  },
  STEP_TEST_TIMEOUT_MS,
);
