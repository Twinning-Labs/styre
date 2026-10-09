import { lstatSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { GRACE_MS, describeProcess, selfIdentity } from "./door.ts";
import {
  LEFTOVER_TIMEOUT_MS,
  commandOf,
  findLeftoversOrReason,
  formatLeftover,
  skippedLine,
} from "./leftovers.ts";
import { printable } from "./printable.ts";
import {
  type Probe,
  type ProcInfo,
  bootId,
  listProcesses,
  probe,
  tokenValue,
} from "./proc-table.ts";
import {
  type LaunchRecord,
  type Listed,
  type ListedNote,
  type Unreadable,
  UnsafeRecordsFolder,
  claim,
  processesDir,
  recordFileName,
  removeRecord,
  removeTempNote,
  scanRecords,
  unclaim,
} from "./records.ts";
import { removeTree } from "./remove-tree.ts";
import { type StopReport, groupMembers, stopGroup, stopTree } from "./stop.ts";

/**
 * The sweep (ENG-485 section 8). Every Styre command runs it first, inside its error boundary. It
 * stops what an earlier Styre left running when it was killed with `kill -9`, using only the launch
 * records on disk: never a live run's launches, never a process whose identity does not match its
 * record, never a file whose name is not an exact record name. A command group whose leader has
 * exited cannot be confirmed (amendment 2026-10-09): its remaining members are reported, with the
 * command that stops each, and never signalled. Everything it says goes to stderr.
 */
export interface SweepResult {
  /** Orphans this sweep stopped (it signalled at least one of their processes). */
  stopped: LaunchRecord[];
  /** Orphans whose stop failed or could not be tried; their records are kept for the next command. */
  failed: LaunchRecord[];
  /** Records removed without stopping anything: a reused pid, or a record from before a restart. */
  stale: number;
  /** Orphaned command groups whose leader had exited: their remaining members were named, never
   *  signalled, and the records removed (amendment 2026-10-09). */
  reported: LaunchRecord[];
  /** The leftover check's lines (section 9.4), already printed. */
  leftoverLines: string[];
  /** Command temp folders of force quit Styres that this sweep removed (command-temp.ts). */
  tempFolders: string[];
}

/** Test seams; production passes at most `stderr`. */
export interface SweepDeps {
  stderr?: (s: string) => void;
  /** The current boot ID (Linux); null on macOS. */
  bootId?: () => string | null;
  stopTree?: typeof stopTree;
  stopGroup?: typeof stopGroup;
  /** Runs right after each successful claim (tests). */
  afterClaim?: () => void;
}

/** Alive means: the same process (pid and start time) and not a zombie. A process Styre may not
 *  inspect counts as alive, so a run that belongs to another user is never taken for dead. */
export function aliveFrom(p: Probe, who: { pid: number; startedAt: string }): boolean {
  if (p.kind === "not-allowed") return true;
  return (
    p.kind === "alive" &&
    p.info.pid === who.pid &&
    p.info.startedAt === who.startedAt &&
    p.info.state !== "zombie"
  );
}
const isAlive = (who: { pid: number; startedAt: string }): boolean =>
  aliveFrom(probe(who.pid), who);

/** The run a record names, with its control characters replaced (the ident is read from a file
 *  that a record-shaped write could have put anything in). Never throws: it is also used on the
 *  sweep's error path. */
const who = (r: LaunchRecord): string =>
  typeof r.ident === "string" ? printable(r.ident) : "an unknown run";
/** What went wrong, for a line. Never throws (an error whose message or string form throws is
 *  still described), so the sweep's error path cannot fail on it. */
const errText = (e: unknown): string => {
  try {
    return printable(e instanceof Error ? e.message : String(e));
  } catch {
    return "an error that could not be described";
  }
};

/** What the identity check (section 5.4) found for one orphan. */
type Identity =
  | { kind: "same" } // still the recorded process or group: stop it
  | { kind: "exited" } // gone (or a zombie): nothing to stop
  | { kind: "reused"; pid: number } // the pid now belongs to another program: leave it alone
  | { kind: "leaderless"; members: ProcInfo[] } // a group with no leader: report, never stop
  | { kind: "unknown" }; // not allowed to look: keep the record

function identify(r: LaunchRecord): Identity {
  const p = probe(r.pid);
  if (p.kind === "not-allowed") return { kind: "unknown" };
  if (p.kind === "alive" && p.info.startedAt !== r.startedAt) return { kind: "reused", pid: r.pid };
  if (r.kind === "agent") {
    return p.kind === "alive" && p.info.state !== "zombie" ? { kind: "same" } : { kind: "exited" };
  }
  // A group: its leader, even a zombie, still holds the pid and so the group id, and its start time
  // matched above. A group whose leader has exited has nothing left to check: once the leader's
  // pid is free again it can be handed to a process that daemonizes (setsid in an intermediate
  // child that then exits), whose group then has that id and no leader. So such a group is never
  // stopped; its members are reported (amendment 2026-10-09, which changes section 5.4).
  if (p.kind === "alive") return { kind: "same" };
  const members = groupMembers(r.pid, listProcesses());
  return members.length > 0 ? { kind: "leaderless", members } : { kind: "exited" };
}

/**
 * Stops one orphan. Throws when the target is unsafe (init, Styre itself, Styre's own group, or the
 * group of the Styre that launched it, which a script that started Styre without job control
 * shares): the caller prints that and keeps the record.
 */
async function stopOrphan(
  r: LaunchRecord,
  me: { pid: number; pgid: number },
  deps: SweepDeps,
): Promise<StopReport> {
  if (r.kind === "group") {
    if (r.pid === me.pgid || r.pid === r.owner.pgid) {
      throw new Error(`refusing group ${r.pid}: it is Styre's own group or its launcher's`);
    }
    return (deps.stopGroup ?? stopGroup)(r.pid, "graceful", { graceMs: GRACE_MS });
  }
  if (r.pid === r.owner.pgid) {
    throw new Error(`refusing pid ${r.pid}: it leads the group of the Styre that launched it`);
  }
  return (deps.stopTree ?? stopTree)({ pid: r.pid, startedAt: r.startedAt }, "graceful", {
    graceMs: GRACE_MS,
    // Never expand Styre's own group, nor the dead owner's: a script that started Styre without job
    // control leads that group and must survive (N1, Review Focus 1).
    excludePgids: [me.pgid, r.owner.pgid],
  });
}

const sameBase = (l: Listed): string => recordFileName(l.record);

function unreadableLine(dir: string, u: Unreadable): string {
  return `styre: ignored the launch record ${join(dir, u.file)}: ${u.reason}; it was left in place\n`;
}

/** Section 8: run first by every command. */
export async function sweepOrphans(deps: SweepDeps = {}): Promise<SweepResult> {
  const say =
    deps.stderr ??
    ((s: string) => {
      try {
        process.stderr.write(s);
      } catch {
        /* a closed stderr must not fail the command */
      }
    });
  const res: SweepResult = {
    stopped: [],
    failed: [],
    stale: 0,
    reported: [],
    leftoverLines: [],
    tempFolders: [],
  };
  const dir = processesDir();

  // Normally the folder is missing or empty: this one directory read is the whole cost.
  let scan: ReturnType<typeof scanRecords>;
  try {
    scan = scanRecords();
  } catch (e) {
    if (e instanceof UnsafeRecordsFolder) {
      // Anyone who can write the folder could make this sweep stop any of this user's processes.
      say(
        `styre: ignored the launch records folder ${dir}: ${e.message}, so no orphans were stopped; make it a folder only you can write (chmod 700 ${dir})\n`,
      );
      return res;
    }
    say(
      `styre: could not read the launch records in ${dir} (${errText(e)}), so no orphans were stopped\n`,
    );
    return res;
  }
  for (const u of scan.unreadable) say(unreadableLine(dir, u));
  for (const u of scan.unreadableNotes) {
    say(
      `styre: ignored the temp folder note ${join(dir, u.file)}: ${u.reason}; it was left in place\n`,
    );
  }
  if (scan.listed.length === 0 && scan.notes.length === 0) return res;

  let me: { pid: number; startedAt: string; pgid: number };
  let currentBoot: string | null;
  try {
    me = selfIdentity();
    currentBoot = (deps.bootId ?? bootId)();
  } catch (e) {
    say(
      `styre: could not read this process's own identity (${errText(e)}), so no orphans were stopped\n`,
    );
    return res;
  }
  /** Orphans whose worktree the leftover check reads, after every stop (so an orphan not stopped
   *  yet is never reported as a leftover of another). */
  const checks: LaunchRecord[] = [];
  const done = new Set<string>();
  /** Processes already named by this sweep, so the leftover check does not name them again. */
  const reported = new Set<number>();
  /** Puts a claimed record back; a failure other than "it is gone" is said, never swallowed. */
  const putBack = (l: Listed): void => {
    try {
      unclaim(l);
    } catch (e) {
      say(
        `styre: could not put back the launch record for pid ${l.record.pid} from ${who(l.record)}: ${errText(e)}\n`,
      );
    }
  };

  for (const l of scan.listed) {
    const base = sameBase(l);
    if (done.has(base)) continue; // a record and a claimed copy of it: one launch
    done.add(base);
    let mine: Listed | null = null;
    try {
      // 1. Claim it. A claim held by a live claimer (another command, or another sweep in this very
      //    process) is theirs. A claim whose claimer is gone is retaken (finding 8).
      if (l.claimedBy !== null && isAlive(l.claimedBy)) continue;
      mine = claim(l, me);
      if (mine === null) continue; // another command got there first, or the owner removed it
      deps.afterClaim?.();
      const r = mine.record;

      // A record from before the last restart names nothing on this boot: its pid and start time
      // (clock ticks since boot on Linux) may match an unrelated process. Remove it, stop nothing.
      if (r.bootId !== currentBoot) {
        say(
          `styre: removed the launch record for pid ${r.pid} from ${who(r)}: it was written before this machine last started, so nothing was stopped\n`,
        );
        removeRecord(r);
        res.stale++;
        continue;
      }

      // 2. A live owner: the launch belongs to a live run (Review Focus 5). Put it back.
      if (isAlive(r.owner)) {
        putBack(mine);
        continue;
      }

      // 3. An orphan. The identity check first.
      const id = identify(r);
      if (id.kind === "unknown") {
        say(
          `styre: could not check pid ${r.pid} from ${who(r)} (not allowed to read it); its launch record was kept, so the next Styre command tries again\n`,
        );
        res.failed.push(r);
        putBack(mine);
        continue;
      }
      if (id.kind === "reused") {
        say(
          `styre: pid ${r.pid} from ${who(r)} now belongs to another program, so it was left alone and its launch record removed\n`,
        );
        removeRecord(r);
        res.stale++;
        if (r.worktree) checks.push(r);
        continue;
      }
      if (id.kind === "leaderless") {
        // Never signalled: nothing can confirm the group is still this launch's. Each member is
        // named with the command that stops it, and the record goes (operator decision 2026-10-09).
        for (const m of id.members) {
          reported.add(m.pid);
          say(
            `styre: an orphaned command "${r.command}" from ${who(r)} (pid ${r.pid}) left "${commandOf(m.pid)}" (pid ${m.pid}) running in its process group; its leader has exited, so Styre cannot confirm the group is still that command's and stopped nothing; if the process is a leftover of that command, stop it with: kill ${m.pid}\n`,
          );
        }
        removeRecord(r);
        res.reported.push(r);
        if (r.worktree) checks.push(r);
        continue;
      }
      if (id.kind === "same") {
        let rep: StopReport;
        try {
          rep = await stopOrphan(r, me, deps);
        } catch (e) {
          say(
            `styre: could not stop the orphaned ${r.kind === "agent" ? "agent" : "command"} from ${who(r)} (pid ${r.pid}): ${errText(e)}; its launch record was kept, so the next Styre command tries again\n`,
          );
          res.failed.push(r);
          putBack(mine);
          continue;
        }
        if (rep.survivors.length > 0) {
          for (const s of rep.survivors) {
            const command = describeProcess(s.pid, r.command);
            say(
              `styre: could not stop ${command} (pid ${s.pid}); stop it with: kill -9 ${s.pid}\n`,
            );
          }
          res.failed.push(r);
          putBack(mine);
          continue;
        }
        if (rep.signalled.length > 0) {
          res.stopped.push(r);
          say(
            r.kind === "agent"
              ? `styre: stopped an orphaned agent from ${who(r)} (pid ${r.pid}), left running when Styre was force quit\n`
              : `styre: stopped an orphaned command "${r.command}" from ${who(r)} (pid ${r.pid}), left running when Styre was force quit\n`,
          );
        }
      }
      // 4. Stopped and confirmed, or it had already exited: the record goes.
      removeRecord(r);
      if (r.worktree) checks.push(r);
    } catch (e) {
      // Anything else (a removal that could not finish, an unreadable process table) is said and
      // the command goes on. The record stays for the next command: it is put back first, and
      // nothing here may throw (final record review I1), so no claim is ever left behind.
      const r = l.record;
      if (!res.failed.includes(r)) res.failed.push(r);
      if (mine !== null) putBack(mine);
      try {
        say(
          `styre: could not finish with the launch record for pid ${r.pid} from ${who(r)}: ${errText(e)}\n`,
        );
      } catch {
        /* the line could not be written; the record is back, and the command goes on */
      }
    }
  }

  // The leftover check (section 9), once per worktree, from the earliest start among its orphans.
  const since = new Map<string, string>();
  for (const r of checks) {
    const wt = r.worktree as string;
    const prev = since.get(wt);
    if (prev === undefined || tokenValue(r.startedAt) < tokenValue(prev))
      since.set(wt, r.startedAt);
  }
  for (const [worktree, from] of since) {
    let found: ReturnType<typeof findLeftoversOrReason>;
    try {
      found = findLeftoversOrReason({
        worktree,
        since: from,
        timeoutMs: LEFTOVER_TIMEOUT_MS,
        viaDiagnostic: true,
        // The shell that started this command may be running in the worktree and started inside
        // the window: it is not something the agent left (R30).
        excludeOwnAncestors: true,
      });
    } catch (e) {
      found = { skipped: errText(e) };
    }
    if (!Array.isArray(found)) {
      res.leftoverLines.push(skippedLine(found.skipped));
      continue;
    }
    for (const f of found) {
      if (reported.has(f.pid)) continue;
      reported.add(f.pid);
      res.leftoverLines.push(formatLeftover(f));
    }
  }
  for (const line of res.leftoverLines) say(line);
  if (scan.notes.length > 0) removeTempFolders(scan.notes, currentBoot, res, say);
  return res;
}

/**
 * The temp folders force quit Styres gave their commands (command-temp.ts). A note names one; its
 * folder goes once the Styre that wrote the note is gone (or it was written before this machine
 * last started) and none of that Styre's launch records is still on disk: a command the stops
 * above could not end may still be using it. Only a folder that is exactly what the note says is
 * removed: an absolute path, named like a command temp folder, a real folder (not a link) of this
 * user's.
 * Anything else is said, and the note and the path are left in place. Silent when it removes one.
 */
function removeTempFolders(
  notes: ListedNote[],
  currentBoot: string | null,
  res: SweepResult,
  say: (s: string) => void,
): void {
  const dir = processesDir();
  let recorded: Set<string>;
  try {
    // Read again: the records this sweep removed are gone now, and those it kept are still here.
    recorded = new Set(scanRecords().listed.map((l) => recordFileName(l.record.owner)));
  } catch (e) {
    say(
      `styre: could not read the launch records again (${errText(e)}), so no temp folders were removed\n`,
    );
    return;
  }
  for (const { file, note } of notes) {
    const owner = note.owner;
    const earlierBoot = note.bootId !== currentBoot;
    if (!earlierBoot && isAlive(owner)) continue;
    if (recorded.has(recordFileName(owner))) continue;
    const notePath = join(dir, file);
    const leave = (why: string): void =>
      say(
        `styre: did not remove ${printable(note.path)}, named by the temp folder note ${notePath}: ${why}; both were left in place\n`,
      );
    if (!isAbsolute(note.path)) {
      leave("its path is not absolute");
      continue;
    }
    if (!/^styre-cmd-[A-Za-z0-9]{6}$/.test(basename(note.path))) {
      leave("its name is not a command temp folder's");
      continue;
    }
    try {
      let st: ReturnType<typeof lstatSync> | null = null;
      try {
        st = lstatSync(note.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (st !== null) {
        if (!st.isDirectory()) {
          leave("it is not a folder (a symbolic link or another kind of file)");
          continue;
        }
        const me = process.geteuid?.();
        if (me !== undefined && st.uid !== me) {
          leave(`it is owned by uid ${st.uid}, not by you (uid ${me})`);
          continue;
        }
        removeTree(note.path);
        res.tempFolders.push(note.path);
      }
      removeTempNote(notePath);
    } catch (e) {
      // Said once, with how to finish it by hand: the note goes, so no later command says it again.
      const path = printable(note.path);
      say(
        `styre: could not remove the temp folder ${path} left by an earlier Styre: ${errText(e)}; remove it with: chmod -R u+w ${path} && rm -rf ${path}\n`,
      );
      try {
        removeTempNote(notePath);
      } catch {
        /* said above */
      }
    }
  }
}
