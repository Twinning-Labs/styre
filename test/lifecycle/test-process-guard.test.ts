// R28: no test may find processes by matching text across the machine. A cleanup such as
// `pkill -f "sleep 30[0-9]"` kills a developer's own `sleep 300` and the processes of a test run
// going on beside this one, and a lookup by text sees them as the test's own. Tests clean up only
// what they started, by pid and start time (test/helpers/own-processes.ts).
//
// The scan reads every file under test/ (TypeScript, shell, any fixture) as text and refuses:
//   - the process matching tools: pkill, killall, pgrep, pidof;
//   - a `kill` fed by a text search: `kill $(… grep|awk|ps …)`, `… grep|awk … | xargs kill`, and a
//     `ps … | … kill` pipeline.
// Comments are scanned too: a test file has no reason to name these tools. This file is the one
// exception, since it must spell them to look for them.
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
];

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
  text.split("\n").forEach((line, i) => {
    for (const r of RULES) {
      if (r.re.test(line)) {
        found.push(`${file}:${i + 1}: ${r.name}: ${line.trim()}`);
        break;
      }
    }
  });
  return found;
}

test("no file under test/ finds processes by matching text across the machine", () => {
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
])("allowed: %s", (line) => {
  expect(offences("t.ts", line)).toEqual([]);
});
