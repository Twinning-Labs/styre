// ENG-485 section 8, amended 2026-10-09: an orphaned command group whose leader has exited is
// REPORTED, never stopped. Without its leader nothing confirms the group is still the recorded
// launch's: a reused pid can be the id of a group an unrelated daemon left behind (final review C,
// I2). The sweep names each remaining member with the exact command to stop it, removes the record,
// and signals nothing.
//
// Every process here is this test's own, claimed by structure (test/helpers/own-processes.ts) and
// stopped by killOwned in a `finally`. No test signals anything it did not start.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import { __setCwdReadersForTests } from "../../src/util/process/leftovers.ts";
import { bootId, nowToken, probe } from "../../src/util/process/proc-table.ts";
import { type LaunchRecord, processesDir, writeRecord } from "../../src/util/process/records.ts";
import { sweepOrphans } from "../../src/util/process/sweep.ts";
import { isAlive, killOwned, own, registerGroup, until } from "../helpers/own-processes.ts";

/** A sleep length no other test uses. */
const NAP = "4719";

let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-leaderless-"));
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  killOwned();
  __setCwdReadersForTests(undefined);
  process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
});

const files = (): string[] => {
  try {
    return readdirSync(processesDir()).sort();
  } catch {
    return [];
  }
};
const startOf = (pid: number) => {
  const p = probe(pid);
  if (p.kind !== "alive") throw new Error(`pid ${pid} is ${p.kind}`);
  return p.info;
};

/** A "dead Styre": a short lived process whose identity is recorded as the owner. */
async function deadOwner() {
  const p = Bun.spawn(["sleep", "0.2"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const info = startOf(p.pid);
  await p.exited;
  expect(await until(() => probe(info.pid).kind === "gone")).toBe(true);
  return info;
}

function groupRecord(
  pid: number,
  startedAt: string,
  owner: { pid: number; startedAt: string; pgid: number },
  extra: Partial<LaunchRecord> = {},
): LaunchRecord {
  return {
    version: 1,
    pid,
    startedAt,
    bootId: bootId(),
    kind: "group",
    ident: "ENG-9",
    stepId: 1,
    worktree: null,
    command: "make",
    owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: owner.pgid },
    ...extra,
  };
}

const reportLine = (a: {
  command: string;
  ident: string;
  pid: number;
  member: string;
  memberPid: number;
}) =>
  `styre: an orphaned command "${a.command}" from ${a.ident} (pid ${a.pid}) left "${a.member}" (pid ${a.memberPid}) running in its process group; its leader has exited, so Styre cannot confirm the group is still that command's and stopped nothing; if the process is a leftover of that command, stop it with: kill ${a.memberPid}\n`;

/** A group of this test's own whose leader exits, leaving one `sleep` member in it. The leader
 *  prints the member's pid and waits for its stdin to close, so the group is registered and the
 *  member claimed while the leader is still alive. */
async function leaderlessGroup() {
  const leader = Bun.spawn(
    ["sh", "-c", `sleep ${NAP} </dev/null >/dev/null 2>&1 & echo $!; read x`],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
      env: { ...process.env },
    },
  );
  const l = startOf(leader.pid);
  expect(registerGroup(l)).toBe(true);
  const reader = leader.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const claimed = own(startOf(Number(text.trim())));
  expect(claimed.length).toBe(1);
  const m = claimed[0];
  expect(m.pgid).toBe(l.pid);
  leader.stdin.end();
  await leader.exited;
  expect(await until(() => probe(l.pid).kind === "gone")).toBe(true);
  expect(isAlive(m)).toBe(true);
  return { leader: l, member: m };
}

test("an orphaned group whose leader has exited: each member is named with its kill command, nothing is signalled, and the record is removed", async () => {
  const owner = await deadOwner();
  const { leader, member } = await leaderlessGroup();
  writeRecord(groupRecord(leader.pid, leader.startedAt, owner));
  const lines: string[] = [];
  const r = await sweepOrphans({ stderr: (s) => lines.push(s) });
  expect(isAlive(member)).toBe(true);
  expect(r.stopped).toEqual([]);
  expect(r.failed).toEqual([]);
  expect(r.reported.map((x) => x.pid)).toEqual([leader.pid]);
  expect(lines).toEqual([
    reportLine({
      command: "make",
      ident: "ENG-9",
      pid: leader.pid,
      member: `sleep ${NAP}`,
      memberPid: member.pid,
    }),
  ]);
  expect(files()).toEqual([]);
  // Still running a moment later: no stop was started in the background either.
  await Bun.sleep(300);
  expect(isAlive(member)).toBe(true);
});

test("reviewer C's reproduction: a stale group record whose pid is now an unrelated daemon's leaderless group leaves the daemon running", async () => {
  // The classic way a program daemonizes: an intermediate child calls setsid, forks the daemon,
  // and exits. The daemon then sits in a group whose id is the intermediate's pid and whose leader
  // is gone. Here the record names that pid with a start time that matches nothing: a long gone
  // command whose pid was handed out again.
  const owner = await deadOwner();
  const pidFile = join(state, "daemon");
  const since = nowToken();
  const top = Bun.spawn(
    [
      "perl",
      "-MPOSIX=setsid",
      "-e",
      `defined(my $c = fork) or die; if ($c) { waitpid($c, 0); exit 0 }
       setsid(); defined(my $g = fork) or die;
       if ($g == 0) { open(STDIN, '<', '/dev/null'); open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null'); exec('sleep', '${NAP}') }
       open(my $f, '>', '${pidFile}.tmp'); print $f "$$ $g\\n"; close $f; rename('${pidFile}.tmp', '${pidFile}');
       select(undef, undef, undef, 1.0); exit 0`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env } },
  );
  let text = "";
  expect(
    await until(() => {
      try {
        text = readFileSync(pidFile, "utf8");
        return text.endsWith("\n");
      } catch {
        return false;
      }
    }),
  ).toBe(true);
  const [x, victimPid] = text.trim().split(" ").map(Number);
  // Claimed while the intermediate is alive: the daemon still descends from this test.
  const claimed = own(startOf(victimPid));
  expect(claimed.length).toBe(1);
  const victim = claimed[0];
  expect(victim.pgid).toBe(x);
  expect(probe(victim.pid).kind === "alive" && startOf(victim.pid).startedAt >= since).toBe(true);
  await top.exited;
  expect(await until(() => probe(x).kind === "gone")).toBe(true);

  writeRecord(
    groupRecord(x, "1000000000.000001", owner, {
      ident: "ENG-STALE",
      command: "sh -c npm test",
    }),
  );
  const lines: string[] = [];
  const r = await sweepOrphans({ stderr: (s) => lines.push(s) });
  await Bun.sleep(300);
  expect(isAlive(victim)).toBe(true);
  expect(r.stopped).toEqual([]);
  expect(lines).toEqual([
    reportLine({
      command: "sh -c npm test",
      ident: "ENG-STALE",
      pid: x,
      member: `sleep ${NAP}`,
      memberPid: victim.pid,
    }),
  ]);
  expect(files()).toEqual([]);
});

test("a reported member running in the record's worktree is named once, not again as a leftover", async () => {
  const owner = await deadOwner();
  const { leader, member } = await leaderlessGroup();
  const wt = realpathSync(state);
  // The member's working folder reads as inside the worktree.
  __setCwdReadersForTests({ sync: (a) => new Map(a.pids.map((p) => [p, wt])) });
  writeRecord(groupRecord(leader.pid, leader.startedAt, owner, { worktree: wt }));
  const lines: string[] = [];
  await sweepOrphans({ stderr: (s) => lines.push(s) });
  expect(isAlive(member)).toBe(true);
  expect(lines.filter((l) => l.includes(`(pid ${member.pid})`))).toEqual([
    reportLine({
      command: "make",
      ident: "ENG-9",
      pid: leader.pid,
      member: `sleep ${NAP}`,
      memberPid: member.pid,
    }),
  ]);
});
