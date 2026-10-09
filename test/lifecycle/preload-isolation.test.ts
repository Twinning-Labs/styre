// test/preload.ts gives every test run a state folder of its own, even when the environment already
// names one (an operator's XDG_STATE_HOME is their REAL state folder), and its guard watches the
// folder the environment named before the preload ran (final review B m2). Each case runs a nested
// `bun test` of a probe with XDG_STATE_HOME pointing at a stand-in "real" folder made here.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const PROBE = "./test/lifecycle/fixtures/preload-probe.ts";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-preload-iso-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function probe(env: Record<string, string>) {
  const r = Bun.spawnSync([process.execPath, "test", PROBE], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const text = `${r.stdout.toString()}${r.stderr.toString()}`;
  return { code: r.exitCode, text, state: /probe state=(\S+)/.exec(text)?.[1] };
}

test("with XDG_STATE_HOME already set, the run still gets a fresh state folder, removed at the end", () => {
  const real = mkdtempSync(join(scratch, "real-"));
  const r = probe({ XDG_STATE_HOME: real });
  expect(r.code, r.text).toBe(0);
  expect(r.state).toBeDefined();
  expect(r.state).not.toBe(real);
  expect(r.state as string).toContain("styre-test-state-");
  expect(existsSync(r.state as string)).toBe(false);
  expect(readdirSync(real)).toEqual([]);
});

test("the guard watches the folder XDG_STATE_HOME named before the preload: a record there fails the run", () => {
  const real = mkdtempSync(join(scratch, "real-"));
  const records = join(real, "styre-processes");
  mkdirSync(records);
  const r = probe({ XDG_STATE_HOME: real, PROBE_WRITE_INTO: records });
  expect(r.code).not.toBe(0);
  expect(r.text).toContain(
    `a test wrote launch records into the operator's real ${records}: 4242-1.json`,
  );
});
