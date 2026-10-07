// The cleanup helper every lifecycle test relies on (test/helpers/own-processes.ts, R28). Its whole
// safety property is that it signals a process only while the table shows the very process it was
// given, by pid AND start time, and that a pid it only read from output is taken only when the
// process started after the fixture did and sits in the expected group. Each test here uses
// processes it starts itself.
import { afterEach, expect, test } from "bun:test";
import {
  type ProcInfo,
  listProcesses,
  nowToken,
  probe,
  tokenValue,
} from "../../src/util/process/proc-table.ts";
import {
  allGone,
  isAlive,
  killOwned,
  own,
  ownPrinted,
  ownTree,
  until,
} from "../helpers/own-processes.ts";

/** Every child a test here spawned, killed through its own Bun handle after the test. */
const children: Bun.Subprocess[] = [];
afterEach(() => {
  killOwned();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill(9);
});

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
