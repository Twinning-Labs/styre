// ENG-485 section 7.3 step 7 (final review C M3): the resume line says the interruption is free on
// `--resume`, so it appears only when the interruption was recorded. When recording failed, the
// handler says what resume will do instead and how to start over. No process is started here.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import {
  type HandlerDeps,
  __resetSignalsForTests,
  handleStopSignal,
} from "../../src/util/process/signals.ts";
import { makeTicketDb, removeLifecycleFolders } from "../helpers/lifecycle.ts";

// The temporary folders the lifecycle helpers made for this file.
afterAll(removeLifecycleFolders);

const dirs: string[] = [];
afterEach(() => {
  door.__resetForTests();
  __resetSignalsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps(lines: string[]): HandlerDeps {
  return {
    stderr: (s) => lines.push(s),
    emit: () => {},
    reraise: () => {},
    exit: () => {},
    now: () => Date.now(),
    leftovers: () => [],
    noCore: () => {},
  };
}

const RESUME = "styre: run interrupted; resume with: styre run --resume ENG-1\n";
const NOT_RECORDED =
  "styre: run interrupted, but not recorded; styre run --resume ENG-1 treats it as a crash (the attempt counts, and in place the agent's partial edits are not undone), or start over with: styre run ENG-1 --fresh\n";

test("the resume line appears when the interruption was recorded", async () => {
  const t = makeTicketDb();
  dirs.push(join(t.path, ".."));
  const db = new Database(t.path);
  const lines: string[] = [];
  await handleStopSignal(
    "SIGTERM",
    { command: "run", run: { db, dbPath: t.path, ticketId: t.ticketId, ident: "ENG-1" } },
    deps(lines),
  );
  db.close();
  expect(lines).toContain(RESUME);
  expect(lines).not.toContain(NOT_RECORDED);
});

test("when recording fails, the resume line is not printed; what resume will do instead is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-resume-line-"));
  dirs.push(dir);
  // The run's own connection is open, but the file the handler records through is not a database.
  const bad = join(dir, "run.db");
  writeFileSync(bad, "this is not a database, and long enough to be read as a header.........");
  const db = new Database(":memory:");
  const lines: string[] = [];
  await handleStopSignal(
    "SIGTERM",
    { command: "run", run: { db, dbPath: bad, ticketId: 1, ident: "ENG-1" } },
    deps(lines),
  );
  db.close();
  expect(lines.some((l) => l.startsWith("styre: could not record the interruption: "))).toBe(true);
  expect(lines).not.toContain(RESUME);
  expect(lines).toContain(NOT_RECORDED);
});

test("when the run database is gone, nothing is recorded and the resume line is not printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-resume-line-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  const lines: string[] = [];
  await handleStopSignal(
    "SIGTERM",
    { command: "run", run: { db, dbPath: join(dir, "gone.db"), ticketId: 1, ident: "ENG-1" } },
    deps(lines),
  );
  db.close();
  expect(lines).not.toContain(RESUME);
  expect(lines).toContain(NOT_RECORDED);
});
