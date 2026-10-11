import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { listCheckpoints } from "../../src/cli/checkpoints.ts";
import { cleanImpl } from "../../src/cli/clean.ts";
import { StyreError } from "../../src/cli/errors.ts";
import { SNAPSHOT_INPUT_NAMES } from "../../src/daemon/design-graph.ts";
import { startingCommit } from "../../src/daemon/design-inputs.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { getInput, listInputs } from "../../src/db/repos/ticket-input.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import {
  getByKey,
  insertPending,
  markRunning,
  markSucceeded,
} from "../../src/db/repos/workflow-step.ts";
import {
  DesignHarness,
  HARNESS_TEST_TIMEOUT_MS,
  seedHarnessTicket,
} from "../helpers/design-harness.ts";
import { unitsOf } from "../helpers/design-script.ts";
import { git } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

const harnesses: DesignHarness[] = [];
const make = (mode: "worktree" | "in-place" = "worktree") => {
  const h = new DesignHarness(mode);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
const fetches = (h: DesignHarness) => h.trackerCalls.filter((c) => c.method === "fetchTicket");

/** A reused database that already holds another project's tickets: OTHER-1 active and OTHER-2
 *  waiting, each with a `provision` an older Styre finished (succeeded, no manifest). Their project
 *  is paused, so the loop does not drive them in these tests (`v_ready_tickets`); the run still
 *  prepares OTHER-1, which is active.
 *
 *  A stated exception to "no faked state" (Global Constraints), for two writes:
 *  - the succeeded `provision` steps with no manifest, written through the workflow_step
 *    repository: Task 12's reused --db adopt tests need another active ticket carrying such a
 *    step (and a waiting one, which must be left alone), and only an older Styre produces one,
 *    which an in process test cannot run;
 *  - `project.paused = 1`, raw SQL: the OSS core has no writer for it (pausing a project is the
 *    commercial plane's), and without it the loop would drive the other tickets with this run's
 *    registry, against a repository that does not exist. */
function seedOtherTickets(dbFile: string): { active: number; waiting: number } {
  migrate(dbFile);
  const db = openDb(dbFile);
  try {
    const projectId = insertProject(db, { slug: "other", targetRepo: "/tmp/other" });
    db.query("UPDATE project SET paused = 1 WHERE id = ?").run(projectId);
    const active = insertTicket(db, { projectId, ident: "OTHER-1" });
    const step = insertPending(db, {
      ticketId: active,
      stepKey: "provision",
      stepType: "provision",
    });
    markRunning(db, step.id, {});
    markSucceeded(db, step.id, {});
    const waiting = insertTicket(db, { projectId, ident: "OTHER-2", status: "waiting" });
    // the same older Styre's provision on the waiting ticket: a run must leave it as it is
    const waitingStep = insertPending(db, {
      ticketId: waiting,
      stepKey: "provision",
      stepType: "provision",
    });
    markRunning(db, waitingStep.id, {});
    markSucceeded(db, waitingStep.id, {});
    return { active, waiting };
  } finally {
    db.close();
  }
}

test(
  "in place: the starting commit is HEAD at run start, unchanged by resume and --accept-head (§8.11)",
  async () => {
    const h = make("in-place");
    const head = git(h.repoDir, ["rev-parse", "HEAD"]);
    expect(await h.fresh()).toBe(75); // pauses needs_you at checks:dispatch
    expect(h.calls.counts["checks:dispatch"]).toBe(0); // the pause is the prerequisite, not an agent
    expect(h.stderr.join("")).toContain(`IN-PLACE: mutating ${h.repoDir}`);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(head);
    expect(await h.resume()).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(head);
    writeFileSync(join(h.repoDir, "operator.txt"), "an operator commit\n");
    git(h.repoDir, ["add", "operator.txt"]);
    git(h.repoDir, ["commit", "-q", "-m", "operator"]);
    expect(await h.resume()).toBe(65); // HEAD moved
    expect(await h.resume({ acceptHead: true })).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(head);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "worktree mode: the starting commit is the commit the ticket branch was created from, unchanged by resume and --accept-head (§8.11)",
  async () => {
    const h = make("worktree");
    const main = git(h.repoDir, ["rev-parse", "main"]);
    expect(await h.fresh()).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(main);
    git(h.repoDir, ["commit", "-q", "--allow-empty", "-m", "main moves on"]); // a later main commit
    expect(await h.resume()).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(main);
    // spec §8.11 asks for --accept-head too: in worktree mode the branch a resume recreates can
    // move (ENG-488, hand off note 10), which is when an operator passes it
    expect(await h.resume({ acceptHead: true })).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(main);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "worktree mode, a reused --db: another ticket's provision runs and records no starting commit; the run's own does (spec §4 ruling)",
  async () => {
    const h = make("worktree");
    const main = git(h.repoDir, ["rev-parse", "main"]);
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedHarnessTicket(dbFile, h, "OTHER-1");
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db, id) => {
      // the other ticket was driven: its provision ran in this run, with this run's registry
      expect(getByKey(db, other, "provision")?.status).toBe("succeeded");
      expect(startingCommit(db, other)).toBeNull();
      // this run inserted its own ticket, so its first provision records the branch's start
      expect(startingCommit(db, id)).toBe(main);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "worktree mode, a reused --db that already holds the run's own ticket with no starting commit: its provision records none (spec §4.2, recorded only when the branch is first created)",
  async () => {
    const h = make("worktree");
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const own = seedHarnessTicket(dbFile, h, h.ident);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db, id) => {
      expect(id).toBe(own); // the run drove the ticket the database already held
      expect(getByKey(db, id, "provision")?.status).toBe("succeeded");
      expect(startingCommit(db, id)).toBeNull();
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "E2: resume never reads the tracker; the ticket text stays as the run started",
  async () => {
    const h = make();
    expect(await h.fresh()).toBe(75);
    expect(fetches(h)).toHaveLength(1); // the probe sees the read a fresh run makes
    expect(await h.resume({ trackerTitle: "Edited in the tracker" })).toBe(75);
    expect(fetches(h)).toEqual([]); // the resume asked the tracker nothing
    h.read((db, id) => {
      expect(getTicket(db, id)?.title).toBe("Harness ticket"); // the ticket row itself
      expect(JSON.parse(getInput(db, id, "ticket.title")?.value_json ?? "null")).toBe(
        "Harness ticket",
      );
      expect(listEvents(db, id).filter((e) => e.reason === "inputs-changed")).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a reused --db records the snapshot of every active ticket in it, not only its own (ruling 2026-10-10)",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedOtherTickets(dbFile);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db) => {
      expect(
        listInputs(db, other.active)
          .map((r) => r.name)
          .sort(),
      ).toEqual([...SNAPSHOT_INPUT_NAMES].sort());
      expect(listInputs(db, other.waiting)).toEqual([]); // only active tickets
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a reused --db keeps the ticket text and rewrites the profile with an inputs-changed note",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    expect(await h.fresh({ db: dbFile })).toBe(75);
    const title = h.readAt(dbFile, (db, id) => getInput(db, id, "ticket.title"));
    expect(JSON.parse(title?.value_json ?? "null")).toBe("Harness ticket");
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    // E2: the tracker now says something else; the reused database keeps the text it started with
    expect(await h.fresh({ db: dbFile, trackerTitle: "Edited in the tracker" })).toBe(75);
    expect(fetches(h)).toHaveLength(1); // the fresh run did read the edited title
    h.readAt(dbFile, (db, id) => {
      expect(getInput(db, id, "ticket.title")).toEqual(title);
      const note = listEvents(db, id).find((e) => e.reason === "inputs-changed");
      expect(JSON.parse(note?.payload_json ?? "{}").names).toEqual(["profile.promptVars"]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

// --- Added by the implementer: the requirements the brief's tests above leave uncovered. ---

test(
  "a fresh run records every snapshot input of its own ticket before its first step",
  async () => {
    const h = make();
    expect(await h.fresh()).toBe(75);
    expect(h.calls.counts["checks:dispatch"]).toBe(0);
    h.read((db, id) => {
      // the snapshot rows, and beside them the starting commit provision recorded
      const rows = listInputs(db, id).filter((r) => r.name !== "run.startingCommit");
      expect(rows.map((r) => r.name).sort()).toEqual([...SNAPSHOT_INPUT_NAMES].sort());
      const first = db
        .query<{ at: string }, [number]>(
          "SELECT MIN(created_at) AS at FROM workflow_step WHERE ticket_id = ?",
        )
        .get(id)?.at;
      expect(first).toBeString();
      for (const r of rows) expect(r.captured_at <= String(first)).toBe(true);
      expect(JSON.parse(getInput(db, id, "profile.slug")?.value_json ?? "null")).toBe("harness");
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a resume rewrites the changed profile and config inputs with one inputs-changed note, keeping the ticket text",
  async () => {
    const h = make();
    expect(await h.fresh()).toBe(75);
    const titleAt = h.read((db, id) => getInput(db, id, "ticket.title")?.captured_at);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    h.editConfig((c) => {
      c.complexityGrading = true;
    });
    expect(await h.resume()).toBe(75);
    h.read((db, id) => {
      const notes = listEvents(db, id).filter((e) => e.reason === "inputs-changed");
      expect(notes).toHaveLength(1);
      expect(JSON.parse(notes[0].payload_json ?? "{}").names).toEqual([
        "profile.promptVars",
        "config.complexityGrading",
      ]);
      expect(JSON.parse(getInput(db, id, "profile.promptVars")?.value_json ?? "null")).toEqual({
        stack: "ruby",
        tone: "terse",
      });
      expect(JSON.parse(getInput(db, id, "config.complexityGrading")?.value_json ?? "null")).toBe(
        true,
      );
      expect(getInput(db, id, "ticket.title")?.captured_at).toBe(titleAt);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "in place, a reused --db keeps the starting commit its first run recorded, and notes the other active tickets' changed inputs",
  async () => {
    const h = make("in-place");
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedOtherTickets(dbFile);
    const head = git(h.repoDir, ["rev-parse", "HEAD"]);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    writeFileSync(join(h.repoDir, "operator.txt"), "an operator commit\n");
    git(h.repoDir, ["add", "operator.txt"]);
    git(h.repoDir, ["commit", "-q", "-m", "operator"]);
    expect(git(h.repoDir, ["rev-parse", "HEAD"])).not.toBe(head);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db, id) => {
      expect(startingCommit(db, id)).toBe(head);
      // ruling 2026-10-10: the starting commit stays this run's own ticket's. This proves only
      // that the run start (in place) writes none for OTHER-1: its project is paused, so its
      // provision never runs here and this line cannot catch provision recording for another
      // ticket. The test "worktree mode, a reused --db: another ticket's provision runs ..." does.
      expect(startingCommit(db, other.active)).toBeNull();
      // and every other active ticket gets the same snapshot, with the same note
      const notesOf = (t: number) =>
        listEvents(db, t)
          .filter((e) => e.reason === "inputs-changed")
          .map((e) => JSON.parse(e.payload_json ?? "{}").names);
      expect(notesOf(id)).toEqual([["profile.promptVars"]]);
      expect(notesOf(other.active)).toEqual([["profile.promptVars"]]);
      expect(notesOf(other.waiting)).toEqual([]);
      expect(listInputs(db, other.waiting)).toEqual([]);
      // Task 16: each run that drives a ticket again on this database restarts its loop guard
      // count. This run's own ticket existed for the second run only; OTHER-1 is active, so both
      // runs drove it again; OTHER-2 is waiting, never driven, never noted.
      const reusedNotes = (t: number) =>
        listEvents(db, t)
          .filter((e) => e.reason === "reused-database")
          .map((e) => [e.kind, JSON.parse(e.payload_json ?? "null")]);
      const note = ["note", { event: "reused-database" }];
      expect(reusedNotes(id)).toEqual([note]);
      expect(reusedNotes(other.active)).toEqual([note, note]);
      expect(reusedNotes(other.waiting)).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "in place, a repository whose HEAD cannot be read refuses the run before anything is recorded",
  async () => {
    const repo = makeTempDir("styre-unborn-");
    git(repo, ["init", "-q", "-b", "main"]); // no commit: HEAD is unborn
    const h = new DesignHarness("in-place", { repoDir: repo });
    harnesses.push(h);
    expect(await h.fresh()).toBe(78);
    expect(h.stderr.join("")).toContain(
      `styre run: cannot start in place — the HEAD of ${realpathSync(repo)} cannot be read`,
    );
    expect(h.calls.prompts).toEqual([]);
    expect(existsSync(h.dbPath())).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a reused --db runs the adopt pass for every active ticket in it, with the same note (ruling 2026-10-10)",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedOtherTickets(dbFile);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db) => {
      expect(getByKey(db, other.active, "provision")?.input_manifest).not.toBeNull();
      const note = listEvents(db, other.active).find((e) => e.reason === "adopted");
      expect(JSON.parse(note?.payload_json ?? "{}").stepKeys).toEqual(["provision"]);
      expect(listEvents(db, other.waiting).some((e) => e.reason === "adopted")).toBe(false);
      expect(getByKey(db, other.waiting, "provision")?.input_manifest).toBeNull();
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

/** What a test can see of one ticket: its events, snapshot rows, steps and toolchain signals. */
const ticketState = (db: Database, ticketId: number) => ({
  events: listEvents(db, ticketId).map((e) => `${e.kind}:${e.reason ?? ""}`),
  inputs: listInputs(db, ticketId).map((r) => `${r.name}=${r.digest}`),
  steps: db
    .query<{ s: string }, [number]>(
      "SELECT step_key || ':' || status || ':' || coalesce(input_manifest, 'null') AS s FROM workflow_step WHERE ticket_id = ? ORDER BY id",
    )
    .all(ticketId)
    .map((r) => r.s),
  toolchain: listSignals(db, ticketId).filter((s) => s.signal_type === "toolchain").length,
});

test(
  "a resume prepares every active ticket in its checkpoint, as a reused --db does (ruling 2026-10-10)",
  async () => {
    const h = make();
    // an optional component whose tools the resume's host lacks: the resume narrows it away and
    // the run's own ticket gets the toolchain advisory, which no other ticket may get
    h.editProfile((p) => {
      (p.components as unknown[]).push({
        name: "lib",
        kind: "ruby",
        paths: ["vendor-lib/**"],
        commands: { build: "lib-build", test: "lib-test", check: "lib-check" },
      });
    });
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedOtherTickets(dbFile);
    // a budget pause writes the reused database, other tickets and all, to the checkpoint
    expect(await h.fresh({ db: dbFile, script: { parkAt: "design:extract" } })).toBe(75);
    expect(existsSync(h.dbPath())).toBe(true);
    const before = h.read((db) => ({
      active: ticketState(db, other.active),
      waiting: ticketState(db, other.waiting),
    }));
    // the fresh run prepared OTHER-1 already: its snapshot, and its provision adopted
    expect(before.active.inputs.length).toBe(SNAPSHOT_INPUT_NAMES.length);
    expect(before.active.events.filter((e) => e === "note:adopted")).toHaveLength(1);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    h.probe = (_dir, cmd) => !cmd.startsWith("lib-");
    expect(await h.resume()).toBe(75); // design finishes, checks pauses (needs_you)
    expect(h.calls.counts["design:extract"]).toBe(2); // the parked call and the resumed one
    h.read((db, id) => {
      // the run's own ticket: the advisory is its own
      expect(ticketState(db, id).toolchain).toBe(1);
      const active = ticketState(db, other.active);
      // the snapshot was taken again, with the resume's profile, and the same note
      const changed = listEvents(db, other.active).filter((e) => e.reason === "inputs-changed");
      expect(changed.length).toBe(
        before.active.events.filter((e) => e === "note:inputs-changed").length + 1,
      );
      expect(JSON.parse(changed.at(-1)?.payload_json ?? "{}").names).toEqual([
        "profile.promptVars",
        "profile.components",
        "run.unusableComponents",
      ]);
      expect(
        JSON.parse(getInput(db, other.active, "profile.promptVars")?.value_json ?? "{}"),
      ).toEqual({ stack: "ruby", tone: "terse" });
      // adopted once (by the fresh run); the resume's pass found nothing left to adopt
      expect(active.events.filter((e) => e === "note:adopted")).toHaveLength(1);
      expect(getByKey(db, other.active, "provision")?.input_manifest).not.toBeNull();
      // no starting commit and no toolchain advisory for another ticket. OTHER-1's project is
      // paused, so its provision never runs: this proves the resume's preparation writes none, not
      // that provision would refuse to (see "worktree mode, a reused --db: another ticket's
      // provision runs ...", where it does run).
      expect(getInput(db, other.active, "run.startingCommit")).toBeNull();
      expect(active.toolchain).toBe(0);
      // the resume was ENG-1's own, never the lowest id ticket's (spec §4, ruling 2026-10-10)
      expect(listEvents(db, id).some((e) => e.kind === "resumed")).toBe(true);
      expect(active.events.some((e) => e.startsWith("resumed:"))).toBe(false);
      // the waiting ticket is left alone
      expect(ticketState(db, other.waiting)).toEqual(before.waiting);
      expect(before.waiting.events).toEqual([]);
      expect(before.waiting.inputs).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

/** Every file under `dir` with its bytes, the run lock aside (a resume takes and releases it). */
const filesOf = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f !== "run.lock")
    .sort()
    .map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const prev = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = prev;
  }
  return out.join("");
}

test(
  "ls and clean --all read a checkpoint written by a run on a reused --db as the run's own ticket",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    seedOtherTickets(dbFile); // OTHER-1 (active) and OTHER-2 (waiting) have the lower ids
    const script = { units: () => unitsOf(2, { behavioral: false }), planFindings: () => [] };
    expect(await h.fresh({ db: dbFile, script: { ...script, parkAt: "design:extract" } })).toBe(75);
    const root = join(h.stateRoot, "styre");
    const own = h.read((_db, id) => id);
    const paused = listCheckpoints(root).find((c) => c.ident === "ENG-1");
    expect(paused).toMatchObject({
      ticketId: own,
      status: "waiting",
      branch: "feat/ENG-1",
      kind: "budget",
    });
    expect(await h.resume({ script })).toBe(0); // pr-ready
    expect(listCheckpoints(root).find((c) => c.ident === "ENG-1")).toMatchObject({
      ticketId: own,
      kind: "pr-ready",
    });
    const out = await captureStdout(() =>
      cleanImpl({ all: true, slug: h.slug }, { root, targetRepo: h.repoDir }),
    );
    expect(out).toContain("styre clean: reaped 1 finished leftover(s)");
    expect(existsSync(h.checkpointDir())).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a checkpoint that holds no ticket of its ident is refused by resume, reported by --inspect and ls, refused by clean, and never changed",
  async () => {
    const h = make();
    mkdirSync(h.checkpointDir(), { recursive: true });
    // a reused --db's tickets, none of them ENG-1: the lowest id would be OTHER-1
    seedOtherTickets(h.dbPath());
    const before = filesOf(h.checkpointDir());
    expect(await h.resume()).toBe(65);
    expect(h.stderr.join("")).toContain(
      `resume refused: the checkpoint at ${h.checkpointDir()} holds no run of ENG-1 (no ticket ENG-1 recorded)`,
    );
    expect(filesOf(h.checkpointDir())).toEqual(before);
    expect(await h.resume({ inspect: true })).toBe(0);
    expect(h.stderr.join("")).toContain(
      "resume would refuse this checkpoint: no ticket ENG-1 recorded",
    );
    expect(filesOf(h.checkpointDir())).toEqual(before);
    const root = join(h.stateRoot, "styre");
    expect(listCheckpoints(root).map((c) => [c.ident, c.kind, c.note, c.resumable])).toEqual([
      ["ENG-1", "unreadable", "no ticket ENG-1 recorded", false],
    ]);
    const refused = await cleanImpl(
      { ident: "ENG-1", slug: h.slug },
      { root, targetRepo: h.repoDir },
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StyreError);
    expect((refused as StyreError).code).toBe(65);
    expect((refused as StyreError).headline).toContain("no ticket ENG-1 recorded");
    expect(filesOf(h.checkpointDir())).toEqual(before);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "each resume notes the other active tickets reused-database, never the run's own ticket or a waiting one (ruling 2026-10-10)",
  async () => {
    const h = make();
    expect(await h.fresh()).toBe(75); // needs_you at checks:dispatch
    // seedOtherTickets is the stated exception (see its comment): the checkpoint stands for one a
    // run on a reused --db wrote
    const other = seedOtherTickets(h.dbPath());
    for (let i = 1; i <= 4; i++) {
      h.editProfile((p) => {
        p.promptVars = { stack: "ruby", pass: String(i) };
      });
      expect(await h.resume()).toBe(75);
    }
    h.read((db, id) => {
      const reused = (t: number) =>
        listEvents(db, t)
          .filter((e) => e.reason === "reused-database")
          .map((e) => [e.kind, JSON.parse(e.payload_json ?? "null")]);
      const note = ["note", { event: "reused-database" }];
      expect(reused(other.active)).toEqual([note, note, note, note]);
      expect(reused(id)).toEqual([]); // its restart is its `resumed` event
      expect(listEvents(db, id).filter((e) => e.kind === "resumed")).toHaveLength(4);
      expect(reused(other.waiting)).toEqual([]);
      expect(listEvents(db, other.waiting)).toEqual([]);
      // the other ticket's inputs changed at every resume after its first snapshot
      expect(
        listEvents(db, other.active).filter((e) => e.reason === "inputs-changed"),
      ).toHaveLength(3);
      // the run's own ticket is driven at each resume and trips no guard; OTHER-1 is never driven
      // (its project is paused), so the guard's behaviour for it is the helper test's, in
      // invalidate-loop.test.ts
      expect(listEvents(db, id).filter((e) => e.signature?.startsWith("invalidate-loop:"))).toEqual(
        [],
      );
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a resume adopts the other active tickets of its checkpoint, and leaves the waiting ones alone (ruling 2026-10-10)",
  async () => {
    const h = make();
    expect(await h.fresh({ script: { parkAt: "design:extract" } })).toBe(75); // a budget pause
    // The other tickets are seeded into the paused checkpoint: it stands for a checkpoint an older
    // Styre wrote from a run on a reused --db, now resumed under this one (seedOtherTickets is the
    // stated exception; a fresh run of this binary would already have adopted them).
    const other = seedOtherTickets(h.dbPath());
    expect(await h.resume()).toBe(75); // design finishes, checks pauses (needs_you)
    h.read((db) => {
      expect(getByKey(db, other.active, "provision")?.input_manifest).not.toBeNull();
      const notes = listEvents(db, other.active).filter((e) => e.reason === "adopted");
      expect(notes).toHaveLength(1);
      expect(JSON.parse(notes[0]?.payload_json ?? "{}").stepKeys).toEqual(["provision"]);
      expect(getByKey(db, other.waiting, "provision")?.input_manifest).toBeNull();
      expect(listEvents(db, other.waiting)).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
