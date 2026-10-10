import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SNAPSHOT_INPUT_NAMES } from "../../src/daemon/design-graph.ts";
import {
  captureSnapshot,
  recordStartingCommit,
  requireSnapshot,
  snapshotDigest,
  snapshotValue,
  startingCommit,
} from "../../src/daemon/design-inputs.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import {
  getInput,
  insertInputIfAbsent,
  listInputs,
  upsertInput,
} from "../../src/db/repos/ticket-input.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { TEST_PROFILE, makeTestDb } from "../helpers/db.ts";
import { STEP_TEST_TIMEOUT_MS, makeDesignTicket } from "../helpers/design-steps.ts";

const sources = (t: ReturnType<typeof makeDesignTicket>, promptVars = t.profile.promptVars) => ({
  profile: { ...t.profile, promptVars },
  unusableComponents: [],
  nonPrimaryComponents: [],
  config: t.config,
});
const notes = (t: ReturnType<typeof makeDesignTicket>) =>
  listEvents(t.db, t.ticketId).filter((e) => e.reason === "inputs-changed");

test(
  "the first capture writes every declared input and the ticket text, with no note",
  () => {
    const t = makeDesignTicket();
    expect(
      listInputs(t.db, t.ticketId)
        .map((r) => r.name)
        .sort(),
    ).toEqual([...SNAPSHOT_INPUT_NAMES].sort());
    expect(JSON.parse(getInput(t.db, t.ticketId, "ticket.title")?.value_json ?? "null")).toBe(
      "Design ticket",
    );
    expect(notes(t)).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "an unchanged capture changes nothing",
  () => {
    const t = makeDesignTicket();
    const before = listInputs(t.db, t.ticketId);
    expect(captureSnapshot(t.db, t.ticketId, sources(t)).changed).toEqual([]);
    expect(listInputs(t.db, t.ticketId)).toEqual(before);
    expect(notes(t)).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a changed profile field is rewritten and named in one inputs-changed note",
  () => {
    const t = makeDesignTicket();
    const old = getInput(t.db, t.ticketId, "profile.promptVars")?.digest;
    const r = captureSnapshot(t.db, t.ticketId, sources(t, { stack: "ruby", extra: "1" }));
    expect(r.changed).toEqual(["profile.promptVars"]);
    expect(getInput(t.db, t.ticketId, "profile.promptVars")?.digest).not.toBe(old);
    const [note] = notes(t);
    expect(JSON.parse(note.payload_json ?? "{}")).toMatchObject({
      event: "inputs-changed",
      names: ["profile.promptVars"],
      pastDesign: false,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "past design, the note says the change takes effect the next time the run is in design (E6)",
  () => {
    const t = makeDesignTicket();
    setTicketStage(t.db, t.ticketId, "implement");
    captureSnapshot(t.db, t.ticketId, sources(t, { stack: "other" }));
    const payload = JSON.parse(notes(t)[0].payload_json ?? "{}");
    expect(payload.pastDesign).toBe(true);
    expect(payload.message).toContain("next time the run is in design");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the starting commit is written once and never rewritten",
  () => {
    const t = makeDesignTicket();
    expect(recordStartingCommit(t.db, t.ticketId, "aaa")).toBe(true);
    expect(recordStartingCommit(t.db, t.ticketId, "bbb")).toBe(false);
    expect(startingCommit(t.db, t.ticketId)).toBe("aaa");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "requireSnapshot names the inputs a ticket is missing",
  () => {
    const { db } = makeTestDb({ seedTicket: false });
    const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/x" });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-2" });
    expect(() => requireSnapshot(db, ticketId)).toThrow("profile.components");
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

// --- Added by the implementer: the requirements the brief's tests above leave uncovered. ---

/** The SHA-256 of `text`, computed here with node:crypto, not through the module under test. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

test(
  "every input is stored with its value and the SHA-256 of its stored JSON",
  () => {
    const t = makeDesignTicket();
    const expected: Record<string, unknown> = {
      "ticket.ident": "ENG-1",
      "ticket.title": "Design ticket",
      "ticket.description": "Design body",
      "profile.slug": "harness",
      "profile.promptVars": { stack: "ruby" },
      "profile.runtimeContext": t.profile.runtimeContext,
      "profile.components": t.profile.components,
      "run.unusableComponents": [],
      "run.nonPrimaryComponents": [],
      "config.complexityGrading": false,
    };
    const rows = listInputs(t.db, t.ticketId);
    expect(rows).toHaveLength(SNAPSHOT_INPUT_NAMES.length);
    for (const row of rows) {
      expect({ name: row.name, value: JSON.parse(row.value_json) }).toEqual({
        name: row.name,
        value: expected[row.name],
      });
      expect(row.digest).toBe(sha256(row.value_json));
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the stored JSON is canonical: keys sorted, strings in NFC, and the digest follows it",
  () => {
    const t = makeDesignTicket();
    captureSnapshot(t.db, t.ticketId, sources(t, { zeta: "1", alpha: "cafe\u0301" }));
    const row = getInput(t.db, t.ticketId, "profile.promptVars");
    expect(row?.value_json).toBe('{"alpha":"caf\u00e9","zeta":"1"}');
    expect(row?.digest).toBe(sha256('{"alpha":"caf\u00e9","zeta":"1"}'));
    // the same value, keys in another order and the string precomposed: nothing changed
    expect(
      captureSnapshot(t.db, t.ticketId, sources(t, { alpha: "caf\u00e9", zeta: "1" })).changed,
    ).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the narrowed component lists are sets: their order never changes the stored value",
  () => {
    const t = makeDesignTicket();
    const b = { component: "b", missing: [] };
    const a = { component: "a", missing: [] };
    const capture = (unusable: Array<typeof a>) =>
      captureSnapshot(t.db, t.ticketId, { ...sources(t), unusableComponents: unusable });
    expect(capture([b, a]).changed).toEqual(["run.unusableComponents"]);
    expect(
      JSON.parse(getInput(t.db, t.ticketId, "run.unusableComponents")?.value_json ?? "null"),
    ).toEqual([a, b]);
    expect(capture([a, b]).changed).toEqual([]);
    const y = { component: "y", role: "fixture" as const };
    const x = { component: "x", role: "fixture" as const };
    const nonPrimary = (list: Array<typeof x>) =>
      captureSnapshot(t.db, t.ticketId, {
        ...sources(t),
        unusableComponents: [a, b],
        nonPrimaryComponents: list,
      });
    expect(nonPrimary([y, x]).changed).toEqual(["run.nonPrimaryComponents"]);
    expect(
      JSON.parse(getInput(t.db, t.ticketId, "run.nonPrimaryComponents")?.value_json ?? "null"),
    ).toEqual([x, y]);
    expect(nonPrimary([x, y]).changed).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a recapture never rewrites the ticket text, even when the ticket row changed (E2)",
  () => {
    const t = makeDesignTicket();
    const before = getInput(t.db, t.ticketId, "ticket.title");
    // No real path rewrites a ticket's title (insertTicket never updates one); this direct write
    // is the only way to reach the state the E2 guard defends against.
    t.db.query("UPDATE ticket SET title = 'Edited' WHERE id = ?").run(t.ticketId);
    expect(captureSnapshot(t.db, t.ticketId, sources(t)).changed).toEqual([]);
    expect(getInput(t.db, t.ticketId, "ticket.title")).toEqual(before);
  },
  STEP_TEST_TIMEOUT_MS,
);

test("insertInputIfAbsent writes once and keeps the first row; upsertInput replaces it", () => {
  const { db, ticketId } = makeTestDb();
  const row = (v: string) => ({
    ticket_id: ticketId,
    name: "x.test",
    value_json: JSON.stringify(v),
    digest: sha256(JSON.stringify(v)),
    captured_at: `2026-10-10T00:00:0${v}.000Z`,
  });
  expect(getInput(db, ticketId, "x.test")).toBeNull();
  expect(insertInputIfAbsent(db, row("1"))).toBe(true);
  expect(insertInputIfAbsent(db, row("2"))).toBe(false);
  expect(getInput(db, ticketId, "x.test")).toEqual(row("1"));
  upsertInput(db, row("3"));
  expect(getInput(db, ticketId, "x.test")).toEqual(row("3"));
  db.close();
});

test("the starting commit is absent until recorded", () => {
  const { db, ticketId } = makeTestDb();
  expect(startingCommit(db, ticketId)).toBeNull();
  db.close();
});

test(
  "snapshotValue and snapshotDigest read the captured row",
  () => {
    const t = makeDesignTicket();
    expect(snapshotValue(t.db, t.ticketId, "profile.slug")).toBe("harness");
    expect(snapshotDigest(t.db, t.ticketId, "profile.slug")).toBe(sha256('"harness"'));
    expect(() => requireSnapshot(t.db, t.ticketId)).not.toThrow();
  },
  STEP_TEST_TIMEOUT_MS,
);

test("snapshotValue and snapshotDigest fail loud on an uncaptured input, naming it", () => {
  const { db } = makeTestDb({ seedTicket: false });
  const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/x" });
  const ticketId = insertTicket(db, { projectId, ident: "ENG-2" });
  expect(() => snapshotValue(db, ticketId, "profile.slug")).toThrow(
    "ticket_input is missing profile.slug",
  );
  expect(() => snapshotDigest(db, ticketId, "config.complexityGrading")).toThrow(
    "ticket_input is missing config.complexityGrading",
  );
  db.close();
});

test("requireSnapshot names exactly the one input a ticket is missing", () => {
  const { db } = makeTestDb({ seedTicket: false });
  const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/x" });
  const ticketId = insertTicket(db, { projectId, ident: "ENG-2" });
  const missing = "run.nonPrimaryComponents";
  // every row but one, written through the repository (test setup)
  for (const name of SNAPSHOT_INPUT_NAMES.filter((n) => n !== missing)) {
    insertInputIfAbsent(db, {
      ticket_id: ticketId,
      name,
      value_json: "null",
      digest: sha256("null"),
      captured_at: "2026-10-10T00:00:00.000Z",
    });
  }
  let message = "";
  try {
    requireSnapshot(db, ticketId);
  } catch (err) {
    message = String(err);
  }
  expect(message).toContain(`ticket_input is missing ${missing};`);
  db.close();
});

test("makeTestDb's ticket carries a full snapshot of TEST_PROFILE", () => {
  const { db, ticketId } = makeTestDb();
  expect(() => requireSnapshot(db, ticketId)).not.toThrow();
  expect(snapshotValue(db, ticketId, "profile.slug")).toBe(TEST_PROFILE.slug);
  expect(snapshotValue(db, ticketId, "profile.components")).toEqual([]);
  db.close();
});
