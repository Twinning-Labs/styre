import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SetupArgs, setupImpl } from "../../src/cli/setup.ts";

// This suite exercises the REAL `setup.ts` entrypoint (`setupImpl`, the unwrapped body behind
// `setupCommand.run`'s `guard` wrapper) directly — not a reimplementation of its preflight block —
// proving the actual production code path: when the
// `repo` positional is omitted, it discovers the cwd git repo and gates it on the
// `.styre-disposable` marker BEFORE runSetup's write-capable enrichment agent ever runs.
//
// Neither scenario is allowed to reach the real agent call (that would spawn a live `claude`
// process). So each test unsets ANTHROPIC_API_KEY, which the wrapper checks immediately AFTER the
// discovery+gate block and immediately BEFORE constructing the agent runner / calling `runSetup`.
// That makes the two failure modes mutually exclusive and individually diagnostic:
//   - the marker error  → the gate ran and rejected BEFORE reaching the agent-key check (and thus
//     before any enrichment call — enrichRuntimeContext/discoverComponents live inside runSetup,
//     which is never reached).
//   - the ANTHROPIC_API_KEY error → the gate ran and PASSED, discovery resolved the cwd repo, and
//     execution reached the last guard immediately ahead of the agent call — proving the gate is
//     not what stopped it.
// Getting the "wrong" error in either direction would mean the gate ran at the wrong point (or not
// at all), so which error comes back is the falsifiable signal — mirroring the technique used in
// test/cli/run-inplace-discovery.test.ts for the analogous `run --in-place` preflight.

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    // best-effort cleanup; failures here must not fail the suite
    try {
      Bun.spawnSync(["rm", "-rf", r]);
    } catch {
      /* ignore */
    }
  }
});

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

/** A real git repo on a named branch, clean tracked tree, optionally carrying the
 *  `.styre-disposable` marker (a regular file) that `assertInPlaceMarker` requires. */
function makeRepo(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-setup-inplace-disc-"));
  roots.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"], dir);
  if (withMarker) writeFileSync(join(dir, ".styre-disposable"), "");
  return dir;
}

/** Invoke the real CLI setup() function directly (bypassing citty's argv parsing — we construct
 *  the parsed-args shape ourselves), with ANTHROPIC_API_KEY forced unset so execution can never
 *  reach the real (live) agent call. */
async function invokeSetup(repo?: string): Promise<void> {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  // biome-ignore lint/performance/noDelete: env var must be truly unset, not the string "undefined"
  delete process.env.ANTHROPIC_API_KEY;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "styre-setup-xdg-empty-")); // no host config
  try {
    await setupImpl({ args: { repo } as SetupArgs });
  } finally {
    if (prevKey === undefined)
      // biome-ignore lint/performance/noDelete: restoring an unset env var requires delete
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevXdg === undefined)
      // biome-ignore lint/performance/noDelete: restoring an unset env var requires delete
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
}

test("setup with no repo arg: without a marker, throws the disposability gate BEFORE any enrichment call and writes nothing", async () => {
  const cwdRepo = makeRepo(false); // no marker
  const cfg = mkdtempSync(join(tmpdir(), "styre-setup-inplace-disc-xdg-"));
  roots.push(cfg);
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;

  const prevCwd = process.cwd();
  process.chdir(cwdRepo);
  try {
    await expect(invokeSetup(undefined)).rejects.toThrow(/disposable/);
    // Falsifiable "enrichment did not run" signal: runSetup is the only thing that would write
    // under configDir() (its mkdirSync + writeFileSync happen at the very end of a successful
    // probe+enrich+discover pipeline). Since the gate threw first, nothing was ever written.
    expect(existsSync(join(cfg, "styre"))).toBe(false);
  } finally {
    process.chdir(prevCwd);
    if (prevXdg === undefined)
      // biome-ignore lint/performance/noDelete: process.env must be unset via delete
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("setup with no repo arg: with a marker, discovers the cwd root and passes the gate (fails later, on the agent-key guard — not on the marker)", async () => {
  const cwdRepo = makeRepo(true); // has the marker
  const prevCwd = process.cwd();
  process.chdir(cwdRepo);
  try {
    await expect(invokeSetup(undefined)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  } finally {
    process.chdir(prevCwd);
  }
});

test("explicit `setup <repo>` is unchanged: no marker required, discovery/gate never runs even without one", async () => {
  const explicitRepo = makeRepo(false); // deliberately no marker
  const elsewhere = mkdtempSync(join(tmpdir(), "styre-setup-inplace-disc-elsewhere-"));
  roots.push(elsewhere);
  const prevCwd = process.cwd();
  process.chdir(elsewhere); // prove the explicit path doesn't even look at cwd
  try {
    // If the gate incorrectly ran against the explicit repo (no marker), we'd see /disposable/
    // instead. Reaching the agent-key guard proves the explicit-repo path skipped it entirely.
    await expect(invokeSetup(explicitRepo)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  } finally {
    process.chdir(prevCwd);
  }
});
