// The guards around the live smoke's money and its key (ENG-485 Task 16, re-review 1), run against
// the real scripts with stand-ins for what costs money or holds a secret:
//   N1: scripts/smoke-lifecycle.ts refuses to start without an explicit mode, or with anything it
//       does not know, before any `claude` is run (a recorder `claude` first on PATH must never be
//       called);
//   N4: scripts/smoke-lifecycle-container.sh, with a fake `docker` and a made-up sentinel as
//       ANTHROPIC_API_KEY, never shows the value: not in its output, not on docker's argv, not in any
//       file it writes; and it never turns on `set -x`;
//   N2: Ctrl-C (SIGINT to the script's process group, as a terminal sends it) while the container
//       runs stops the container and ends the script non-zero, without PASS.
// The container script runs from a copy in a tiny throwaway repository that has the baseline branch,
// so neither the real baseline nor docker is needed. Every process is the test's own
// (test/helpers/own-processes.ts).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcesses, probe } from "../../src/util/process/proc-table.ts";
import {
  killOwned,
  own,
  ownTree,
  registerGroup,
  signalOwned,
  until,
} from "../helpers/own-processes.ts";

const ROOT = join(import.meta.dir, "../..");
const SMOKE = join(ROOT, "scripts", "smoke-lifecycle.ts");
const CONTAINER = join(ROOT, "scripts", "smoke-lifecycle-container.sh");
/** A made-up value: never a real key. */
const SENTINEL = "SENTINEL-KEY-not-real-0xABCDEF";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-smoke-guards-")));
afterEach(() => {
  killOwned();
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function script(path: string, text: string): string {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** A folder holding `claude` that only records that it was called. */
function recorder(): { bin: string; log: string } {
  const bin = mkdtempSync(join(scratch, "recorder-"));
  const log = join(bin, "calls.log");
  script(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${log}"\nexit 0\n`);
  return { bin, log };
}

describe("N1: the smoke needs an explicit mode and refuses what it does not know", () => {
  for (const args of [
    [],
    ["--stand-in"],
    ["--free"],
    ["--live", "--standin"],
    ["--standin", "extra"],
  ]) {
    test(`\`${["smoke-lifecycle.ts", ...args].join(" ")}\` exits 64 with the usage, and no claude is run`, () => {
      const rec = recorder();
      const r = Bun.spawnSync([process.execPath, SMOKE, ...args], {
        env: { ...process.env, PATH: `${rec.bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      expect(r.exitCode).toBe(64);
      expect(r.stderr.toString()).toContain(
        "usage: bun run scripts/smoke-lifecycle.ts --live|--standin",
      );
      expect(existsSync(rec.log)).toBe(false);
    }, 35_000);
  }
});

/** A throwaway repository holding the container script and a baseline branch, a fake `docker`
 *  that records its argv (and, at build, how many files of the build folder hold the key), and the
 *  environment to run the script with. */
function containerRig(opts: { runSleep?: number } = {}) {
  const dir = realpathSync(mkdtempSync(join(scratch, "container-")));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(CONTAINER, join(repo, "scripts", "smoke-lifecycle-container.sh"));
  const git = (a: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      cwd: repo,
      timeout: 30_000,
    });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["branch", "baseline/pre-eng-485"]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "docker.log");
  // The fake reads the key only to count files that hold it; it writes the count, never the value.
  script(
    join(bin, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >>"${log}"
case "$1" in
build)
  ctx="\${@: -1}"
  n=$(grep -rlF -- "$ANTHROPIC_API_KEY" "$ctx" 2>/dev/null | wc -l | tr -d ' ')
  echo "build folder files holding the key: $n" >>"${log}"
  ;;
run)
  sleep ${opts.runSleep ?? 0}
  ;;
esac
exit 0
`,
  );
  // GitHub's macOS runners have no `timeout` (coreutils is not in their toolset), and the script
  // rightly refuses to run without one. The stand-in sets no time limit; like GNU timeout without
  // --foreground, it moves itself and the command into a group of their own, so a Ctrl-C to the
  // script's group reaches the script and not docker, and the script's own trap must stop the
  // container (what N2 checks). perl is part of both macOS and Ubuntu.
  script(
    join(bin, "timeout"),
    `#!/bin/sh
printf 'timeout %s\\n' "$*" >>"${log}"
while [ "$#" -gt 0 ]; do
  case "$1" in
  -s | -k) shift 2 ;;
  -*) shift ;;
  *) break ;;
  esac
done
shift
exec perl -e 'setpgrp(0, 0) or die "setpgrp: $!"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!"' "$@"
`,
  );
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: tmp,
    ANTHROPIC_API_KEY: SENTINEL,
  };
  return {
    dir,
    repo,
    log,
    tmp,
    env,
    scriptPath: join(repo, "scripts", "smoke-lifecycle-container.sh"),
  };
}

/** Every file under `dir` that holds `text`. */
function filesHolding(dir: string, text: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (readFileSync(p).includes(text)) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("the container script needs an explicit mode too", () => {
  for (const args of [[], ["--stand-in"], ["--live", "--standin"], ["live"]]) {
    test(`\`smoke-lifecycle-container.sh ${args.join(" ")}\` exits 64 and never calls docker`, () => {
      const rig = containerRig();
      const r = Bun.spawnSync(["bash", rig.scriptPath, ...args], {
        cwd: rig.repo,
        env: rig.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      expect(r.exitCode).toBe(64);
      expect(r.stderr.toString()).toContain("--live|--standin");
      expect(existsSync(rig.log)).toBe(false);
    });
  }
});

describe("N4: the container script never shows the key", () => {
  test("never `set -x` or xtrace in its text", () => {
    const text = readFileSync(CONTAINER, "utf8");
    expect(text).not.toMatch(/^\s*set\s+(?:-\w*x|.*-o\s+xtrace)/m);
    expect(text).not.toMatch(/\bxtrace\b|BASH_XTRACEFD/);
  });
  test("the key's name appears only in the set test and as the bare name after -e", () => {
    const uses = readFileSync(CONTAINER, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && l.includes("ANTHROPIC_API_KEY"))
      .map((l) => l.trim());
    expect(uses).toEqual([
      'if [ "$mode" = live ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then',
      'fail "ANTHROPIC_API_KEY is not set: the live run passes it to the container by name"',
      "args+=(-e ANTHROPIC_API_KEY)",
    ]);
  });
  test("a dry run with a fake docker and a sentinel key: not in its output, docker's argv, or any file it writes", () => {
    const rig = containerRig();
    const r = Bun.spawnSync(["bash", rig.scriptPath, "--live"], {
      cwd: rig.repo,
      env: rig.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(r.exitCode, output).toBe(0);
    expect(output).toContain("smoke-lifecycle-container: PASS (live)");
    expect(output).not.toContain(SENTINEL);
    const calls = readFileSync(rig.log, "utf8");
    expect(calls).not.toContain(SENTINEL);
    expect(calls).toMatch(
      /^run --rm --init --name \S+ --user 1000:1000 --ulimit core=0 -e ANTHROPIC_API_KEY \S+ timeout 900 bun run scripts\/smoke-lifecycle\.ts --live$/m,
    );
    expect(calls).toContain("build folder files holding the key: 0");
    // docker ran under the time bound (the rig's stand-in, so the test needs no coreutils).
    expect(calls).toMatch(/^timeout 960 docker run --rm /m);
    // Nothing it wrote is left, and nothing left holds the key.
    expect(filesHolding(rig.tmp, SENTINEL)).toEqual([]);
    expect(readdirSync(rig.tmp)).toEqual([]);
    expect(calls).toMatch(/^rmi -f styre-smoke-lifecycle:\S+$/m);
  }, 65_000);
});

describe("N2: Ctrl-C while the container runs stops it, and the script ends without PASS", () => {
  test("SIGINT to the script's process group: `docker stop`, then exit 130, within seconds", async () => {
    const rig = containerRig({ runSleep: 20 });
    // Its own session and group, which the test registers, as a terminal job would have.
    const proc = Bun.spawn(["bash", rig.scriptPath, "--live"], {
      cwd: rig.repo,
      env: rig.env,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const me = probe(proc.pid);
    const leader = me.kind === "alive" ? own(me.info)[0] : undefined;
    expect(leader !== undefined && registerGroup(leader)).toBe(true);
    let output = "";
    for (const stream of [proc.stdout, proc.stderr])
      void (async () => {
        const dec = new TextDecoder();
        for await (const c of stream) output += dec.decode(c, { stream: true });
      })();
    const running = await until(
      () => existsSync(rig.log) && /^run /m.test(readFileSync(rig.log, "utf8")),
      30_000,
    );
    expect(running, output).toBe(true);
    if (leader === undefined) return;
    ownTree(leader);
    // What a terminal does on Ctrl-C: SIGINT to every process of the foreground group.
    const group = listProcesses().filter((p) => p.pgid === leader.pid && p.state !== "zombie");
    const t0 = Date.now();
    for (const p of own(...group)) signalOwned(p, "SIGINT");
    const ended = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(8_000).then(() => false),
    ]);
    expect(ended, `still running ${Date.now() - t0} ms after Ctrl-C; it said:\n${output}`).toBe(
      true,
    );
    expect(proc.exitCode).toBe(130);
    expect(output).not.toContain("PASS");
    const calls = readFileSync(rig.log, "utf8");
    const name = /^run --rm --init --name (\S+)/m.exec(calls)?.[1];
    expect(calls).toContain(`stop -t 10 ${name}`);
    expect(calls).toContain(`rm -f ${name}`);
  }, 45_000);
});
