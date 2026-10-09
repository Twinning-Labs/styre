import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rec from "../../../src/util/process/records.ts";

let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-rec-"));
  process.env.XDG_STATE_HOME = state;
});
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = saved;
  chmodSync(state, 0o700); // a test may have taken the write bit away
  rmSync(state, { recursive: true, force: true });
});

const r = (pid = 4242): rec.LaunchRecord => ({
  version: 1,
  pid,
  startedAt: "123.000456",
  bootId: null,
  kind: "agent",
  ident: "ENG-1",
  stepId: 7,
  worktree: "/tmp/wt",
  command: "claude -p",
  owner: { pid: 1, startedAt: "1.000000", pgid: 1 },
});
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("expected a value");
  return v;
}
const ME = { pid: 9, startedAt: "9.000000" };

test("the folder is a sibling of styre/, never inside it", () => {
  expect(rec.processesDir()).toBe(join(state, "styre-processes"));
});

test("without XDG_STATE_HOME the folder defaults under ~/.local/state", () => {
  process.env.XDG_STATE_HOME = "";
  expect(rec.processesDir()).toMatch(/\.local\/state\/styre-processes$/);
  Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  expect(rec.processesDir()).toMatch(/\.local\/state\/styre-processes$/);
});

test("record names carry pid and start token", () => {
  expect(rec.recordFileName({ pid: 4242, startedAt: "123.000456" })).toBe("4242-123.000456.json");
  expect(rec.recordFileName({ pid: 7, startedAt: "98765" })).toBe("7-98765.json");
});

test("write then list returns the whole record; remove deletes it", () => {
  rec.writeRecord(r());
  const listed = rec.listRecords();
  expect(listed.map((l) => l.record)).toEqual([r()]);
  expect(listed[0].claimedBy).toBeNull();
  expect(listed[0].file).toBe("4242-123.000456.json");
  rec.removeRecord(r());
  expect(rec.listRecords()).toEqual([]);
});

test("a Linux style integer start token round trips", () => {
  const rr = { ...r(), startedAt: "9876543" };
  rec.writeRecord(rr);
  expect(rec.listRecords().map((l) => l.record)).toEqual([rr]);
  rec.removeRecord(rr);
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("listing a folder that does not exist is empty and creates nothing", () => {
  expect(rec.listRecords()).toEqual([]);
  expect(existsSync(rec.processesDir())).toBe(false);
});

test("only exact names are listed; anything else is ignored and left alone", () => {
  rec.writeRecord(r());
  const dir = rec.processesDir();
  // Every file holds a valid record for the name it imitates, so only the exact name rule can exclude it.
  const junk: [string, rec.LaunchRecord][] = [
    ["notes.txt", r()],
    ["4242-123.000456.json.bak", r()],
    ["x4242-123.000456.json", r()],
    ["4242-123.000456.jsonx", r()],
    ["4242-123.000456.json.claimed-abc", r()],
    ["4242-123.000456.json.claimed-3-4.bak", r()],
    ["4242-123.000456.json.claimed-3-4.5", r()],
    ["4242-123.000456.json.claimed-3-4.000001.bak", r()],
    ["4242-123.0004.json", { ...r(), startedAt: "123.0004" }],
    ["4242-123.0004567.json", { ...r(), startedAt: "123.0004567" }],
    [".4242-123.000456.json.tmp-5", r()],
  ];
  for (const [n, content] of junk) writeFileSync(join(dir, n), JSON.stringify(content));
  expect(rec.listRecords().map((l) => l.file)).toEqual(["4242-123.000456.json"]);
  rec.removeRecord(r());
  expect(readdirSync(dir).sort()).toEqual(junk.map(([n]) => n).sort());
});

test("removing a record leaves claimed copies of other start times and other pids alone", () => {
  const dir = rec.processesDir();
  const other = { ...r(), startedAt: "999.000001" };
  rec.writeRecord(r());
  rec.writeRecord(other);
  rec.claim(must(rec.listRecords().find((l) => l.record.startedAt === "999.000001")), ME);
  rec.removeRecord(r());
  expect(readdirSync(dir)).toEqual(["4242-999.000001.json.claimed-9-9.000000"]);
});

test("removing a record never touches a claimed copy of a different record", () => {
  const dir = rec.processesDir();
  rec.writeRecord(r(4242));
  rec.writeRecord(r(42));
  rec.claim(must(rec.listRecords().find((l) => l.record.pid === 42)), ME);
  rec.removeRecord(r(4242));
  expect(readdirSync(dir)).toEqual(["42-123.000456.json.claimed-9-9.000000"]);
});

test("a directory, a symlink or a mismatched file with a record name is not a record", () => {
  const dir = rec.processesDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "1-1.json"));
  writeFileSync(join(state, "target.json"), JSON.stringify(r(2)));
  symlinkSync(join(state, "target.json"), join(dir, "2-123.000456.json"));
  writeFileSync(join(dir, "3-123.000456.json"), JSON.stringify(r(4242))); // content pid differs from the name
  writeFileSync(join(dir, "5-123.000456.json"), "{ not json");
  writeFileSync(join(dir, "6-123.000456.json"), JSON.stringify({ ...r(6), version: 2 }));
  writeFileSync(join(dir, "7-123.000456.json"), "null");
  expect(rec.listRecords()).toEqual([]);
});

test("a claim renames with the claimer; a second claim fails; unclaim restores", () => {
  rec.writeRecord(r());
  const [l] = rec.listRecords();
  const c = rec.claim(l, ME);
  expect(c?.claimedBy).toEqual(ME);
  expect(c?.file).toBe("4242-123.000456.json.claimed-9-9.000000");
  expect(readdirSync(rec.processesDir())).toEqual(["4242-123.000456.json.claimed-9-9.000000"]);
  expect(rec.claim(l, { pid: 10, startedAt: "10.000000" })).toBeNull();
  const listed = rec.listRecords();
  expect(listed.length).toBe(1);
  expect(listed[0].claimedBy).toEqual(ME);
  expect(listed[0].record).toEqual(r());
  rec.unclaim(must(c));
  expect(rec.listRecords()[0].claimedBy).toBeNull();
  expect(readdirSync(rec.processesDir())).toEqual(["4242-123.000456.json"]);
});

test("a stale claim can be retaken by another claimer", () => {
  rec.writeRecord(r());
  rec.claim(rec.listRecords()[0], ME);
  const stale = rec.listRecords()[0];
  const again = rec.claim(stale, { pid: 10, startedAt: "10.000000" });
  expect(again?.claimedBy).toEqual({ pid: 10, startedAt: "10.000000" });
  expect(readdirSync(rec.processesDir())).toEqual(["4242-123.000456.json.claimed-10-10.000000"]);
  rec.unclaim(must(again));
  expect(readdirSync(rec.processesDir())).toEqual(["4242-123.000456.json"]);
});

test("removing a claimed record removes the claimed copy too (review round 2, N9)", () => {
  rec.writeRecord(r());
  rec.claim(rec.listRecords()[0], ME);
  rec.removeRecord(r());
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("removing a record that is not there is not an error", () => {
  rec.removeRecord(r());
  rec.writeRecord(r());
  rec.removeRecord(r());
  rec.removeRecord(r());
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("unclaim does not resurrect a record the owner removed meanwhile", () => {
  rec.writeRecord(r());
  const c = must(rec.claim(rec.listRecords()[0], ME));
  rec.removeRecord(r());
  rec.unclaim(c);
  expect(rec.listRecords()).toEqual([]);
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("removeRecord repeats when a claimed copy is put back after its first pass (N9)", () => {
  rec.writeRecord(r());
  const passes: number[] = [];
  rec.removeRecord(r(), {
    afterPass: (pass) => {
      passes.push(pass);
      if (pass === 0) rec.writeRecord(r()); // a sweep renames its claimed copy back after the owner's pass
    },
  });
  expect(passes).toEqual([0, 1]);
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("removeRecord repeats when a peer claims the record after its first pass (N9)", () => {
  rec.writeRecord(r());
  const passes: number[] = [];
  rec.removeRecord(r(), {
    afterPass: (pass) => {
      passes.push(pass);
      if (pass !== 0) return;
      rec.writeRecord(r());
      rec.claim(must(rec.listRecords()[0]), ME); // a sweep claims it again just before the owner checks
    },
  });
  expect(passes).toEqual([0, 1]);
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("removeRecord is not fooled by a claimed copy that is renamed back during its final check (N9)", () => {
  rec.writeRecord(r());
  let fired = false;
  rec.removeRecord(r(), {
    afterPass: (pass) => {
      if (pass !== 0) return;
      rec.writeRecord(r());
      rec.claim(must(rec.listRecords()[0]), ME); // the record is under a sweep's claim when the check starts
    },
    betweenChecks: (step) => {
      if (step !== 2 || fired) return;
      fired = true;
      rec.unclaim(must(rec.listRecords()[0])); // the sweep puts it back between two observations
    },
  });
  expect(fired).toBe(true);
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("removeRecord is not fooled by a claim that appears during its final check (N9)", () => {
  rec.writeRecord(r());
  let fired = false;
  rec.removeRecord(r(), {
    betweenChecks: (step) => {
      if (step !== 1 || fired) return;
      fired = true;
      rec.writeRecord(r());
      rec.claim(must(rec.listRecords()[0]), ME); // a sweep claims it between two observations
    },
  });
  expect(fired).toBe(true);
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("removeRecord gives up with an error when a peer never lets go", () => {
  rec.writeRecord(r());
  expect(() =>
    rec.removeRecord(r(), { deadlineMs: 30, afterPass: () => rec.writeRecord(r()) }),
  ).toThrow(/within 30 ms/);
});

test("removing fails loudly when the folder does not let the file go", () => {
  rec.writeRecord(r());
  chmodSync(rec.processesDir(), 0o500);
  try {
    expect(() => rec.removeRecord(r())).toThrow(/EACCES|permission/i);
  } finally {
    chmodSync(rec.processesDir(), 0o700);
  }
  expect(readdirSync(rec.processesDir())).toEqual(["4242-123.000456.json"]);
});

test("a failed write leaves no temporary file and no record", () => {
  const dir = rec.processesDir();
  mkdirSync(join(dir, "4242-123.000456.json"), { recursive: true }); // a directory is in the way of the rename
  expect(() => rec.writeRecord(r())).toThrow();
  expect(readdirSync(dir)).toEqual(["4242-123.000456.json"]);
});

test("an unwritable state folder fails loudly (Review Focus 4)", () => {
  chmodSync(state, 0o500);
  try {
    expect(() => rec.writeRecord(r())).toThrow();
  } finally {
    chmodSync(state, 0o700);
  }
});

test("an unwritable record folder fails loudly and leaves nothing behind", () => {
  mkdirSync(rec.processesDir(), { recursive: true });
  chmodSync(rec.processesDir(), 0o500);
  try {
    expect(() => rec.writeRecord(r())).toThrow();
  } finally {
    chmodSync(rec.processesDir(), 0o700);
  }
  expect(readdirSync(rec.processesDir())).toEqual([]);
});

test("the record is written to a temporary name and renamed, never written in place", () => {
  // A directory squats on the temporary name this process would use. A write that goes through the
  // temporary name must fail and leave no record; a write straight to the final name would succeed.
  mkdirSync(join(rec.processesDir(), `.4242-123.000456.json.tmp-${process.pid}`), {
    recursive: true,
  });
  expect(() => rec.writeRecord(r())).toThrow();
  expect(readdirSync(rec.processesDir()).filter((n) => !n.startsWith("."))).toEqual([]);
});
