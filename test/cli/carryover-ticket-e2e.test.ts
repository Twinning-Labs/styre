import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  DesignHarness,
  HARNESS_TEST_TIMEOUT_MS,
  seedHarnessTicket,
} from "../helpers/design-harness.ts";
import { git } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

// Final review M1: the carryover transcript belongs to the ticket whose dispatch parked. A
// checkpoint written by a run on a reused --db holds other active tickets, and the resume's one
// registry dispatches for every one of them, so the step key and generation alone cannot tell
// whose partial output it is.

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** What the session limit result left behind (`sessionLimit` in design-script.ts). */
const PARTIAL = "partial output written before the session limit";

/** The design:dispatch prompts for one ticket, from the `from`-th recorded call on. The template's
 *  first line names the ticket; a retry or carryover block may come before it. */
const designPrompts = (h: DesignHarness, ident: string, from: number) =>
  h.calls.prompts
    .slice(from)
    .filter((p) => p.step === "design:dispatch")
    .map((p) => p.prompt)
    .filter((p) => p.includes(`You are designing ticket ${ident} (`));

/** A run on a reused --db that also holds OTHER-1, an active ticket of the same project with the
 *  same title and description, inserted first: each tick advances OTHER-1, then ENG-1. OTHER-1's
 *  design:dispatch never finds its plan (the script writes ENG-1's), so it fails and is retried
 *  each tick; it stays active. */
function reusedWithOther(mode: "worktree" | "in-place"): {
  h: DesignHarness;
  dbFile: string;
  other: number;
} {
  const h = new DesignHarness(mode);
  harnesses.push(h);
  const dbFile = join(makeTempDir("styre-carry-"), "reuse.db");
  const other = seedHarnessTicket(dbFile, h, "OTHER-1");
  return { h, dbFile, other };
}

const transcriptJson = (h: DesignHarness) =>
  JSON.parse(readFileSync(join(h.checkpointDir(), "transcript.json"), "utf8")) as Record<
    string,
    unknown
  >;

test(
  "a carryover parked by the run's own ticket reaches its own dispatch, never another ticket's dispatch of the same step and generation",
  async () => {
    // In place: in worktree mode a resume cannot dispatch for another ticket at all today (its old
    // worktree still holds its branch), so only in place does OTHER-1 reach the agent again.
    const { h, dbFile, other } = reusedWithOther("in-place");
    // tick 2: OTHER-1's design:dispatch (call 1) fails, then ENG-1's (call 2) parks
    expect(
      await h.fresh({ db: dbFile, script: { parkAt: "design:dispatch", parkOnCall: 2 } }),
    ).toBe(75);
    const from = h.calls.prompts.length;
    await h.resume();
    // OTHER-1 dispatched design:dispatch again, generation 0, with inputs that digest the same
    const others = designPrompts(h, "OTHER-1", from);
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(p).not.toContain(PARTIAL);
    // and the carryover was withheld without a note: it is not that ticket's (no input changed)
    h.read((db) => {
      expect(listEvents(db, other).filter((e) => e.reason === "carryover-dropped")).toEqual([]);
    });
    // the run's own re-dispatch receives it
    expect(designPrompts(h, "ENG-1", from)[0]).toContain(PARTIAL);
    // transcript.json (kept after a resume, ENG-497) names the ticket and step that wrote it
    expect(transcriptJson(h)).toMatchObject({
      ticketId: h.read((_db, id) => id),
      stepKey: "design:dispatch",
      generation: 0,
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a carryover parked by another ticket never reaches the run's own failed step, and is never read as a transcript from before ENG-477",
  async () => {
    const { h, dbFile, other } = reusedWithOther("worktree");
    // docs/plans/ is ignored: ENG-1's design:dispatch fails at once, without a retry, and stays
    // failed (the run waits for you), while OTHER-1's has already parked
    writeFileSync(join(h.repoDir, ".gitignore"), "docs/plans/\n");
    git(h.repoDir, ["add", ".gitignore"]);
    git(h.repoDir, ["commit", "-q", "-m", "ignore plans"]);
    // tick 2: OTHER-1's design:dispatch (call 1) parks, then ENG-1's (call 2) fails: the run's own
    // ticket has no running step, only a failed one
    expect(await h.fresh({ db: dbFile, script: { parkAt: "design:dispatch" } })).toBe(75);
    const ownStatus = h.read(
      (db, id) =>
        db
          .query<{ status: string }, [number]>(
            "SELECT status FROM workflow_step WHERE ticket_id = ? AND step_key = 'design:dispatch'",
          )
          .get(id)?.status,
    );
    expect(ownStatus).toBe("failed");
    const from = h.calls.prompts.length;
    await h.resume();
    // the run's own failed step was dispatched again, without OTHER-1's partial output
    const own = designPrompts(h, "ENG-1", from);
    expect(own.length).toBeGreaterThan(0);
    for (const p of own) expect(p).not.toContain(PARTIAL);
    // the transcript names the ticket and step that wrote it, never a null step key, which would
    // read as "written before ENG-477, belonging to the parked step"
    expect(transcriptJson(h)).toMatchObject({
      ticketId: other,
      stepKey: "design:dispatch",
      generation: 0,
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
