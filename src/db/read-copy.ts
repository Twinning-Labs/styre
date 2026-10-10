import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** How many times readCopyOf copies a database that would not hold still before it gives up. */
export const READ_COPY_ATTEMPTS = 3;

export interface ReadCopyOptions {
  /** Tests only: the file copy, so a test can write between copying the main file and its -wal. */
  copyFile?: (from: string, to: string) => void;
}

/** The WAL header's checkpoint sequence and two salts (bytes 12 to 23): they change whenever a
 *  checkpoint restarts the WAL, which a size and a time alone can miss. */
function walHeaderOf(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(12);
    return readSync(fd, buf, 0, 12, 12) === 12 ? buf.toString("hex") : null;
  } finally {
    closeSync(fd);
  }
}

/** Size, modification time and (for -wal) the WAL header of the database and its -wal. The -shm is
 *  copied but not compared: the copy's first connection rebuilds that index from the -wal, and a
 *  reader of the original updates its read marks there, which would force retries for nothing. */
function sourceState(path: string): string {
  return JSON.stringify(
    [path, `${path}-wal`].map((file) => {
      try {
        if (!existsSync(file)) return [file, "absent"];
        const st = statSync(file);
        return [file, st.size, st.mtimeMs, file.endsWith("-wal") ? walHeaderOf(file) : null];
      } catch (err) {
        return [file, `unreadable: ${String(err)}`];
      }
    }),
  );
}

/** Read a database without opening it (operator ruling, 2026-10-09; spec §7.7). The file, and its
 *  `-wal` and `-shm` files when present, are copied into a private temporary folder; `fn` reads the
 *  copy, opened read write there (SQLite needs that to read a WAL copy without its `-shm`); the
 *  folder is removed in a finally, whatever happens. The original is never opened, in any journal
 *  mode, so nothing beside it is created or changed. A missing path throws and creates nothing.
 *
 *  Against a live writer: the size, modification time and WAL header of each source file are taken
 *  before and after the copy, and a copy during which any of them moved is taken again, up to
 *  READ_COPY_ATTEMPTS times; then it throws `could not get a stable copy of <path> after 3
 *  attempts`. The limits: a write that changes none of those (the same size, a modification time
 *  within the file system's resolution, no WAL restart) is not seen, so under a writer that never
 *  pauses a copy is very likely, not certain, to be consistent; and a database in rollback journal
 *  (DELETE) mode is copied without its `-journal`, so a write in progress there is not seen either
 *  (no Styre writer uses that mode; the committed fixtures, which do, have no writer). The callers
 *  read under the run lock or after its check, except `styre ls`, which only displays what it read.
 *
 *  A caller must not copy a database its own process holds open: copying opens and closes the
 *  original, and on POSIX closing any handle to a file drops every lock the process holds on it,
 *  including those its own open connection relies on (SQLite's documented hazard). No production
 *  caller does it (`priorRunIdAt` runs after `dumpPark` closed the run's connection). The tests
 *  that do (`signals.test.ts`, `e2e-interrupt.test.ts`, reading a run database their own writer
 *  still has open) are a stated case: one process, no other user of the file, and the copy is
 *  only read. */
export function readCopyOf<T>(
  path: string,
  fn: (db: Database) => T,
  opts: ReadCopyOptions = {},
): T {
  if (!existsSync(path)) throw new Error(`readCopyOf: ${path} does not exist`);
  const copyFile = opts.copyFile ?? copyFileSync;
  const dir = mkdtempSync(join(tmpdir(), "styre-readcopy-"));
  try {
    const copy = join(dir, basename(path));
    let stable = false;
    let lastError = "";
    for (let attempt = 1; attempt <= READ_COPY_ATTEMPTS && !stable; attempt++) {
      for (const ext of ["", "-wal", "-shm"]) rmSync(`${copy}${ext}`, { force: true });
      const before = sourceState(path);
      try {
        copyFile(path, copy);
        for (const ext of ["-wal", "-shm"]) {
          if (existsSync(`${path}${ext}`)) copyFile(`${path}${ext}`, `${copy}${ext}`);
        }
        stable = sourceState(path) === before;
        if (!stable) lastError = "the files changed while they were copied";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (!stable) {
      throw new Error(
        `could not get a stable copy of ${path} after ${READ_COPY_ATTEMPTS} attempts (${lastError})`,
      );
    }
    const db = new Database(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
