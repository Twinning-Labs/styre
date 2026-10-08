// R28: no test may find processes by matching text across the machine. A cleanup such as
// `pkill -f "sleep 30[0-9]"` kills a developer's own `sleep 300` and the processes of a test run
// going on beside this one, and a lookup by text sees them as the test's own. Tests clean up only
// what they started, by pid and start time (test/helpers/own-processes.ts).
//
// The scan reads every file under test/ (TypeScript, shell, any fixture) as text and refuses:
//   - the process matching tools: pkill, killall, pgrep, pidof;
//   - a `kill` fed by a text search: `kill $(… grep|awk|ps …)`, `… grep|awk … | xargs kill`, and a
//     `ps … | … kill` pipeline;
//   - a signal to every process: `kill -1` or `kill 0` as the target (`kill -9 -1`, `kill 0`,
//     `kill -s KILL -1`), `process.kill(-1, …)` or `process.kill(0, …)`, and an argv array that
//     runs kill with -1 or 0 as its last word (`["kill", "-9", "-1"]`);
//   - the cleanup helper's test seams (`__recordForTests`, `__registerGroupForTests`,
//     `__snapshotForTests`, `__releaseForTests`, which bypass its claim rules) anywhere but their
//     own test file;
//   - a `ps` listing of many processes (no `-p`) in a file that also signals processes, on any line:
//     the text filter between the two may be on lines of its own.
// It is a tripwire for the plain forms a test would honestly be written with, not a parser: a
// spelling built to dodge it (a joined string, an escape) is not caught. Comments are scanned too:
// a test file has no reason to name these tools. This file is the one exception, since it must
// spell them to look for them.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SELF = relative(ROOT, import.meta.path);

const RULES: { name: string; re: RegExp }[] = [
  { name: "a process matching tool", re: /\b(?:pkill|killall|pgrep|pidof)\b/ },
  { name: "kill fed by a text search", re: /\bkill\b[^\n]*\$\([^)\n]*\b(?:grep|awk|ps)\b/ },
  {
    name: "kill fed by a text search",
    re: /`[^`\n]*\b(?:grep|awk|ps)\b[^`\n]*`[^\n]*\bkill\b|\bkill\b[^\n]*`[^`\n]*\b(?:grep|awk|ps)\b/,
  },
  { name: "kill fed by a text search", re: /\b(?:grep|awk)\b[^\n]*\|\s*xargs\b[^\n]*\bkill\b/ },
  { name: "kill fed by a text search", re: /\bps\b[^\n]*\|[^\n]*\bkill\b/ },
  {
    name: "a signal to every process",
    re: /\bkill\s+(?:-s\s+\S+\s+|-\S+\s+)*(?:-1|0)\s*(?:$|[;|&)'"`])|\bkill\(\s*(?:-1|0)\s*[,)]|\[\s*["'`]kill["'`](?:\s*,\s*["'`][^"'`]*["'`])*\s*,\s*["'`](?:-1|0)["'`]\s*,?\s*\]/,
  },
];

/** The helper's seams that bypass its claim rules, and the one file allowed to use them. */
const SEAMS = /\b__(?:recordForTests|registerGroupForTests|snapshotForTests|releaseForTests)\b/;
const SEAM_FILES = new Set([
  "test/lifecycle/own-processes.test.ts",
  "test/helpers/own-processes.ts",
]);

/** A `ps` that lists many processes: an argv or a command line starting with ps, without `-p`. */
const PS_LISTING = /\[\s*["'`]ps["'`]|(?:^|[\s;|&(`"'$])ps\s+(?:-[A-Za-z]+|[auxe]+)(?=\s|$|["'`])/;
const PS_ONE_PID = /["'`]-p["'`]|\s-p\b/;
/** Any way a test file signals a process. */
const SIGNALS = /\bprocess\.kill\(|\.kill\(|(?:^|[\s;|&(`"'])kill\s+[-$\d]/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every offending line in `text`, as "file:line: rule: text". */
function offences(file: string, text: string): string[] {
  const found: string[] = [];
  const signals = SIGNALS.test(text);
  text.split("\n").forEach((line, i) => {
    const rule =
      RULES.find((r) => r.re.test(line))?.name ??
      (signals && PS_LISTING.test(line) && !PS_ONE_PID.test(line)
        ? "a ps listing in a file that signals processes"
        : undefined) ??
      (SEAMS.test(line) && !SEAM_FILES.has(file)
        ? "a cleanup helper seam outside its own test file"
        : undefined);
    if (rule) found.push(`${file}:${i + 1}: ${rule}: ${line.trim()}`);
  });
  return found;
}

test("no file under test/ uses a process matching tool, signals every process, kills by a ps listing, or uses a helper seam outside its test", () => {
  const files = walk(join(ROOT, "test")).filter((f) => relative(ROOT, f) !== SELF);
  expect(files.length).toBeGreaterThan(100); // the walk really reached the test tree
  const hits = files.flatMap((f) => offences(relative(ROOT, f), readFileSync(f, "utf8")));
  expect(hits).toEqual([]);
});

test.each([
  ['Bun.spawnSync(["pkill", "-9", "-f", "sleep 30[0-9]"]);'],
  ['Bun.spawnSync(["killall", "sleep"]);'],
  ['Bun.spawnSync(["pgrep", "-f", "sleep 309"]);'],
  ["pidof sleep"],
  ['sh -c "kill -9 $(ps -A | grep sleep | cut -c1-6)"'],
  ["kill `ps -A | awk '/sleep 30/ {print $1}'`"],
  ["ps -A | grep standin | awk '{print $1}' | xargs kill -9"],
  ["pgrep -f marker | xargs -n1 kill"],
  ["kill -9 -1"],
  ["kill 0"],
  ["sh -c 'kill -TERM -1; exit'"],
  ['process.kill(-1, "SIGKILL");'],
  ["process.kill(0);"],
  [
    'const ids = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString();\nfor (const l of ids.split("\\n").filter((x) => x.includes("sleep 30"))) process.kill(Number(l.trim().split(" ")[0]), 9);',
  ],
  ['for p in $(echo x); do :; done\nids=$(ps -A -o pid=,command=)\necho "$ids" > f\nkill -9 "$p"'],
  ['ps aux > list\nkill -9 "$(head -1 list)"'],
  ['Bun.spawnSync(["kill", "-9", "-1"]);'],
  ["Bun.spawnSync(['kill', '0']);"],
  ['Bun.spawn(["kill", "-s", "KILL", "-1"], { stdout: "ignore" });'],
  ["kill -s KILL -1"],
  ["__recordForTests({ pid: 1, startedAt: '1' });"],
  ["const restore = __snapshotForTests();"],
  ["__releaseForTests(child);"],
  ["import { __registerGroupForTests } from '../helpers/own-processes.ts';"],
])("refused: %s", (line) => {
  expect(offences("t.ts", line)).toHaveLength(1);
});

test.each([
  ['process.kill(p.pid, "SIGKILL");'],
  ["trap 'kill -TERM -$TOOL 2>/dev/null; exit 0' TERM INT HUP"],
  ['"styre: could not stop sleep 309 (pid 1); stop it with: kill -9 1"'],
  ['const r = door.runBlocking(sh("kill -TERM $$"), { timeoutMs: 10_000 });'],
  ['Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])'],
  ["const skill = killOwned();"],
  ["kill -1 1234"],
  ['Bun.spawnSync(["kill", "-1", String(pid)]);'],
  ["kill -s TERM 1234"],
  ['kill -0 "$pid"'],
  [
    'const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(p.pid)]);\nprocess.kill(p.pid, "SIGKILL");',
  ],
  ['LC_ALL=C ps -A -o pid=,ppid=,command= > "$1"'],
  ['test("the ps fallback ignores locale", () => { process.kill(p.pid, 9); });'],
])("allowed: %s", (line) => {
  expect(offences("t.ts", line)).toEqual([]);
});
