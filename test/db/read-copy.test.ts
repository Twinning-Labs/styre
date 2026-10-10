import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { makeTempDir } from "../helpers/temp.ts";

/** The private copies readCopyOf makes in the temp root (the tests' own folders use another prefix). */
const copies = () => readdirSync(tmpdir()).filter((n) => n.startsWith("styre-readcopy-"));
/** Every file in `dir` with its bytes, to prove a read changed nothing beside the database. */
const filesOf = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);

function walDb(dir: string): string {
  const path = join(dir, "run.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('main');");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  return path;
}

test("a WAL database with no -wal or -shm beside it is read, and nothing beside it changes", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
  const before = filesOf(dir);
  const rows = readCopyOf(path, (db) => db.query<{ v: string }, []>("SELECT v FROM t").all());
  expect(rows).toEqual([{ v: "main" }]);
  expect(filesOf(dir)).toEqual(before);
});

test("a database with a live -wal file is read including the pages not yet in the main file", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const writer = new Database(path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.exec("INSERT INTO t VALUES ('only in the wal')");
    expect(existsSync(`${path}-wal`)).toBe(true);
    const before = filesOf(dir);
    const rows = readCopyOf(path, (db) =>
      db.query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all(),
    );
    expect(rows).toEqual([{ v: "main" }, { v: "only in the wal" }]);
    expect(filesOf(dir)).toEqual(before);
  } finally {
    writer.close();
  }
});

test("a missing path throws and creates nothing", () => {
  const dir = makeTempDir("styre-rc-test-");
  const before = copies().length;
  expect(() => readCopyOf(join(dir, "absent.db"), () => 1)).toThrow("does not exist");
  expect(readdirSync(dir)).toEqual([]);
  expect(copies().length).toBe(before);
});

test("the private copy is removed afterwards, also when the reader throws", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const before = copies().length;
  expect(readCopyOf(path, () => copies().length)).toBe(before + 1); // it exists while reading
  expect(copies().length).toBe(before);
  expect(() =>
    readCopyOf(path, () => {
      throw new Error("the reader failed");
    }),
  ).toThrow("the reader failed");
  expect(copies().length).toBe(before);
});

test("a write between copying the main file and its -wal is seen: the copy is taken again, cleanly", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const writer = new Database(path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    let mainCopies = 0;
    const rows = readCopyOf(
      path,
      (db) => db.query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all(),
      {
        copyFile: (from, to) => {
          copyFileSync(from, to);
          if (from !== path) return;
          mainCopies += 1;
          // a writer commits between this copy of the main file and the copy of its -wal
          if (mainCopies === 1) writer.exec("INSERT INTO t VALUES ('written mid copy')");
        },
      },
    );
    expect(mainCopies).toBe(2);
    expect(rows).toEqual([{ v: "main" }, { v: "written mid copy" }]);
  } finally {
    writer.close();
  }
});

test("a source that changes during every attempt is refused with a clear error", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const writer = new Database(path);
  const before = copies().length;
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    let n = 0;
    expect(() =>
      readCopyOf(path, () => 1, {
        copyFile: (from, to) => {
          copyFileSync(from, to);
          if (from === path) writer.exec(`INSERT INTO t VALUES ('write ${n++}')`);
        },
      }),
    ).toThrow(`could not get a stable copy of ${path} after 3 attempts`);
    expect(n).toBe(3);
    expect(copies().length).toBe(before);
  } finally {
    writer.close();
  }
});

test("a WAL restart that leaves the -wal size and modification time unchanged is still seen", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const wal = `${path}-wal`;
  const writer = new Database(path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.exec("INSERT INTO t VALUES ('first')");
    // A whole second, so the time can be put back exactly after the writes below.
    const FIXED = 1_700_000_000;
    for (const f of [path, wal]) utimesSync(f, FIXED, FIXED);
    const size = statSync(wal).size;
    let mainCopies = 0;
    const rows = readCopyOf(
      path,
      (db) => db.query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all(),
      {
        copyFile: (from, to) => {
          copyFileSync(from, to);
          if (from !== path) return;
          mainCopies += 1;
          if (mainCopies !== 1) return;
          // Restart the WAL (new salts) and write the same pages again: the -wal keeps its size,
          // and the times of both files are put back, so only the header's salts show a change.
          writer.exec("PRAGMA wal_checkpoint(RESTART)");
          writer.exec("INSERT INTO t VALUES ('after the restart')");
          expect(statSync(wal).size).toBe(size);
          for (const f of [path, wal]) utimesSync(f, FIXED, FIXED);
        },
      },
    );
    expect(mainCopies).toBe(2);
    expect(rows).toEqual([{ v: "main" }, { v: "first" }, { v: "after the restart" }]);
  } finally {
    writer.close();
  }
});
