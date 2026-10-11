import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import {
  type RecordedMeta,
  type RecordedRun,
  copyRecordedRun,
  fixtureVersion,
} from "../helpers/db-fixtures.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { unitsOf } from "../helpers/design-script.ts";
import { git } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The resumed run's agent: the same two units the recordings extracted, no plan findings. */
const RESUME_SCRIPT = { units: () => unitsOf(2, { behavioral: false }), planFindings: () => [] };
const DESIGN_AGENTS = [
  "design:dispatch",
  "design:extract",
  "design:size",
  "design:review",
] as const;

/** Restore a recorded v8 run from a private copy: its repository from the bundle, its checkpoint
 *  into the harness's state folder. The recording's absolute repository path does not exist here,
 *  so the project row is pointed at the restored repository: the one direct write, and it is a
 *  relocation, not state. */
function restoreRecordedRun(name: RecordedRun): { h: DesignHarness; meta: RecordedMeta } {
  const recorded = copyRecordedRun(name);
  const meta = JSON.parse(readFileSync(join(recorded, "meta.json"), "utf8")) as RecordedMeta;
  const parent = realpathSync(makeTempDir("styre-v8-restored-"));
  git(parent, ["clone", "-q", join(recorded, "repo.bundle"), "repo"]);
  const repo = join(parent, "repo");
  git(repo, ["branch", meta.branch, `origin/${meta.branch}`]);
  git(repo, ["config", "user.email", "t@s.dev"]);
  git(repo, ["config", "user.name", "T"]);
  const h = new DesignHarness("worktree", { slug: meta.slug, repoDir: repo });
  harnesses.push(h);
  mkdirSync(h.checkpointDir(), { recursive: true });
  copyFileSync(join(recorded, "run.db"), h.dbPath());
  const transcript = join(recorded, "transcript.json");
  if (existsSync(transcript)) {
    copyFileSync(transcript, join(h.checkpointDir(), "transcript.json"));
  }
  const db = new Database(h.dbPath());
  db.query("UPDATE project SET target_repo = ?").run(repo);
  db.close();
  return { h, meta };
}

const adoptedNote = (h: DesignHarness) =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "adopted")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as Record<string, unknown>),
  );
const invalidations = (h: DesignHarness) =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "invalidated")
      .map(
        (e) =>
          JSON.parse(e.payload_json ?? "{}") as {
            event: string;
            stepKeys: string[];
            cause: string;
            changed: string[];
          },
      )
      .map((p) => `${p.stepKeys.join("+")}:${p.cause}`),
  );

test(
  "D9: a v8 run paused in worktree mode resumes, is adopted, reruns no finished design step, and completes",
  async () => {
    const { h } = restoreRecordedRun("v8-paused-worktree");
    expect(fixtureVersion(h.dbPath())).toBe(8);
    const code = await h.resume({ script: RESUME_SCRIPT });
    expect(code).toBe(0); // pr-ready
    expect(fixtureVersion(h.dbPath())).toBe(9);
    const backup = /^run\.db\.v8\.\d{8}T\d{9}Z\.bak$/;
    expect(readdirSync(h.checkpointDir()).some((f) => backup.test(f))).toBe(true);
    for (const s of DESIGN_AGENTS) expect(h.calls.counts[s]).toBe(0); // no design agent ran again
    const notes = adoptedNote(h);
    expect(notes).toHaveLength(1);
    // provision was reset for the recreated worktree before the pass, so it reran instead
    expect(notes[0]?.stepKeys).toEqual([...DESIGN_AGENTS]);
    expect(notes[0]?.willRerun).toEqual([]);
    expect(String(notes[0]?.message)).toContain("cannot be detected");
    expect(invalidations(h)).toEqual(["provision:worktree-recreated"]);
    h.read((db, id) => {
      for (const k of ["provision", ...DESIGN_AGENTS]) {
        expect(getByKey(db, id, k)?.fingerprint_scheme).toBe(1);
      }
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "--inspect on a v8 checkpoint reports the upgrade a resume would make, and makes none",
  async () => {
    const { h } = restoreRecordedRun("v8-paused-worktree");
    expect(await h.resume({ inspect: true })).toBe(0);
    const out = h.stderr.join("");
    expect(out).toContain(
      "resume will upgrade this checkpoint from v8 to v9, after writing a backup",
    );
    expect(out).toContain("would re-dispatch step: implement:wu1:dispatch");
    expect(fixtureVersion(h.dbPath())).toBe(8); // not migrated
    expect(readdirSync(h.checkpointDir()).some((f) => f.endsWith(".bak"))).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

/** The operator's way out of the plan review gate: edit the plan on the ticket branch. */
function editPlanOnBranch(h: DesignHarness, branch: string): void {
  const wt = join(makeTempDir("styre-v8-edit-"), "wt");
  git(h.repoDir, ["worktree", "add", wt, branch]);
  writeFileSync(
    join(wt, "docs", "plans", "eng-1-plan.md"),
    "---\nlinear: ENG-1\n---\n\nRecorded plan, edited by the operator\n",
  );
  git(wt, ["commit", "-q", "-am", "operator edits the plan"]);
  git(h.repoDir, ["worktree", "remove", "--force", wt]);
}

test(
  "a v8 run stopped at the plan review gate, resumed with HEAD unchanged, stays at the gate; the operator's plan edit then finishes it",
  async () => {
    const { h, meta } = restoreRecordedRun("v8-plan-gate-worktree");
    expect(await h.resume({ script: RESUME_SCRIPT })).toBe(75); // the same findings: still stopped
    expect(fixtureVersion(h.dbPath())).toBe(9);
    const first = adoptedNote(h);
    expect(first).toHaveLength(1);
    expect(first[0]?.stepKeys).toEqual([...DESIGN_AGENTS]); // every design step had succeeded
    expect(first[0]?.willRerun).toEqual([]);
    h.read((db, id) => {
      expect(getTicket(db, id)?.status).toBe("waiting");
      const events = listEvents(db, id);
      const resumedAt = events.findLastIndex((e) => e.kind === "resumed");
      const escalated = events.slice(resumedAt + 1).filter((e) => e.kind === "escalated");
      expect(escalated).toHaveLength(1); // stopped again at the gate by the resume itself
    });
    for (const s of DESIGN_AGENTS) expect(h.calls.counts[s]).toBe(0);

    editPlanOnBranch(h, meta.branch);
    expect(await h.resume({ acceptHead: true, script: RESUME_SCRIPT })).toBe(0); // pr-ready
    expect(h.calls.counts["design:dispatch"]).toBe(1); // the redesign
    expect(h.calls.counts["design:extract"]).toBe(1);
    expect(h.calls.counts["design:review"]).toBe(1); // the plan changed
    expect(invalidations(h)).toEqual([
      "provision:worktree-recreated",
      "design:dispatch+design:extract:feedback",
      "design:review:inputs",
    ]); // design:size stays done: the same units
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a v8 run stopped at the plan review gate, resumed after the operator edited the plan, finishes",
  async () => {
    const { h, meta } = restoreRecordedRun("v8-plan-gate-worktree");
    editPlanOnBranch(h, meta.branch);
    expect(await h.resume({ acceptHead: true, script: RESUME_SCRIPT })).toBe(0); // pr-ready
    const notes = adoptedNote(h);
    expect(notes).toHaveLength(1);
    // the resume's redesign left design:dispatch pending: size and review are past it
    expect(notes[0]?.stepKeys).toEqual([]);
    expect(notes[0]?.willRerun).toEqual(["design:size", "design:review"]);
    expect(invalidations(h)).toEqual([
      "provision:worktree-recreated",
      "design:dispatch+design:extract:feedback",
      "design:size:inputs",
      "design:review:inputs",
    ]);
    expect(h.calls.counts["design:review"]).toBe(1);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a v8 run paused during a redesign with grading on resumes, reruns the steps past the pause, and finishes",
  async () => {
    const { h } = restoreRecordedRun("v8-redesign-graded-worktree");
    h.editConfig((c) => {
      c.complexityGrading = true;
    });
    expect(await h.resume({ script: RESUME_SCRIPT })).toBe(0); // pr-ready
    const notes = adoptedNote(h);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.stepKeys).toEqual([]);
    expect(notes[0]?.willRerun).toEqual(["design:size"]); // succeeded under v8, past the pause
    expect(invalidations(h)).toEqual(["provision:worktree-recreated", "design:size:inputs"]);
    expect(h.calls.counts["design:size"]).toBe(1); // the grader, once
    const dispatch = h.calls.prompts.find((p) => p.step === "design:dispatch")?.prompt ?? "";
    expect(dispatch).toContain("RECORDED-BLOCKING-FINDING"); // the v8 redesign's feedback
    expect(dispatch).toContain("partial output written before the session limit"); // the carryover
  },
  HARNESS_TEST_TIMEOUT_MS,
);
