import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/cli/run.ts";
import { assertInPlaceSafe } from "../../src/dispatch/in-place.ts";

// This suite exercises the REAL `run.ts` entrypoint (`runCommand.run`) directly — not a
// reimplementation of its preflight block — proving the actual production code path overrides
// `profile.targetRepo` with the cwd-discovered repo root BEFORE the gate/ticket-required check,
// and that discovery failure aborts (fail-closed) rather than falling through to the stale value.
//
// `profile.targetRepo` itself is a function-local inside `run()` and can't be read back directly,
// so both tests observe the override indirectly through `assertInPlaceSafe`'s marker gate: the
// "cwd repo" (what discovery should return) and the "stale profile repo" (what the JSON profile
// says) are given DIFFERING marker states, so which one the gate actually inspects is externally
// visible via which error (if any) comes back.

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function run(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

/** A real git repo on a named branch, clean tracked tree, optionally carrying the
 *  `.styre-disposable` marker file that `assertInPlaceSafe` requires. */
function makeRepo(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-run-inplace-disc-"));
  roots.push(dir);
  run(["init", "-q", "-b", "main"], dir);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], dir);
  if (withMarker) writeFileSync(join(dir, ".styre-disposable"), "");
  return dir;
}

function writeProfile(targetRepo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-run-inplace-disc-profile-"));
  roots.push(dir);
  const path = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify({ slug: "inplace-discovery-test", targetRepo }));
  return path;
}

// Invoke the real CLI run() function directly (bypassing citty's argv parsing — we construct the
// parsed-args shape ourselves), gated only enough to reach (and stop at) the `--ticket is
// required` throw, which sits immediately AFTER the `--in-place` preflight block in run.ts.
async function invokeRun(profilePath: string): Promise<void> {
  const prevTelemetry = process.env.STYRE_TELEMETRY;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.STYRE_TELEMETRY = "0"; // NOOP analytics — no network/file I/O from createAnalytics
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "styre-xdg-empty-")); // no convention files
  try {
    await runCommand.run?.({
      rawArgs: [],
      cmd: runCommand,
      args: {
        _: [],
        profile: profilePath,
        "in-place": true,
      } as unknown as Parameters<NonNullable<typeof runCommand.run>>[0]["args"],
    });
  } finally {
    if (prevTelemetry === undefined) process.env.STYRE_TELEMETRY = undefined;
    else process.env.STYRE_TELEMETRY = prevTelemetry;
    // Restore XDG with delete, NOT `= undefined`: the string "undefined" has length>0, so
    // configDir() would compute "undefined/styre" and leak it to later tests in the same process.
    if (prevXdg === undefined)
      // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
}

test("run --in-place: overrides profile.targetRepo with the cwd-discovered repo root, not the stale profile value", async () => {
  const cwdRepo = makeRepo(true); // has the marker — this is what discovery SHOULD return
  const staleProfileRepo = makeRepo(false); // no marker — proves the stale value was NOT used
  const profilePath = writeProfile(staleProfileRepo);

  // Sanity/falsifiability: if the gate were ever run against staleProfileRepo directly, it throws.
  expect(() => assertInPlaceSafe(staleProfileRepo)).toThrow(/marker/);

  const prevCwd = process.cwd();
  process.chdir(cwdRepo);
  try {
    // If the override works: discoverRepoRoot() returns cwdRepo (marker present) → gate passes →
    // execution reaches the `--ticket is required` throw. If it doesn't (stale value used
    // instead): assertInPlaceSafe throws /marker/ (staleProfileRepo has none) — a DIFFERENT error.
    await expect(invokeRun(profilePath)).rejects.toThrow(/--ticket is required/);
  } finally {
    process.chdir(prevCwd);
  }
});

test("run --in-place: warns on stderr when the discovered repo root differs from the profile's targetRepo", async () => {
  const cwdRepo = makeRepo(true); // has the marker — this is what discovery SHOULD return
  const staleProfileRepo = makeRepo(true); // also has the marker, so the gate passes either way —
  // isolates the assertion to the warning itself, not a side effect of the gate rejecting the stale
  // value. Note both dirs are real git-toplevels, so `git rev-parse --show-toplevel` on cwdRepo
  // (not a raw mkdtemp path — macOS /private/var realpath caution) will never equal staleProfileRepo.
  const profilePath = writeProfile(staleProfileRepo);

  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

  const prevCwd = process.cwd();
  process.chdir(cwdRepo);
  try {
    await expect(invokeRun(profilePath)).rejects.toThrow(/--ticket is required/);

    const discoveredRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: cwdRepo })
      .stdout.toString()
      .trim();
    const warning = errors.find((e) => e.startsWith("IN-PLACE: discovered repo root"));
    expect(warning).toBeDefined();
    expect(warning).toContain(discoveredRoot);
    expect(warning).toContain(staleProfileRepo);
    expect(warning).toContain("differs from the profile's targetRepo");
  } finally {
    process.chdir(prevCwd);
    console.error = origError;
  }
});

test("run --in-place: fails closed when cwd is not a git repo — never falls through to the stale profile.targetRepo", async () => {
  const nonRepoDir = mkdtempSync(join(tmpdir(), "styre-run-inplace-disc-nonrepo-"));
  roots.push(nonRepoDir);
  // A valid, marker-bearing repo as the stale profile value: if the fail-closed throw were ever
  // swallowed (e.g. wrapped in try/catch) and execution fell through to the OLD stale-path
  // behavior, this repo would pass the gate silently and the run would proceed to the (distinct)
  // "--ticket is required" throw instead of "no git repo" — so this test would catch that.
  const staleProfileRepo = makeRepo(true);
  const profilePath = writeProfile(staleProfileRepo);

  const prevCwd = process.cwd();
  process.chdir(nonRepoDir);
  try {
    await expect(invokeRun(profilePath)).rejects.toThrow(/no git repo/);
  } finally {
    process.chdir(prevCwd);
  }
});
