import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { classifyAcCheck, insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { rerunAcChecks } from "../../src/dispatch/post-implement-rerun.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import type { CommandResult } from "../../src/util/run-command.ts";
import { makeTestDb } from "../helpers/db.ts";

const PY_COMPONENT: Component = {
  name: "py",
  kind: "python",
  paths: ["tests/**"],
  commands: {},
  extensions: [".py"],
};

/** A scripted CmdRunner that returns a fixed CommandResult for every call (mirrors
 *  checks-run.test.ts's fakeRun — no real pytest is invoked). */
const fakeRun =
  (out: Partial<CommandResult>) =>
  async (_command: string, _opts: { cwd: string; timeoutMs: number }): Promise<CommandResult> => {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...out };
  };

const neverRun = async (): Promise<CommandResult> => {
  throw new Error("post-implement-rerun: run should not be called for this check");
};

/** Seed one ticket-scoped AC + an active ac_check under `tests/test_x.py`, optionally classified
 *  with a `red_class` or a `disposition` (mirrors M3's classifyAcCheck contract). */
function seedCheck(
  db: Database,
  ticketId: number,
  opts: {
    redClass?: "assertion" | "absence" | "environmental";
    disposition?: "satisfied" | "not-expressible";
  },
): { acId: number; acCheckId: number } {
  const ac = insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  const check = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "'tests/test_x.py::test_x'",
    testPath: "tests/test_x.py",
    redFirstResult: "red",
  });
  if (opts.redClass) classifyAcCheck(db, { acCheckId: check.id, redClass: opts.redClass });
  if (opts.disposition) classifyAcCheck(db, { acCheckId: check.id, disposition: opts.disposition });
  return { acId: ac.id, acCheckId: check.id };
}

test("an assertion check whose re-run is coarse green is not in stillRed; records an ac-check-post-implement pass signal", async () => {
  const { db, ticketId } = makeTestDb();
  const { acId, acCheckId } = seedCheck(db, ticketId, { redClass: "assertion" });

  const result = await rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    run: fakeRun({ exitCode: 0, stdout: "1 passed" }),
  });

  expect(result.stillRed).toEqual([]);
  expect(result.advisory).toEqual([]);
  expect(result.ran).toEqual([{ acId, acCheckId, coarse: "green", outcome: "green" }]);

  const signals = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-post-implement",
  );
  db.close();
  expect(signals).toHaveLength(1);
  expect(signals[0].result).toBe("pass");
  expect(signals[0].branch_head_sha).toBe("deadbeef");
});

test("an assertion check re-run coarse red is in stillRed", async () => {
  const { db, ticketId } = makeTestDb();
  const { acId } = seedCheck(db, ticketId, { redClass: "assertion" });

  const result = await rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    run: fakeRun({ exitCode: 1, stdout: "1 failed" }),
  });

  expect(result.stillRed).toEqual([acId]);
  expect(result.advisory).toEqual([]);
  expect(result.ran[0]?.outcome).toBe("gated-red");

  const signals = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-post-implement",
  );
  db.close();
  expect(signals[0]?.result).toBe("fail");
});

test("an absence check re-run red is in stillRed", async () => {
  const { db, ticketId } = makeTestDb();
  const { acId } = seedCheck(db, ticketId, { redClass: "absence" });

  const result = await rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    // pytest exit 2 = collection/import error (absence)
    run: fakeRun({ exitCode: 2, stdout: "ImportError" }),
  });
  db.close();

  expect(result.stillRed).toEqual([acId]);
  expect(result.advisory).toEqual([]);
});

test("an environmental check re-run red is in advisory, NOT stillRed", async () => {
  const { db, ticketId } = makeTestDb();
  const { acId } = seedCheck(db, ticketId, { redClass: "environmental" });

  const result = await rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    run: fakeRun({ exitCode: 1, stdout: "1 failed" }),
  });

  expect(result.stillRed).toEqual([]);
  expect(result.advisory).toEqual([acId]);
  expect(result.ran[0]?.outcome).toBe("advisory-red");
});

test("a row with disposition=satisfied does not gate (not in stillRed/advisory), outcome disposition", async () => {
  const { db, ticketId } = makeTestDb();
  const { acId, acCheckId } = seedCheck(db, ticketId, { disposition: "satisfied" });

  const result = await rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    run: neverRun,
  });

  expect(result.stillRed).toEqual([]);
  expect(result.advisory).toEqual([]);
  expect(result.ran).toEqual([{ acId, acCheckId, coarse: "green", outcome: "disposition" }]);

  const signals = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-post-implement",
  );
  db.close();
  // dispositioned rows don't gate and don't get a re-run signal — nothing was actually re-run.
  expect(signals).toHaveLength(0);
});

test("a row with red_class=NULL AND disposition=NULL throws (loud NULL/NULL assertion)", async () => {
  const { db, ticketId } = makeTestDb();
  seedCheck(db, ticketId, {});

  const promise = rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    run: neverRun,
  });

  await expect(promise).rejects.toThrow(/neither red_class nor disposition/);
  db.close();
});

test("a gated (assertion) check with test_path=NULL fails CLOSED — never silently advances", async () => {
  const { db, ticketId } = makeTestDb();
  const ac = insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  const check = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "'tests/test_x.py::test_x'",
    testPath: null, // e.g. a corrupted/lost row — there is nothing to re-run
    redFirstResult: "red",
  });
  classifyAcCheck(db, { acCheckId: check.id, redClass: "assertion" });

  const result = await rerunAcChecks({
    db,
    ticketId,
    components: [PY_COMPONENT],
    worktreePath: "/repo",
    headSha: "deadbeef",
    timeoutMs: 1000,
    run: neverRun, // a NULL path can select nothing — the runner must never even be invoked
  });

  // Fails CLOSED: a gated check with no path to re-run is treated as still-red, never a silent pass.
  expect(result.stillRed).toEqual([ac.id]);
  expect(result.advisory).toEqual([]);
  expect(result.ran[0]?.outcome).toBe("gated-red");

  const signals = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-post-implement",
  );
  db.close();
  expect(signals[0]?.result).toBe("fail");
});
