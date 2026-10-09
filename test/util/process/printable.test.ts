// ENG-485 final review C M1: command lines and other text a process can set (its argv) reach the
// operator's terminal, the run database and the telemetry stream. Control characters in them are
// replaced first, so a leftover cannot write terminal escapes (OSC 52 can set the clipboard) or a
// newline that forges a `styre:` line of its own.
//
// The real processes here are this test's own (a shell and its sleep), claimed at start and stopped
// in afterEach; the sleep ends by itself after 22.8 s whatever happens.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lsImpl } from "../../../src/cli/ls.ts";
import { describeProcess } from "../../../src/util/process/door.ts";
import {
  commandFromCmdline,
  commandOf,
  formatLeftover,
  skippedLine,
} from "../../../src/util/process/leftovers.ts";
import { printable } from "../../../src/util/process/printable.ts";
import { probe } from "../../../src/util/process/proc-table.ts";
import { processesDir, recordFileName, scanRecords } from "../../../src/util/process/records.ts";
import { sweepOrphans } from "../../../src/util/process/sweep.ts";
import { killOwned, own, ownTree, until } from "../../helpers/own-processes.ts";
import { makeTempDir } from "../../helpers/temp.ts";

afterEach(() => {
  killOwned();
});

/** Any C0 control, DEL or C1 control. */
const CONTROL = {
  test: (s: string): boolean =>
    [...s].some((c) => {
      const n = c.codePointAt(0) as number;
      return n <= 0x1f || (n >= 0x7f && n <= 0x9f);
    }),
};

test("printable replaces every C0 and C1 control character and DEL with ?, and keeps the rest", () => {
  expect(printable("a\u0000b\tc\nd\u001b]52;c;eA==\u0007e\u007ff\u009bg")).toBe(
    "a?b?c?d?]52;c;eA==?e?f?g",
  );
  expect(printable("node server.js --port 80 é ☃")).toBe("node server.js --port 80 é ☃");
});

test("reviewer C's escape probe: a leftover line carries no control character but its own newline", () => {
  const raw =
    "node\u0000x\u001b]52;c;ZWNobyBwd25lZA==\u0007\nstyre: run interrupted; resume with: styre run --resume ENG-1\u0000";
  const line = formatLeftover({ pid: 4321, command: commandFromCmdline(raw), cwd: "/wt" });
  expect(line.endsWith("\n")).toBe(true);
  expect(CONTROL.test(line.slice(0, -1))).toBe(false);
  expect(line).toBe(
    'styre: the agent left "node x?]52;c;ZWNobyBwd25lZA==??styre: run interrupted; resume with: styre run --resume ENG-1" (pid 4321) running in the worktree; stop it with: kill 4321 (if it is not yours)\n',
  );
});

test("a skipped check's reason carries no control character", () => {
  const line = skippedLine("lsof exited with status 1: /wt/\u001b[2Jx\nstyre: forged");
  expect(CONTROL.test(line.slice(0, -1))).toBe(false);
});

test.skipIf(!Bun.which("ps"))(
  "describeProcess of a real process whose argv holds escapes returns no control character",
  async () => {
    const marker = "\u001b]52;c;eA==\u0007\nstyre: forged";
    const p = Bun.spawn(["sh", "-c", "sleep 22.8119; :", marker], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const info = probe(p.pid);
    if (info.kind === "alive") own(info.info);
    // Its `sleep`, claimed too while it is this test's descendant: a cleanup that killed the shell
    // alone, just as it forked, would orphan the sleep out of every cleanup's reach.
    expect(await until(() => info.kind === "alive" && ownTree(info.info).length >= 2)).toBe(true);
    expect(await until(() => describeProcess(p.pid, "?").includes("52;c;"))).toBe(true);
    const text = describeProcess(p.pid, "?");
    expect(CONTROL.test(text)).toBe(false);
  },
);

test("the leftover check's command of a real process whose argv holds escapes has no control character", async () => {
  const marker = "\u001b]52;c;eA==\u0007\nstyre: forged";
  const p = Bun.spawn(["sh", "-c", "sleep 22.8119; :", marker], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const info = probe(p.pid);
  if (info.kind === "alive") own(info.info);
  // Its `sleep`, claimed too while it is this test's descendant: a cleanup that killed the shell
  // alone, just as it forked, would orphan the sleep out of every cleanup's reach.
  expect(await until(() => info.kind === "alive" && ownTree(info.info).length >= 2)).toBe(true);
  expect(await until(() => commandOf(p.pid).includes("52;c;"))).toBe(true);
  expect(CONTROL.test(commandOf(p.pid))).toBe(false);
});

test("a record read from disk has a printable command", () => {
  const dir = makeTempDir("styre-printable-");
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    const r = {
      version: 1 as const,
      pid: 4321,
      startedAt: "1.000000",
      bootId: null,
      kind: "group" as const,
      ident: "ENG-1",
      stepId: null,
      worktree: null,
      command: "make\u001b[2J\nstyre: forged",
      owner: { pid: 999999, startedAt: "1.000000", pgid: 999999 },
    };
    mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(processesDir(), recordFileName(r)), JSON.stringify(r), { mode: 0o600 });
    const [l] = scanRecords().listed;
    expect(l.record.command).toBe("make?[2J?styre: forged");
  } finally {
    process.env.XDG_STATE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An ident with a terminal escape (OSC 52 sets the clipboard) and a newline that forges a line. */
const EVIL_IDENT = "ENG-1\u001b]52;c;eA==\u0007\nstyre: forged";
const SAFE_IDENT = "ENG-1?]52;c;eA==??styre: forged";

test("the sweep's lines carry a record's ident with no control character (final re-review A N2, C D3)", async () => {
  const dir = makeTempDir("styre-printable-");
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    // A record from another boot: the sweep removes it and says so, naming its run, and never
    // looks at (or signals) the pid it names.
    const r = {
      version: 1 as const,
      pid: 4321,
      startedAt: "1.000000",
      bootId: "not-this-boot",
      kind: "agent" as const,
      ident: EVIL_IDENT,
      stepId: null,
      worktree: null,
      command: "claude",
      owner: { pid: 999999, startedAt: "1.000000", pgid: 999999 },
    };
    mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(processesDir(), recordFileName(r)), JSON.stringify(r), { mode: 0o600 });
    const lines: string[] = [];
    await sweepOrphans({ stderr: (s) => lines.push(s) });
    expect(lines).toEqual([
      `styre: removed the launch record for pid 4321 from ${SAFE_IDENT}: it was written before this machine last started, so nothing was stopped\n`,
    ]);
  } finally {
    process.env.XDG_STATE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("styre ls lists a stopped orphan's ident with no control character", async () => {
  const root = makeTempDir("styre-printable-");
  const out: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  try {
    await lsImpl({
      root,
      swept: [
        {
          version: 1,
          pid: 4321,
          startedAt: "1.000000",
          bootId: null,
          kind: "agent",
          ident: EVIL_IDENT,
          stepId: null,
          worktree: null,
          command: "claude",
          owner: { pid: 999999, startedAt: "1.000000", pgid: 999999 },
        },
      ],
    });
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
  const text = out.join("");
  expect(text).toContain(`  ${SAFE_IDENT}  [agent, pid 4321]  claude\n`);
  for (const line of text.split("\n")) expect(CONTROL.test(line)).toBe(false);
});

test("shellWord leaves a plain path as it is and makes any other one a single quoted shell word", async () => {
  const { shellWord } = await import("../../../src/util/process/printable.ts");
  expect(shellWord("/var/folders/qb/T/styre-cmd-Ab3xY9")).toBe(
    "/var/folders/qb/T/styre-cmd-Ab3xY9",
  );
  expect(shellWord("/Users/me/work tmp/styre-cmd-Ab3xY9")).toBe(
    "'/Users/me/work tmp/styre-cmd-Ab3xY9'",
  );
  expect(shellWord("/tmp/it's/x")).toBe("'/tmp/it'\\''s/x'");
  expect(shellWord("/tmp/$(rm -rf ~)")).toBe("'/tmp/$(rm -rf ~)'");
  // No space needed for a path to need quoting: expansion, globs, separators.
  for (const s of [
    "/tmp/a$(id)b",
    "/tmp/a`id`b",
    "/tmp/a*b",
    "/tmp/a;b",
    "/tmp/a&b",
    "/tmp/~a",
    "/tmp/a|b",
  ])
    expect(shellWord(s)).toBe(`'${s}'`);
  // What a shell makes of each: the one word it was.
  for (const s of ["/Users/me/work tmp/x", "/tmp/it's/x", "/tmp/$(echo hi)", "/tmp/a;b"]) {
    const r = Bun.spawnSync(["sh", "-c", `printf '%s' ${shellWord(s)}`]);
    expect(r.stdout.toString()).toBe(s);
  }
});
