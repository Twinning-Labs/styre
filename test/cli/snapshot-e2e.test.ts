import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_INPUT_NAMES } from "../../src/daemon/design-graph.ts";
import { startingCommit } from "../../src/daemon/design-inputs.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { getInput, listInputs } from "../../src/db/repos/ticket-input.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { insertPending, markRunning, markSucceeded } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
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

/** A reused database that already holds another project's tickets: OTHER-1 active, with a
 *  `provision` an older Styre finished (succeeded, no manifest), and OTHER-2 waiting. Their project
 *  is paused, so the loop does not drive them in these tests (`v_ready_tickets`); the run still
 *  prepares OTHER-1, which is active. Set up through the repositories (test setup). */
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
    const titleAt = h.readAt(dbFile, (db, id) => getInput(db, id, "ticket.title")?.captured_at);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db, id) => {
      expect(getInput(db, id, "ticket.title")?.captured_at).toBe(titleAt);
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
  "in place, a reused --db keeps the starting commit its first run recorded",
  async () => {
    const h = make("in-place");
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const head = git(h.repoDir, ["rev-parse", "HEAD"]);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    writeFileSync(join(h.repoDir, "operator.txt"), "an operator commit\n");
    git(h.repoDir, ["add", "operator.txt"]);
    git(h.repoDir, ["commit", "-q", "-m", "operator"]);
    expect(git(h.repoDir, ["rev-parse", "HEAD"])).not.toBe(head);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    expect(h.readAt(dbFile, (db, id) => startingCommit(db, id))).toBe(head);
  },
  HARNESS_TEST_TIMEOUT_MS,
);
