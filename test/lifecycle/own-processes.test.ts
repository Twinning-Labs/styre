// The cleanup helper every lifecycle test relies on (test/helpers/own-processes.ts, R28). Its whole
// safety property: it claims a process only by structure (a descendant of this test process when it
// is claimed, or a member of a group this test created), records its pid and start time, and
// signals only those recorded processes, each checked again just before its signal.
//
// Each test here signals only processes it starts itself. The refusal tests also put the helper's
// records back as they were before them (`__snapshotForTests`, in a `finally`): whatever a
// regression let them claim, a candidate or the tree `ownTree` found under it, is never signalled.
// Breaks that weaken who may be signalled are proved in a container, never on a developer machine.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ProcInfo,
  listProcesses,
  nowToken,
  probe,
  tokenValue,
} from "../../src/util/process/proc-table.ts";
import {
  __recordForTests,
  __registerGroupForTests,
  __snapshotForTests,
  allGone,
  isAlive,
  killOwned,
  own,
  ownPrinted,
  ownTree,
  registerGroup,
  registeredGroups,
  stillRunning,
  until,
  wouldClaim,
} from "../helpers/own-processes.ts";

/** Every child a test here spawned, killed through its own Bun handle after the test. */
const children: Bun.Subprocess[] = [];
/** Files whose creation ends a looping fixture by itself (no signal needed), in folders of their
 *  own, removed after each test (the loops also end once their folder is gone). */
const doneFiles: string[] = [];
afterEach(() => {
  killOwned();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill(9);
  for (const f of doneFiles.splice(0)) {
    writeFileSync(f, "");
    rmSync(dirname(f), { recursive: true, force: true });
  }
});

/**
 * An orphan the test started: a shell (in a group of its own when `detached`) starts a loop in the
 * background that ends by itself once a file exists, prints the loop's pid, and waits. The test then
 * kills the shell through its own handle, so the loop's parent is gone before any claim: the loop is
 * neither a descendant of this test process any more, nor in its tree. `end()` ends the loop
 * without a signal.
 */
async function orphan(detached: boolean): Promise<{
  shell: ProcInfo;
  loop: ProcInfo;
  since: string;
  end: () => void;
}> {
  const done = join(mkdtempSync(join(tmpdir(), "styre-own-")), "done");
  doneFiles.push(done);
  const since = nowToken();
  const c = Bun.spawn(
    [
      "sh",
      "-c",
      '(while [ ! -e "$1" ] && [ -d "${1%/*}" ]; do sleep 0.05; done) & echo $!; wait',
      "sh",
      done,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached },
  );
  children.push(c);
  const shellNow = probe(c.pid);
  if (shellNow.kind !== "alive") throw new Error("the shell is not in the table");
  const reader = c.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const r = await reader.read();
    if (r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  void reader.cancel();
  const pid = Number(text.trim());
  const loopNow = probe(pid);
  if (loopNow.kind !== "alive") throw new Error(`the loop ${pid} is not in the table`);
  return {
    shell: shellNow.info,
    loop: loopNow.info,
    since,
    end: () => writeFileSync(done, ""),
  };
}

/** Kill the orphan's shell through its own handle, and wait until the loop is an orphan. */
async function dropParent(shell: ProcInfo, loop: ProcInfo): Promise<void> {
  const c = children.find((x) => x.pid === shell.pid);
  c?.kill(9);
  await c?.exited;
  expect(
    await until(() => {
      const now = probe(loop.pid);
      return now.kind === "alive" && now.info.ppid !== shell.pid;
    }),
  ).toBe(true);
}

function spawn(argv: string[], opts: { detached?: boolean } = {}): ProcInfo {
  const c = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", ...opts });
  children.push(c);
  const p = probe(c.pid);
  if (p.kind !== "alive") throw new Error(`the child ${c.pid} is not in the table`);
  return p.info;
}

/** Another start time for the same pid: what a pid handed out again looks like. */
const reused = (p: ProcInfo): ProcInfo => ({
  ...p,
  startedAt: String(tokenValue(p.startedAt) - 100),
});

test("a pid remembered with another start time is never signalled; with its own, it is", async () => {
  const child = spawn(["sleep", "30"]);
  own(reused(child));
  expect(killOwned()).toBe(0);
  // The process stays: nothing was sent to it (a signal, had one been sent, kills a sleep at once).
  expect(isAlive(child)).toBe(true);
  expect(probe(child.pid)).toMatchObject({ kind: "alive", info: { startedAt: child.startedAt } });
  own(child);
  expect(killOwned()).toBe(1);
  expect(await allGone([child])).toBe(true);
});

test("ownTree of a root whose start time does not match takes nothing", () => {
  const child = spawn(["sleep", "30"]);
  expect(ownTree(reused(child))).toEqual([]);
  expect(ownTree(child).map((p) => p.pid)).toEqual([child.pid]);
});

test("a process the helper owns is stopped, with what it started", async () => {
  const shell = spawn(["sh", "-c", "sleep 30 & wait"]);
  let tree: ProcInfo[] = [];
  expect(
    await until(() => {
      tree = listProcesses().filter((p) => p.pid === shell.pid || p.ppid === shell.pid);
      return tree.length === 2;
    }),
  ).toBe(true);
  own(shell); // only the shell: its sleep child is found from it at kill time
  expect(killOwned()).toBe(2);
  expect(await allGone(tree)).toBe(true);
});

test("a printed pid that started before the token is refused", async () => {
  const child = spawn(["sleep", "30"]);
  // A token strictly after the child's start.
  expect(await until(() => tokenValue(nowToken()) > tokenValue(child.startedAt))).toBe(true);
  const since = nowToken();
  expect(ownPrinted(child.pid, since)).toBeNull();
  expect(killOwned()).toBe(0);
  expect(isAlive(child)).toBe(true);
});

test("a printed pid in another group than the one expected is refused; in its own, it is taken", () => {
  const since = nowToken();
  const child = spawn(["sleep", "30"], { detached: true }); // it leads a group of its own
  const me = probe(process.pid);
  expect(me.kind).toBe("alive");
  const myGroup = me.kind === "alive" ? me.info.pgid : -1;
  expect(child.pgid).not.toBe(myGroup);
  expect(ownPrinted(child.pid, since, { pgid: myGroup })).toBeNull();
  expect(killOwned()).toBe(0);
  expect(isAlive(child)).toBe(true);
  expect(ownPrinted(child.pid, since, { pgid: child.pid })).toMatchObject({ pid: child.pid });
  expect(killOwned()).toBe(1);
});

test("a printed pid that is not a live process, or is this test process, is refused", () => {
  const since = "0";
  expect(ownPrinted(Number.NaN, since)).toBeNull();
  expect(ownPrinted(1, since)).toBeNull();
  expect(ownPrinted(process.pid, since)).toBeNull();
});

test("an orphan whose parent died before the claim is claimed through a group the test made, and stopped", async () => {
  const o = await orphan(true);
  expect(registerGroup(o.shell)).toBe(true); // the shell is this test's child and leads its group
  await dropParent(o.shell, o.loop);
  expect(ownPrinted(o.loop.pid, o.since)).toMatchObject({ pid: o.loop.pid, pgid: o.shell.pid });
  expect(killOwned()).toBeGreaterThanOrEqual(1);
  expect(await allGone([o.loop])).toBe(true);
});

test("an orphan in a group the test never registered is refused, and is left running", async () => {
  // A process outside this test's tree and outside any group it made: what an unrelated process
  // looks like to the helper.
  const o = await orphan(true);
  await dropParent(o.shell, o.loop);
  const restore = __snapshotForTests();
  try {
    expect(ownPrinted(o.loop.pid, o.since)).toBeNull();
    expect(own(o.loop)).toEqual([]);
    expect(isAlive(o.loop)).toBe(true);
  } finally {
    restore();
  }
  expect(killOwned()).toBe(0);
  expect(isAlive(o.loop)).toBe(true);
  o.end(); // it ends by itself: no signal from the test
  expect(await allGone([o.loop])).toBe(true);
});

test("an orphan in the test's own group, not descended from the test, is refused", async () => {
  const o = await orphan(false); // same group as this test process
  await dropParent(o.shell, o.loop);
  const me = probe(process.pid);
  expect(me.kind === "alive" && o.loop.pgid === me.info.pgid).toBe(true);
  const restore = __snapshotForTests();
  try {
    expect(ownPrinted(o.loop.pid, o.since)).toBeNull();
    expect(own(o.loop)).toEqual([]);
    expect(isAlive(o.loop)).toBe(true);
  } finally {
    restore();
  }
  expect(killOwned()).toBe(0);
  expect(isAlive(o.loop)).toBe(true);
  o.end();
  expect(await allGone([o.loop])).toBe(true);
});

test("pid 1 and every ancestor of the test process are refused, and so are their groups", () => {
  const table = listProcesses();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const ancestors: ProcInfo[] = [];
  for (
    let p = byPid.get(process.pid);
    p && p.ppid > 0 && !ancestors.some((a) => a.pid === p?.ppid);
  ) {
    const parent = byPid.get(p.ppid);
    if (!parent) break;
    ancestors.push(parent);
    p = parent;
  }
  expect(ancestors.length).toBeGreaterThan(0);
  expect(ancestors.some((a) => a.pid === process.ppid)).toBe(true);
  const init = byPid.get(1);
  const candidates = [...ancestors, ...(init ? [init] : [])];
  const restore = __snapshotForTests();
  try {
    for (const a of candidates) {
      expect(ownPrinted(a.pid, "0")).toBeNull();
      expect(own(a)).toEqual([]);
      expect(ownTree(a, table)).toEqual([]);
      expect(registerGroup(a)).toBe(false);
    }
    const me = byPid.get(process.pid);
    if (me) expect(registerGroup(me)).toBe(false);
  } finally {
    restore(); // drops whatever was recorded above, the candidates' trees included
  }
  expect(killOwned()).toBe(0);
});

test("a group is registered only when its leader is the test's own child and leads it", async () => {
  const notLeading = spawn(["sleep", "30"]); // this test's child, but in this test's group
  expect(registerGroup(notLeading)).toBe(false);
  const leading = spawn(["sleep", "30"], { detached: true });
  expect(registerGroup(reused(leading))).toBe(false); // not the process the table shows
  expect(registerGroup(leading)).toBe(true);
  // A grandchild that leads a group of its own (bash runs it with job control; dash would not).
  const since = nowToken();
  const sh = Bun.spawn(["bash", "-c", "set -m; sleep 30 & echo $!; wait"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  children.push(sh);
  const text = await new Promise<string>((resolve) => {
    const reader = sh.stdout.getReader();
    let t = "";
    const read = (): void => {
      void reader.read().then((r) => {
        if (!r.done) t += new TextDecoder().decode(r.value);
        if (r.done || t.includes("\n")) {
          void reader.cancel();
          resolve(t);
        } else read();
      });
    };
    read();
  });
  const grandchild = ownPrinted(Number(text.trim()), since); // claimed by descent, for cleanup
  expect(grandchild).not.toBeNull();
  if (grandchild) {
    expect(grandchild.pgid).toBe(grandchild.pid);
    expect(registerGroup(grandchild)).toBe(false); // it leads its group, but is not a child
  }
});

test("the end of run leak check names a recorded process that is still running", async () => {
  const child = spawn(["sleep", "30"]);
  own(child);
  expect((await stillRunning(0)).map((l) => l.pid)).toContain(child.pid);
  expect(killOwned()).toBe(1);
  expect(await allGone([child])).toBe(true);
  expect((await stillRunning()).map((l) => l.pid)).not.toContain(child.pid);
});

test("at kill time a recorded pid whose start time no longer matches is not signalled", async () => {
  // What a recorded process looks like once it has ended and its pid went to another process: the
  // only check left between the record and the signal is the one made just before the signal.
  const child = spawn(["sleep", "30"]);
  const restore = __snapshotForTests();
  __recordForTests(reused(child));
  try {
    expect(killOwned()).toBe(0);
    expect(isAlive(child)).toBe(true);
  } finally {
    restore();
  }
  own(child);
  expect(killOwned()).toBe(1);
  expect(await allGone([child])).toBe(true);
});

test("a group made by setpgid alone (inside this test's session) is never registered", async () => {
  // A child that leads its group but not a session: any process of this session could join it.
  const c = Bun.spawn(["perl", "-e", '$| = 1; setpgrp(0, 0); print "ready\\n"; sleep 30'], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  children.push(c);
  const reader = c.stdout.getReader();
  let text = "";
  while (!text.includes("ready")) {
    const r = await reader.read();
    if (r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  void reader.cancel();
  const now = probe(c.pid);
  expect(now.kind === "alive" && now.info.pgid === c.pid).toBe(true); // it leads its group
  if (now.kind === "alive") {
    expect(registerGroup(now.info)).toBe(false);
    expect(registeredGroups()).not.toContain(c.pid);
  }
  // The same child spawned `detached` leads its session too, and is registered.
  const leader = spawn(["sleep", "30"], { detached: true });
  expect(registerGroup(leader)).toBe(true);
  expect(registeredGroups()).toContain(leader.pid);
});

test("a registered group is dropped once it has no member left", async () => {
  const leader = spawn(["sleep", "30"], { detached: true });
  expect(registerGroup(leader)).toBe(true);
  own(); // a read with the member alive keeps the group
  expect(registeredGroups()).toContain(leader.pid);
  const c = children.find((x) => x.pid === leader.pid);
  c?.kill(9);
  await c?.exited;
  own(); // the next read sees the group empty, so its id can no longer count
  expect(registeredGroups()).not.toContain(leader.pid);
});

/** A table built by the test (no process is signalled): this process, its fake parent and init. */
function builtTable(selfStart: string, extra: ProcInfo[]): ProcInfo[] {
  const row = (pid: number, ppid: number, pgid: number, startedAt: string): ProcInfo => ({
    pid,
    ppid,
    pgid,
    startedAt,
    state: "running",
  });
  return [
    row(1, 0, 1, "1.000000"),
    row(900001, 1, 900001, "50.000000"),
    row(process.pid, 900001, 900001, selfStart),
    ...extra,
  ];
}

test("rule 1 needs every parent on the ppid chain to have started no later than its child", () => {
  const row = (pid: number, ppid: number, startedAt: string): ProcInfo => ({
    pid,
    ppid,
    pgid: 900020,
    startedAt,
    state: "running",
  });
  const x = row(900010, 900011, "300.000000");
  // The parent is older than x, and this process older than the parent: x descends.
  expect(wouldClaim(x, builtTable("100.000000", [x, row(900011, process.pid, "200.000000")]))).toBe(
    true,
  );
  // The parent started after x: its pid was handed out again, so x is not this test's.
  expect(wouldClaim(x, builtTable("100.000000", [x, row(900011, process.pid, "400.000000")]))).toBe(
    false,
  );
  // This process started after the parent it seems to have: the same.
  expect(wouldClaim(x, builtTable("250.000000", [x, row(900011, process.pid, "200.000000")]))).toBe(
    false,
  );
});

test("rule 2 refuses a member of a registered group that started before the group's leader", () => {
  const leader: ProcInfo = {
    pid: 900100,
    ppid: 1,
    pgid: 900100,
    startedAt: "200.000000",
    state: "running",
  };
  const member = (startedAt: string): ProcInfo => ({
    pid: 900101,
    ppid: 1,
    pgid: 900100,
    startedAt,
    state: "running",
  });
  const unregister = __registerGroupForTests(900100, leader);
  try {
    const older = member("150.000000");
    expect(wouldClaim(older, builtTable("100.000000", [leader, older]))).toBe(false);
    const younger = member("250.000000");
    expect(wouldClaim(younger, builtTable("100.000000", [leader, younger]))).toBe(true);
  } finally {
    unregister();
  }
});
