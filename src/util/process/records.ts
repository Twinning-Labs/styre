// src/util/process/records.ts
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Launch records on disk (ENG-485 §5.3). One file per live long running launch, for the whole
 *  machine, in a sibling of `styre/` so no repository slug can collide with it. */
export interface Owner {
  pid: number;
  startedAt: string;
  pgid: number;
}
export interface LaunchRecord {
  version: 1;
  pid: number;
  startedAt: string;
  bootId: string | null;
  kind: "agent" | "group";
  ident: string | null;
  stepId: number | null;
  worktree: string | null;
  command: string;
  owner: Owner;
}
export type Listed = {
  file: string;
  record: LaunchRecord;
  claimedBy: { pid: number; startedAt: string } | null;
};

// The only names this module reads, renames or deletes (§8). A start token is `<digits>` on Linux
// and `<sec>.<usec, 6 digits>` on macOS.
const RECORD = /^(\d+)-(\d+(?:\.\d{6})?)\.json$/;
const CLAIMED = /^(\d+)-(\d+(?:\.\d{6})?)\.json\.claimed-(\d+)-(\d+(?:\.\d{6})?)$/;

export function processesDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state"), "styre-processes");
}

export function recordFileName(r: { pid: number; startedAt: string }): string {
  return `${r.pid}-${r.startedAt}.json`;
}

/** Throws on any failure: a launch must not go on unrecorded without the caller knowing. */
export function writeRecord(r: LaunchRecord): void {
  const dir = processesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const final = join(dir, recordFileName(r));
  // The temporary name starts with a dot and matches neither pattern, so no reader or sweep sees it.
  // It is created new (O_EXCL) and never through a symbolic link (O_NOFOLLOW): a file or link
  // already at that name makes the write fail, loudly, instead of writing somewhere else.
  const tmp = join(dir, `.${recordFileName(r)}.tmp-${process.pid}`);
  let created = false;
  try {
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      writeSync(fd, JSON.stringify(r));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, final); // a rename replaces a link at `final`; it never follows one
  } catch (e) {
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
    throw e;
  }
}

/** The largest record the sweep reads; a real one is well under 2 KB. */
export const MAX_RECORD_BYTES = 64 * 1024;

/** Thrown by `scanRecords` when the folder itself cannot be trusted (A F6, C M2). */
export class UnsafeRecordsFolder extends Error {}

/** The records folder is trusted only when it is a real folder (not a symbolic link), owned by this
 *  user, and writable by no one else: anyone who can write it could make the sweep stop any of this
 *  user's processes. Throws `UnsafeRecordsFolder` naming why; a missing folder is fine. */
function checkFolder(dir: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw new UnsafeRecordsFolder("it is a symbolic link");
  if (!st.isDirectory()) return; // reading it fails, and the caller says that
  const me = process.geteuid?.();
  if (me !== undefined && st.uid !== me) {
    throw new UnsafeRecordsFolder(`it is owned by uid ${st.uid}, not by you (uid ${me})`);
  }
  if ((st.mode & 0o022) !== 0) {
    throw new UnsafeRecordsFolder(
      `it is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`,
    );
  }
}

/** One record file's text, read without following a symbolic link, from a regular file of this
 *  user's of at most MAX_RECORD_BYTES. Returns why it cannot be used instead, or null when it is
 *  gone (a peer claimed or removed it meanwhile). */
function readRecordFile(path: string): { text: string } | { reason: string } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") return { reason: "it is not a regular file" };
    return { reason: `it could not be read (${code ?? String(e)})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { reason: "it is not a regular file" };
    const me = process.geteuid?.();
    if (me !== undefined && st.uid !== me) {
      return { reason: `it is owned by uid ${st.uid}, not by you (uid ${me})` };
    }
    if (st.size > MAX_RECORD_BYTES) return { reason: "it is larger than 64 KB" };
    const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > MAX_RECORD_BYTES) return { reason: "it is larger than 64 KB" };
    }
    return { text: buf.subarray(0, n).toString("utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { reason: `it could not be read (${code ?? String(e)})` };
  } finally {
    closeSync(fd);
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function claimedNames(dir: string, base: string): string[] {
  return namesIn(dir).filter(
    (n) => n.startsWith(`${base}.claimed-`) && CLAIMED.test(n) && isRegularFile(join(dir, n)),
  );
}

/** How long removeRecord keeps retrying against a peer that keeps renaming the record. */
const REMOVE_DEADLINE_MS = 2_000;

function unlinkIfThere(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    // Another process renaming or removing it first is the race this loop absorbs; anything else
    // (permissions, a read only folder) will not get better by retrying.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** True only when neither name exists. A claimed copy renames back and forth between two names, and
 *  neither a directory read nor a lookup is atomic with a rename. One lookup followed by one
 *  directory read can therefore miss a copy that moved from its claimed name back to its record name
 *  between them (the race behind N9, found by the stress test). Reading, looking up, then reading
 *  again can only miss it if the copy moves twice inside those three steps. */
function neitherNameExists(
  dir: string,
  base: string,
  between?: (step: 1 | 2 | 3) => void,
): boolean {
  const noClaimedBefore = claimedNames(dir, base).length === 0;
  between?.(1);
  const noRecord = !isRegularFile(join(dir, base));
  between?.(2);
  const noClaimedAfter = claimedNames(dir, base).length === 0;
  between?.(3);
  return noClaimedBefore && noRecord && noClaimedAfter;
}

/** Knobs for tests; production callers pass none. */
export interface RemoveOptions {
  /** Runs after each pass's deletions and before the check, so a test can place a peer's rename at
   *  exactly that point. */
  afterPass?: (pass: number) => void;
  /** Runs after each of the three observations of the final check (1: first directory read, 2: lookup
   *  of the record name, 3: second directory read), so a test can move a copy between them. */
  betweenChecks?: (step: 1 | 2 | 3) => void;
  /** How long to keep retrying against a peer that keeps renaming the record. */
  deadlineMs?: number;
}

/** Removes the record and any claimed copy of it. Repeats until neither name exists, so a sweep
 *  that renames a claimed copy back after the first pass cannot bring the record back (N9). */
export function removeRecord(
  r: { pid: number; startedAt: string },
  opts: RemoveOptions = {},
): void {
  const dir = processesDir();
  const base = recordFileName(r);
  const limit = opts.deadlineMs ?? REMOVE_DEADLINE_MS;
  const deadline = Date.now() + limit;
  for (let pass = 0; ; pass++) {
    if (isRegularFile(join(dir, base))) unlinkIfThere(join(dir, base));
    for (const n of claimedNames(dir, base)) unlinkIfThere(join(dir, n));
    opts.afterPass?.(pass);
    if (neitherNameExists(dir, base, opts.betweenChecks)) return;
    if (Date.now() >= deadline) break;
  }
  throw new Error(`could not remove launch record ${base} within ${limit} ms`);
}

function isOwner(o: unknown): o is Owner {
  const x = o as Owner | null;
  return (
    typeof x === "object" &&
    x !== null &&
    Number.isInteger(x.pid) &&
    typeof x.startedAt === "string" &&
    Number.isInteger(x.pgid)
  );
}

function isRecord(v: unknown, pid: number, startedAt: string): v is LaunchRecord {
  const x = v as LaunchRecord | null;
  return (
    typeof x === "object" &&
    x !== null &&
    x.version === 1 &&
    x.pid === pid &&
    x.startedAt === startedAt &&
    (x.kind === "agent" || x.kind === "group") &&
    typeof x.command === "string" &&
    isOwner(x.owner)
  );
}

/** A file whose name matches a record name exactly but that cannot be used as a record. It is never
 *  touched: the sweep only says so, once per command, so a bad file is never silent. */
export interface Unreadable {
  file: string;
  reason: string;
}

/** Every well formed record, claimed or not, and every file named like one that could not be used.
 *  A file that vanished between the directory read and its own read (a peer claimed or removed it)
 *  is in neither list. Throws when the folder itself cannot be read (anything but "no folder"), and
 *  `UnsafeRecordsFolder` when it cannot be trusted. */
export function scanRecords(): { listed: Listed[]; unreadable: Unreadable[] } {
  const dir = processesDir();
  const listed: Listed[] = [];
  const unreadable: Unreadable[] = [];
  // Normally nothing has a record's name, and this one directory read is the whole cost. The folder
  // is checked before anything in it is read.
  const names = namesIn(dir).filter((n) => RECORD.test(n) || CLAIMED.test(n));
  if (names.length === 0) return { listed, unreadable };
  checkFolder(dir);
  for (const file of names) {
    const rm = RECORD.exec(file);
    const cm = rm ? null : CLAIMED.exec(file);
    const m = rm ?? cm;
    if (!m) continue;
    const read = readRecordFile(join(dir, file));
    if (read === null) continue; // renamed or removed by a peer meanwhile
    if ("reason" in read) {
      unreadable.push({ file, reason: read.reason });
      continue;
    }
    const text = read.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      unreadable.push({ file, reason: "it is not valid JSON" });
      continue;
    }
    if (!isRecord(parsed, Number(m[1]), m[2])) {
      unreadable.push({
        file,
        reason:
          "its content is not a version 1 launch record for the pid and start time in its name",
      });
      continue;
    }
    listed.push({
      file,
      record: parsed,
      claimedBy: cm ? { pid: Number(cm[3]), startedAt: cm[4] } : null,
    });
  }
  return { listed, unreadable };
}

/** Every well formed record, claimed or not. Files that are not regular files, do not match a name
 *  exactly, or whose content disagrees with their name are skipped and never touched. */
export function listRecords(): Listed[] {
  return scanRecords().listed;
}

/** Renames the record to its claimed name. Null when the file is gone: another command got there
 *  first, or the owner removed it. Any other failure (a folder that cannot be written) is thrown,
 *  so it is said. Also retakes a stale claim, whose old claimer is no longer alive. */
export function claim(l: Listed, me: { pid: number; startedAt: string }): Listed | null {
  const dir = processesDir();
  const to = `${recordFileName(l.record)}.claimed-${me.pid}-${me.startedAt}`;
  try {
    renameSync(join(dir, l.file), join(dir, to));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return { file: to, record: l.record, claimedBy: me };
}

/** Renames a claimed record back. If the owner removed it meanwhile the rename fails and nothing
 *  is put back; any other failure is thrown, so it is said. */
export function unclaim(l: Listed): void {
  if (l.claimedBy === null) return;
  const dir = processesDir();
  try {
    renameSync(join(dir, l.file), join(dir, recordFileName(l.record)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
