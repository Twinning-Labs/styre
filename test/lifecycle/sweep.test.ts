// ENG-485 section 8: the sweep. Every Styre command first stops what an earlier Styre left running
// when it was killed with `kill -9`, from the launch records on disk. Each test gets its own state
// folder (never the operator's ~/.local/state), starts only its own processes, claims each one at
// once by structure (test/helpers/own-processes.ts), and kills what is left in afterEach by recorded
// identity. No test signals a process it did not start, and no cleanup signals a bare pid or group.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import {
  __setCwdReadersForTests,
  ancestorPids,
  formatLeftover,
} from "../../src/util/process/leftovers.ts";
import * as procTable from "../../src/util/process/proc-table.ts";
import {
  bootId,
  listProcesses,
  nowToken,
  probe,
  tokenValue,
} from "../../src/util/process/proc-table.ts";
import {
  type LaunchRecord,
  claim,
  listRecords,
  processesDir,
  recordFileName,
  writeRecord,
} from "../../src/util/process/records.ts";
import * as records from "../../src/util/process/records.ts";
import type { StopReport } from "../../src/util/process/stop.ts";
import { aliveFrom, sweepOrphans } from "../../src/util/process/sweep.ts";
import {
  killOwned,
  own,
  ownChild,
  ownGroupMembers,
  ownPrinted,
  ownTree,
} from "../helpers/own-processes.ts";
import { makeTempDir } from "../helpers/temp.ts";

const FX = join(import.meta.dir, "fixtures");
/** A sleep length no other test uses, so nothing else ever matches these processes. */
const NAP = "4173";

let state: string;
const saved = process.env.XDG_STATE_HOME;

beforeEach(() => {
  state = makeTempDir("styre-sweep-");
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  __setCwdReadersForTests(undefined);
  ownGroupMembers();
  killOwned();
  process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
});

const startOf = (pid: number) => {
  const p = probe(pid);
  if (p.kind !== "alive") throw new Error(`pid ${pid} is ${p.kind}`);
  return p.info;
};
const isGone = (pid: number): boolean => {
  const p = probe(pid);
  return p.kind === "gone" || (p.kind === "alive" && p.info.state === "zombie");
};
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(20);
  }
  return fn();
}

function spawn(argv: string[], opts: { detached?: boolean; env?: Record<string, string> } = {}) {
  const p = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: opts.detached ?? false,
    env: { ...process.env, ...opts.env },
  });
  // Claimed at once, while it is certainly this test's child; a detached one's group too.
  ownChild(p, { group: opts.detached ?? false });
  return p;
}

/** Start `nohup sleep NAP` in `worktree` from a shell, as an agent leaves a detached leftover, and
 *  return its pid once it is claimed: the shell waits for its stdin to close, so the sleep is still
 *  its child (this test's descendant) when the printed pid is claimed. */
async function nohupLeftover(worktree: string): Promise<number> {
  const since = nowToken();
  const sh = Bun.spawn(
    [
      "sh",
      "-c",
      `cd "$1" || exit 1; nohup sleep ${NAP} </dev/null >/dev/null 2>&1 & echo $!; read _`,
      "sh",
      worktree,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  ownChild(sh);
  const reader = sh.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const r = await reader.read();
    if (r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  const left = Number(text.trim());
  expect(ownPrinted(left, since)).not.toBeNull();
  sh.stdin.end();
  await sh.exited;
  return left;
}

/** A fake "dead Styre": a short lived process whose identity we record as the owner. */
async function deadOwner() {
  const p = Bun.spawn(["sleep", "0.3"]);
  const info = startOf(p.pid);
  await p.exited;
  expect(await until(() => isGone(info.pid))).toBe(true);
  return info;
}

/** An orphan that ignores SIGTERM, returned once its trap is in place (its `sleep` has started). */
async function termIgnoring() {
  const p = spawn(["sh", "-c", `trap '' TERM; sleep ${NAP}`]);
  expect(await until(() => listProcesses().some((x) => x.ppid === p.pid))).toBe(true);
  // Its `sleep`, claimed while it is this test's descendant: a stop that ended the shell alone
  // would orphan it out of every cleanup's reach.
  expect(ownTree(startOf(p.pid)).length).toBeGreaterThanOrEqual(2);
  return p;
}

function rec(
  p: { pid: number; startedAt: string },
  owner: { pid: number; startedAt: string; pgid: number },
  extra: Partial<LaunchRecord> = {},
): LaunchRecord {
  return {
    version: 1,
    pid: p.pid,
    startedAt: p.startedAt,
    bootId: bootId(),
    kind: "agent",
    ident: "ENG-9",
    stepId: 1,
    worktree: null,
    command: "standin",
    owner: { pid: owner.pid, startedAt: owner.startedAt, pgid: owner.pgid },
    ...extra,
  };
}

const collect = () => {
  const lines: string[] = [];
  return { lines, stderr: (s: string) => lines.push(s) };
};
const orphanLine = (ident: string, pid: number) =>
  `styre: stopped an orphaned agent from ${ident} (pid ${pid}), left running when Styre was force quit\n`;
const files = (): string[] => {
  try {
    return readdirSync(processesDir()).sort();
  } catch {
    return [];
  }
};

// ---- stopping orphans --------------------------------------------------------------------------

describe("an orphan whose owner is dead", () => {
  test("an agent and the command it started are stopped, with the exact message, and the record removed", async () => {
    const owner = await deadOwner();
    const agent = spawn([join(FX, "standin-agent.sh")], { env: { STANDIN_SLEEP: NAP } });
    let tool: number | undefined;
    expect(
      await until(() => {
        const t = listProcesses().find((p) => p.ppid === agent.pid && p.state !== "zombie");
        // Claimed while the agent is alive and the tool is this test's descendant.
        if (t !== undefined && own(t).length > 0) tool = t.pid;
        return tool !== undefined;
      }),
    ).toBe(true);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner));
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.stopped.map((x) => x.pid)).toEqual([a.pid]);
    expect(r.failed).toEqual([]);
    expect(out.lines).toEqual([orphanLine("ENG-9", a.pid)]);
    expect(await until(() => isGone(agent.pid))).toBe(true);
    expect(await until(() => isGone(tool as number))).toBe(true);
    expect(listRecords()).toEqual([]);
    expect(files()).toEqual([]);
  });

  test("a record with no ticket names an unknown run", async () => {
    const owner = await deadOwner();
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { ident: null }));
    const out = collect();
    await sweepOrphans({ stderr: out.stderr });
    expect(out.lines).toEqual([orphanLine("an unknown run", a.pid)]);
  });

  test("a command group is stopped as a group, said, and its record removed", async () => {
    const owner = await deadOwner();
    // The leader runs a member in its own group, then both wait.
    const leader = spawn(["sh", "-c", `sleep ${NAP} & wait`], { detached: true });
    let member: number | undefined;
    expect(
      await until(() => {
        member = listProcesses().find((p) => p.ppid === leader.pid)?.pid;
        return member !== undefined;
      }),
    ).toBe(true);
    const l = startOf(leader.pid);
    writeRecord(rec(l, owner, { kind: "group", command: "npm test" }));
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.stopped.map((x) => x.pid)).toEqual([l.pid]);
    expect(out.lines).toEqual([
      `styre: stopped an orphaned command "npm test" from ENG-9 (pid ${l.pid}), left running when Styre was force quit\n`,
    ]);
    expect(await until(() => isGone(member as number))).toBe(true);
    expect(files()).toEqual([]);
  });

  // A group whose leader has exited is reported, never stopped (amendment 2026-10-09):
  // test/lifecycle/sweep-leaderless.test.ts.

  test("an orphan that had already exited: nothing is stopped or said, the record is removed", async () => {
    const owner = await deadOwner();
    const gone = await deadOwner(); // any process that has exited
    writeRecord(rec(gone, owner));
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.stopped).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(out.lines).toEqual([]);
    expect(files()).toEqual([]);
  });
});

// ---- what the sweep leaves alone ---------------------------------------------------------------

describe("what the sweep leaves alone", () => {
  test("a live owner's launch is left alone and put back unclaimed (Review Focus 5)", async () => {
    const me = startOf(process.pid);
    const child = spawn(["sleep", NAP]);
    const c = startOf(child.pid);
    writeRecord(rec(c, me, { kind: "group", ident: "ENG-8", command: "sleep" }));
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.stopped).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(probe(child.pid).kind).toBe("alive");
    expect(isGone(child.pid)).toBe(false);
    const left = listRecords();
    expect(left.length).toBe(1);
    expect(left[0]?.claimedBy).toBeNull();
    expect(files()).toEqual([recordFileName(c)]);
  });

  test("another live Styre's agent is left alone (two runs on different tickets)", async () => {
    // The other run: a live process standing in for a second Styre.
    const other = spawn(["sleep", NAP]);
    const o = startOf(other.pid);
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, o, { ident: "ENG-2" }));
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.stopped).toEqual([]);
    expect(isGone(agent.pid)).toBe(false);
    expect(files()).toEqual([recordFileName(a)]);
  });

  test("an owner Styre may not inspect counts as alive; a zombie or another process does not", () => {
    const w = { pid: 42, startedAt: "7.000000" };
    const info = { pid: 42, ppid: 1, pgid: 42, startedAt: "7.000000", state: "running" as const };
    expect(aliveFrom({ kind: "not-allowed" }, w)).toBe(true);
    expect(aliveFrom({ kind: "alive", info }, w)).toBe(true);
    expect(aliveFrom({ kind: "alive", info: { ...info, state: "zombie" } }, w)).toBe(false);
    expect(aliveFrom({ kind: "alive", info: { ...info, startedAt: "8.000000" } }, w)).toBe(false);
    expect(aliveFrom({ kind: "gone" }, w)).toBe(false);
  });

  test("a reused pid (start time differs) is left alone, named in one line, and the record removed", async () => {
    const owner = await deadOwner();
    const victim = spawn(["sleep", NAP]);
    const v = startOf(victim.pid);
    writeRecord(rec({ pid: v.pid, startedAt: "1.000000" }, owner, { ident: "ENG-7" }));
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.stale).toBe(1);
    expect(r.stopped).toEqual([]);
    expect(isGone(victim.pid)).toBe(false);
    expect(out.lines).toEqual([
      `styre: pid ${v.pid} from ENG-7 now belongs to another program, so it was left alone and its launch record removed\n`,
    ]);
    expect(files()).toEqual([]);
  });

  test("a reused group leader pid is left alone too: its new group is never signalled", async () => {
    const owner = await deadOwner();
    const victim = spawn(["sh", "-c", `sleep ${NAP} & wait`], { detached: true });
    let member: number | undefined;
    expect(
      await until(() => {
        member = listProcesses().find((p) => p.ppid === victim.pid)?.pid;
        return member !== undefined;
      }),
    ).toBe(true);
    writeRecord(rec({ pid: victim.pid, startedAt: "1.000000" }, owner, { kind: "group" }));
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.stale).toBe(1);
    expect(isGone(victim.pid)).toBe(false);
    expect(isGone(member as number)).toBe(false);
    expect(files()).toEqual([]);
  });

  test("a record from before the last restart is removed and nothing is stopped (boot ID differs)", async () => {
    const owner = await deadOwner();
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { bootId: "boot-before" }));
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr, bootId: () => "boot-now" });
    expect(r.stale).toBe(1);
    expect(r.stopped).toEqual([]);
    expect(isGone(agent.pid)).toBe(false);
    expect(out.lines).toEqual([
      `styre: removed the launch record for pid ${a.pid} from ENG-9: it was written before this machine last started, so nothing was stopped\n`,
    ]);
    expect(files()).toEqual([]);
  });

  test("a record from this boot is swept normally (control for the boot ID test)", async () => {
    const owner = await deadOwner();
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { bootId: "boot-now" }));
    const r = await sweepOrphans({ stderr: () => {}, bootId: () => "boot-now" });
    expect(r.stopped.length).toBe(1);
    expect(await until(() => isGone(agent.pid))).toBe(true);
  });

  test.if(process.platform === "linux")(
    "Linux: a record whose boot ID is not this boot's is stale",
    async () => {
      const owner = await deadOwner();
      const agent = spawn(["sleep", NAP]);
      const a = startOf(agent.pid);
      writeRecord(rec(a, owner, { bootId: "not-this-boot" }));
      const r = await sweepOrphans({ stderr: () => {} });
      expect(r.stale).toBe(1);
      expect(isGone(agent.pid)).toBe(false);
      expect(files()).toEqual([]);
    },
  );

  test("files that are not exact record names are never touched; well named bad files are said once each and kept", async () => {
    const dir = processesDir();
    // Made as Styre makes it (0700): under a umask of 002, Ubuntu's default, a plain mkdir is
    // writable by the group, and the hardened scan refuses the whole folder.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ignored = [
      "notes.txt",
      "123-1.000000.json.bak",
      ".123-1.000000.json.tmp-99",
      "123-1.000000.claimed-4-5", // missing the .json of a claimed name
    ];
    for (const n of ignored) writeFileSync(join(dir, n), "{}");
    mkdirSync(join(dir, "77-1.000000.json")); // a folder with a record's name
    writeFileSync(join(dir, "88-1.000000.json"), "not json");
    writeFileSync(
      join(dir, "99-1.000000.json"),
      JSON.stringify({ version: 2, pid: 99, startedAt: "1.000000" }),
    );
    const before = files();
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r).toEqual({ stopped: [], failed: [], stale: 0, reported: [], leftoverLines: [] });
    expect(files()).toEqual(before);
    expect(out.lines.sort()).toEqual(
      [
        `styre: ignored the launch record ${join(dir, "77-1.000000.json")}: it is not a regular file; it was left in place\n`,
        `styre: ignored the launch record ${join(dir, "88-1.000000.json")}: it is not valid JSON; it was left in place\n`,
        `styre: ignored the launch record ${join(dir, "99-1.000000.json")}: its content is not a version 1 launch record for the pid and start time in its name; it was left in place\n`,
      ].sort(),
    );
  });

  test("an unreadable records folder is said in one line and does not throw", async () => {
    // The folder's path is taken by a file: reading it as a folder fails with ENOTDIR.
    writeFileSync(join(state, "styre-processes"), "");
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r).toEqual({ stopped: [], failed: [], stale: 0, reported: [], leftoverLines: [] });
    expect(out.lines.length).toBe(1);
    expect(out.lines[0]).toStartWith(
      `styre: could not read the launch records in ${processesDir()} (`,
    );
    expect(out.lines[0]).toEndWith("), so no orphans were stopped\n");
  });
});

// ---- the exclusion of groups (Review Focus 1, N1) ----------------------------------------------

describe("groups that are never expanded", () => {
  // This is the end to end form of N1. It does NOT prove that the owner's group is excluded: stopTree
  // already never expands the root's own group, and here the agent's group IS the owner's. The seam
  // test below, which reads the exclusion set the sweep passes, is the one that proves it.
  test("a script that started Styre without job control survives the sweep (N1)", async () => {
    // The script and the agent share a group whose id is the script's pid.
    // The script goes on after its agent ends (its own `sleep`), as a CI script would. It writes the
    // agent's pid to a file, so the test never mistakes the script's own `sleep` for the agent.
    const pidFile = join(state, "agent.pid");
    const script = spawn(
      [
        "sh",
        "-c",
        `STANDIN_SLEEP=${NAP} "${join(FX, "standin-agent.sh")}" & echo $! > "${pidFile}"; sleep ${NAP}`,
      ],
      { detached: true },
    );
    let agentPid: number | undefined;
    expect(
      await until(() => {
        try {
          agentPid = Number(fs.readFileSync(pidFile, "utf8").trim()) || undefined;
        } catch {
          agentPid = undefined;
        }
        return agentPid !== undefined && listProcesses().some((p) => p.ppid === agentPid);
      }),
    ).toBe(true);
    // The agent and its tool, claimed while they are this test's descendants.
    expect(ownTree(startOf(agentPid as number)).length).toBeGreaterThanOrEqual(2);
    const sh = startOf(script.pid);
    expect(startOf(agentPid as number).pgid).toBe(script.pid); // one group: no job control
    const a = startOf(agentPid as number);
    const owner = await deadOwner();
    writeRecord(rec(a, { ...owner, pgid: script.pid }, { ident: "ENG-6" }));
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.stopped.length).toBe(1);
    expect(await until(() => isGone(a.pid))).toBe(true);
    expect(isGone(script.pid)).toBe(false);
    expect(startOf(script.pid).startedAt).toBe(sh.startedAt);
  });

  test("an agent stop excludes Styre's own group and the dead owner's group", async () => {
    const owner = await deadOwner();
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, { ...owner, pgid: 4242 }));
    const seen: number[][] = [];
    const empty: StopReport = { stopped: [], survivors: [], signalled: [], failures: [] };
    await sweepOrphans({
      stderr: () => {},
      stopTree: async (_root, _how, opts) => {
        seen.push([...opts.excludePgids].sort((x, y) => x - y));
        return empty;
      },
    });
    const me = door.selfIdentity();
    expect(seen).toEqual([[me.pgid, 4242].sort((x, y) => x - y)]);
  });

  test("a group record naming the owner's group or Styre's own is refused, said, and kept", async () => {
    const owner = await deadOwner();
    const lead = spawn(["sleep", NAP], { detached: true });
    const l = startOf(lead.pid);
    writeRecord(rec(l, { ...owner, pgid: l.pid }, { kind: "group" }));
    let called = 0;
    const out = collect();
    const r = await sweepOrphans({
      stderr: out.stderr,
      stopGroup: async () => {
        called++;
        return { stopped: [], survivors: [], signalled: [], failures: [] };
      },
    });
    expect(called).toBe(0);
    expect(r.failed.length).toBe(1);
    expect(out.lines.join("")).toContain(
      `could not stop the orphaned command from ENG-9 (pid ${l.pid})`,
    );
    expect(isGone(lead.pid)).toBe(false);
    expect(listRecords().map((x) => x.claimedBy)).toEqual([null]);
  });
  test("an agent record naming the leader of the owner's group is refused, said, and kept", async () => {
    const owner = await deadOwner();
    const lead = spawn(["sleep", NAP], { detached: true });
    const l = startOf(lead.pid);
    writeRecord(rec(l, { ...owner, pgid: l.pid }));
    let called = 0;
    const out = collect();
    const r = await sweepOrphans({
      stderr: out.stderr,
      stopTree: async () => {
        called++;
        return { stopped: [], survivors: [], signalled: [], failures: [] };
      },
    });
    expect(called).toBe(0);
    expect(r.failed.length).toBe(1);
    expect(out.lines.join("")).toContain(
      `could not stop the orphaned agent from ENG-9 (pid ${l.pid})`,
    );
    expect(isGone(lead.pid)).toBe(false);
    expect(listRecords().map((x) => x.claimedBy)).toEqual([null]);
  });
});

// ---- failures are loud and keep the record -----------------------------------------------------

describe("a stop that fails", () => {
  test("any other failure on one record (a removal that throws) is said, keeps the record, and the sweep goes on", async () => {
    const owner = await deadOwner();
    const first = spawn(["sleep", NAP]);
    const f = startOf(first.pid);
    writeRecord(rec(f, owner, { ident: "ENG-21" }));
    const second = spawn(["sleep", NAP]);
    const g = startOf(second.pid);
    writeRecord(rec(g, owner, { ident: "ENG-22" }));
    const real = records.removeRecord;
    const remove = spyOn(records, "removeRecord").mockImplementation((r, o) => {
      if (r.pid === f.pid) throw new Error("the disk said no");
      real(r, o);
    });
    try {
      const out = collect();
      const r = await sweepOrphans({ stderr: out.stderr });
      expect(r.failed.map((x) => x.pid)).toEqual([f.pid]);
      expect(r.stopped.map((x) => x.pid).sort()).toEqual([f.pid, g.pid].sort());
      expect(out.lines).toContain(
        `styre: could not finish with the launch record for pid ${f.pid} from ENG-21: the disk said no\n`,
      );
      expect(out.lines).toContain(orphanLine("ENG-22", g.pid));
      expect(listRecords().map((x) => [x.record.pid, x.claimedBy])).toEqual([[f.pid, null]]);
    } finally {
      remove.mockRestore();
    }
  });

  test("a stop that throws (an unsafe target) is said, the record kept unclaimed, and the sweep goes on", async () => {
    const owner = await deadOwner();
    // A record naming this very process: stopTree refuses Styre itself by throwing.
    const self = startOf(process.pid);
    writeRecord(rec(self, owner, { ident: "ENG-3" }));
    // A second, ordinary orphan after it is still swept.
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { ident: "ENG-4" }));
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.failed.map((x) => x.pid)).toEqual([self.pid]);
    expect(r.stopped.map((x) => x.pid)).toEqual([a.pid]);
    const said = out.lines.find((s) => s.includes(`(pid ${self.pid})`)) ?? "";
    expect(said).toStartWith(
      `styre: could not stop the orphaned agent from ENG-3 (pid ${self.pid}): `,
    );
    expect(said).toEndWith("; its launch record was kept, so the next Styre command tries again\n");
    expect(listRecords().map((x) => [x.record.pid, x.claimedBy])).toEqual([[self.pid, null]]);
  });

  test("survivors are named with the exact message and the record is kept for the next command", async () => {
    const owner = await deadOwner();
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner));
    const out = collect();
    const r = await sweepOrphans({
      stderr: out.stderr,
      stopTree: async () => ({ stopped: [], survivors: [a], signalled: [a], failures: [] }),
    });
    expect(r.failed.length).toBe(1);
    expect(r.stopped).toEqual([]);
    expect(out.lines.length).toBe(1);
    expect(out.lines[0]).toMatch(
      new RegExp(
        `^styre: could not stop .*sleep ${NAP}.* \\(pid ${a.pid}\\); stop it with: kill -9 ${a.pid}\\n$`,
      ),
    );
    expect(listRecords().map((x) => x.claimedBy)).toEqual([null]);
  });
});

// ---- the claim protocol ------------------------------------------------------------------------

describe("claims", () => {
  test("a claim that fails because a live peer renamed the record first is skipped (section 8 step 1)", async () => {
    const owner = await deadOwner();
    const peer = spawn(["sleep", NAP]); // a live command, mid sweep
    const p = startOf(peer.pid);
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner));
    // The sweep's listing was taken just before the peer claimed the record.
    const stale = records.scanRecords();
    const first = stale.listed[0];
    if (!first) throw new Error("no record");
    const held = claim(first, p);
    if (!held) throw new Error("the peer's claim failed");
    const scan = spyOn(records, "scanRecords").mockImplementation(() => stale);
    try {
      const out = collect();
      const r = await sweepOrphans({ stderr: out.stderr });
      expect(r).toEqual({ stopped: [], failed: [], stale: 0, reported: [], leftoverLines: [] });
      expect(out.lines).toEqual([]);
    } finally {
      scan.mockRestore();
    }
    expect(isGone(agent.pid)).toBe(false);
    expect(files()).toEqual([held.file]);
  });

  test("a claim left by a dead sweeper is retaken (finding 8)", async () => {
    const owner = await deadOwner();
    const sweeper = await deadOwner();
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { ident: "ENG-5" }));
    const first = listRecords()[0];
    if (!first) throw new Error("no record");
    expect(claim(first, sweeper)).not.toBeNull();
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.stopped.length).toBe(1);
    expect(await until(() => isGone(agent.pid))).toBe(true);
    expect(files()).toEqual([]);
  });

  test("a claim held by a live claimer is left alone", async () => {
    const owner = await deadOwner();
    const other = spawn(["sleep", NAP]); // a live sweeper, in the middle of its own sweep
    const o = startOf(other.pid);
    const agent = spawn(["sleep", NAP]);
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner));
    const first = listRecords()[0];
    if (!first) throw new Error("no record");
    const held = claim(first, o);
    if (!held) throw new Error("claim failed");
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.stopped).toEqual([]);
    expect(isGone(agent.pid)).toBe(false);
    expect(files()).toEqual([held.file]);
  });

  // The orphan ignores SIGTERM, so the first sweep holds its claim for the whole grace period: a
  // second sweep that took the claim anyway would find the orphan still alive and stop it again.
  test("two sweeps at once in one process stop an orphan exactly once", async () => {
    const owner = await deadOwner();
    const agent = await termIgnoring();
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { ident: "ENG-4" }));
    const out = collect();
    const [x, y] = await Promise.all([
      sweepOrphans({ stderr: out.stderr }),
      sweepOrphans({ stderr: out.stderr }),
    ]);
    expect(x.stopped.length + y.stopped.length).toBe(1);
    expect(out.lines.filter((l) => l.includes("stopped an orphaned agent")).length).toBe(1);
    expect(files()).toEqual([]);
  }, 20_000);

  // The second command starts once the first holds its claim, so it must see a live claimer's name.
  test("two commands sweeping at once, in two processes, stop an orphan exactly once", async () => {
    const owner = await deadOwner();
    const agent = await termIgnoring();
    const a = startOf(agent.pid);
    writeRecord(rec(a, owner, { ident: "ENG-4" }));
    const script = join(state, "sweep-once.ts");
    writeFileSync(
      script,
      [
        `import { sweepOrphans } from ${JSON.stringify(join(import.meta.dir, "../../src/util/process/sweep.ts"))};`,
        "const r = await sweepOrphans();",
        "process.stdout.write(String(r.stopped.length));",
        "",
      ].join("\n"),
    );
    const run = () =>
      Bun.spawn([process.execPath, script], {
        env: { ...process.env, XDG_STATE_HOME: state },
        stdout: "pipe",
        stderr: "pipe",
      });
    const p = run();
    ownChild(p);
    expect(await until(() => files().some((f) => f.includes(".claimed-")))).toBe(true);
    const q = run();
    ownChild(q);
    const [po, qo, pe, qe] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(q.stdout).text(),
      new Response(p.stderr).text(),
      new Response(q.stderr).text(),
    ]);
    await Promise.all([p.exited, q.exited]);
    expect(Number(po) + Number(qo)).toBe(1);
    expect(`${pe}${qe}`.split(orphanLine("ENG-4", a.pid)).length - 1).toBe(1);
    expect(await until(() => isGone(agent.pid))).toBe(true);
    expect(files()).toEqual([]);
  }, 20_000);
});

// ---- the leftover check from the sweep (section 9.1) -------------------------------------------

describe("the leftover check", () => {
  test("the ancestors of this process are read from parent links, stopping at the system process", () => {
    const row = (pid: number, ppid: number) => ({
      pid,
      ppid,
      pgid: pid,
      startedAt: "1",
      state: "running" as const,
    });
    const table = [row(1, 0), row(10, 1), row(20, 10), row(30, 20), row(40, 30), row(99, 20)];
    expect([...ancestorPids(table, 40)].sort((x, y) => x - y)).toEqual([10, 20, 30]);
    expect([...ancestorPids([row(5, 6), row(6, 5)], 5)].sort()).toEqual([5, 6]); // a loop ends
    expect(ancestorPids(table, 7)).toEqual(new Set()); // not in the listing
  });

  test("the shell that started this command in the worktree is not reported as a leftover (R30)", async () => {
    const worktree = fs.realpathSync(makeTempDir("styre-sweep-wt-"));
    try {
      const owner = await deadOwner();
      const gone = await deadOwner(); // an orphan that had already exited, in this worktree
      await until(() => tokenValue(nowToken()) > tokenValue(gone.startedAt));
      // A real leftover in the worktree, as a control: it must still be reported.
      const left = await nohupLeftover(worktree);
      writeRecord(rec(gone, owner, { worktree }));
      // The sweeping command runs from a shell in the worktree; `; true` keeps the shell from
      // replacing itself with the command, so it stays the command's parent.
      const script = join(state, "sweep-lines.ts");
      writeFileSync(
        script,
        [
          `import { sweepOrphans } from ${JSON.stringify(join(import.meta.dir, "../../src/util/process/sweep.ts"))};`,
          "const r = await sweepOrphans({ stderr: () => {} });",
          "process.stdout.write(JSON.stringify(r.leftoverLines));",
          "",
        ].join("\n"),
      );
      const runner = Bun.spawn(
        [
          "sh",
          "-c",
          'echo $$ >&2; cd "$1" && "$2" "$3"; true',
          "sh",
          worktree,
          process.execPath,
          script,
        ],
        { env: { ...process.env, XDG_STATE_HOME: state }, stdout: "pipe", stderr: "pipe" },
      );
      ownChild(runner);
      const [out, err] = await Promise.all([
        new Response(runner.stdout).text(),
        new Response(runner.stderr).text(),
        runner.exited,
      ]);
      const shellPid = Number(err.trim().split("\n")[0]);
      expect(shellPid).toBe(runner.pid);
      const lines = JSON.parse(out) as string[];
      expect(lines.some((l) => l.includes(`(pid ${left})`))).toBe(true);
      expect(lines.filter((l) => l.includes(`(pid ${shellPid})`))).toEqual([]);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("after stopping an orphan, what it left in its worktree is reported, never stopped", async () => {
    const worktree = fs.realpathSync(makeTempDir("styre-sweep-wt-"));
    try {
      const owner = await deadOwner();
      const agent = spawn(["sleep", NAP]);
      const a = startOf(agent.pid);
      // Something the agent left: a detached process running in the worktree, started after it.
      await until(() => tokenValue(nowToken()) > tokenValue(a.startedAt));
      const left = await nohupLeftover(worktree);
      writeRecord(rec(a, owner, { worktree }));
      const out = collect();
      const r = await sweepOrphans({ stderr: out.stderr });
      expect(r.stopped.length).toBe(1);
      const line = r.leftoverLines.find((l) => l.includes(`(pid ${left})`));
      expect(line).toBe(
        formatLeftover({ pid: left, command: (line ?? "").split('"')[1] ?? "", cwd: worktree }),
      );
      expect(line).toContain(`sleep ${NAP}`);
      expect(out.lines).toContain(line as string);
      expect(isGone(left)).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("a check that could not finish says so", async () => {
    const worktree = makeTempDir("styre-sweep-wt-");
    try {
      __setCwdReadersForTests({ sync: () => "skipped" });
      const owner = await deadOwner();
      const gone = await deadOwner();
      writeRecord(rec(gone, owner, { worktree }));
      const out = collect();
      const r = await sweepOrphans({ stderr: out.stderr });
      expect(r.leftoverLines).toEqual([
        "styre: skipped the check for processes the agent left running in the worktree (it did not finish in time)\n",
      ]);
      expect(out.lines).toEqual(r.leftoverLines);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

// ---- cost ----------------------------------------------------------------------------------------

describe("cost with an empty folder", () => {
  test("one directory read, nothing else: no file read, no process table read", async () => {
    const reads = spyOn(fs, "readdirSync");
    const files = spyOn(fs, "readFileSync");
    const stats = spyOn(fs, "lstatSync");
    const probes = spyOn(procTable, "probe");
    const lists = spyOn(procTable, "listProcesses");
    try {
      await sweepOrphans({ stderr: () => {} }); // no folder at all
      mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
      await sweepOrphans({ stderr: () => {} }); // an empty folder
      expect(reads).toHaveBeenCalledTimes(2);
      expect(files).toHaveBeenCalledTimes(0);
      expect(stats).toHaveBeenCalledTimes(0);
      expect(probes).toHaveBeenCalledTimes(0);
      expect(lists).toHaveBeenCalledTimes(0);
    } finally {
      reads.mockRestore();
      files.mockRestore();
      stats.mockRestore();
      probes.mockRestore();
      lists.mockRestore();
    }
  });
});
