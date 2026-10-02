// src/util/process/records.ts
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
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
  const tmp = join(dir, `.${recordFileName(r)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, final);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
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

/** Every well formed record, claimed or not. Files that are not regular files, do not match a name
 *  exactly, or whose content disagrees with their name are skipped and never touched. */
export function listRecords(): Listed[] {
  const dir = processesDir();
  const out: Listed[] = [];
  for (const file of namesIn(dir)) {
    const rm = RECORD.exec(file);
    const cm = rm ? null : CLAIMED.exec(file);
    const m = rm ?? cm;
    if (!m || !isRegularFile(join(dir, file))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed, Number(m[1]), m[2])) continue;
    out.push({
      file,
      record: parsed,
      claimedBy: cm ? { pid: Number(cm[3]), startedAt: cm[4] } : null,
    });
  }
  return out;
}

/** Renames the record to its claimed name. Null when the rename fails: another command got there
 *  first, or the owner removed it. Also retakes a stale claim, whose old claimer is no longer alive. */
export function claim(l: Listed, me: { pid: number; startedAt: string }): Listed | null {
  const dir = processesDir();
  const to = `${recordFileName(l.record)}.claimed-${me.pid}-${me.startedAt}`;
  try {
    renameSync(join(dir, l.file), join(dir, to));
  } catch {
    return null;
  }
  return { file: to, record: l.record, claimedBy: me };
}

/** Renames a claimed record back. If the owner removed it meanwhile the rename fails and nothing
 *  is put back. */
export function unclaim(l: Listed): void {
  if (l.claimedBy === null) return;
  const dir = processesDir();
  try {
    renameSync(join(dir, l.file), join(dir, recordFileName(l.record)));
  } catch {
    /* the owner removed it */
  }
}
