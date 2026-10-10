import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FINGERPRINT_SCHEME } from "../../src/daemon/canonical.ts";
import { openDb } from "../../src/db/client.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getRun } from "../../src/db/repos/run.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getByKey, recordManifest } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { makeTempDir } from "../helpers/temp.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
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
      ),
  );

test(
  "an unchanged resume in worktree mode reruns only provision, for the recreated worktree",
  async () => {
    const h = new DesignHarness("worktree");
    harnesses.push(h);
    expect(await h.fresh()).toBe(75); // design done, paused at checks:dispatch
    const before = { ...h.calls.counts };
    expect(await h.resume()).toBe(75);
    expect(invalidations(h)).toEqual([
      { event: "invalidated", stepKeys: ["provision"], cause: "worktree-recreated", changed: [] },
    ]);
    for (const s of ["design:dispatch", "design:extract", "design:review"] as const) {
      expect(h.calls.counts[s]).toBe(before[s]);
    }
    expect(h.read((db, id) => listEvents(db, id).some((e) => e.reason === "inputs-changed"))).toBe(
      false,
    );
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "an unchanged resume in place reruns nothing",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    expect(await h.fresh()).toBe(75);
    const before = { ...h.calls.counts };
    expect(await h.resume()).toBe(75);
    expect(await h.resume()).toBe(75);
    expect(invalidations(h)).toEqual([]);
    expect(h.calls.counts).toEqual(before);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

/** What a newer Styre would leave: design:dispatch's manifest stamped with a later scheme.
 *  Written through the repository on this test's own database (test setup). */
function stampNewerScheme(path: string, ticketId: number): void {
  const db = openDb(path);
  try {
    const step = getByKey(db, ticketId, "design:dispatch");
    if (!step?.input_manifest) throw new Error("design:dispatch recorded no manifest");
    recordManifest(db, step.id, {
      manifest: JSON.parse(step.input_manifest) as Record<string, string>,
      fingerprint: step.input_fingerprint ?? "",
      outputDigest: step.output_digest,
      scheme: FINGERPRINT_SCHEME + 1,
    });
  } finally {
    db.close();
  }
}

/** What a refusal must leave as it was: the events, the run row, the ticket's status. */
const runState = (h: DesignHarness, path: string) =>
  h.readAt(path, (db, id) => ({
    events: listEvents(db, id).length,
    attempt: getRun(db)?.attempt,
    status: getTicket(db, id)?.status,
  }));

test(
  "a manifest from a newer scheme: resume refuses (65), changes nothing, and --inspect says so (ruling 2026-10-10)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    expect(await h.fresh()).toBe(75);
    stampNewerScheme(
      h.dbPath(),
      h.read((_db, id) => id),
    );
    const before = runState(h, h.dbPath());
    const calls = JSON.stringify(h.calls.counts);
    expect(await h.resume()).toBe(65);
    expect(h.stderr.join("")).toContain("this run was recorded by a newer Styre; use that version");
    expect(runState(h, h.dbPath())).toEqual(before); // no markResumed, no event, no status change
    expect(JSON.stringify(h.calls.counts)).toBe(calls);
    expect(await h.resume({ inspect: true })).toBe(0);
    expect(h.stderr.join("")).toContain(
      "resume would refuse it: this run was recorded by a newer Styre",
    );
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a manifest from a newer scheme on a reused --db: the run refuses (65) and changes nothing (ruling 2026-10-10)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    const dbFile = join(makeTempDir("styre-walk-reuse-"), "reuse.db");
    expect(await h.fresh({ db: dbFile })).toBe(75);
    stampNewerScheme(
      dbFile,
      h.readAt(dbFile, (_db, id) => id),
    );
    const before = runState(h, dbFile);
    const calls = JSON.stringify(h.calls.counts);
    expect(await h.fresh({ db: dbFile })).toBe(65);
    const out = h.stderr.join("");
    expect(out).toContain(
      "run refused: this database holds a run recorded by a newer Styre; use that version, or point --db at a new database",
    );
    expect(out).toContain(", for: ENG-1."); // the tickets whose manifests are newer
    expect(out).not.toContain("--fresh"); // a reused database ignores it
    expect(runState(h, dbFile)).toEqual(before);
    expect(JSON.stringify(h.calls.counts)).toBe(calls);
  },
  HARNESS_TEST_TIMEOUT_MS,
);
