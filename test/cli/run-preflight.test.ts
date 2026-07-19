import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/cli/run.ts";

// Invoke the real `run` command with telemetry off and isolated XDG dirs. `state` is where a park
// dump WOULD land (parkDir uses XDG_STATE_HOME) — the test asserts nothing gets written there.
async function invokeRun(args: Record<string, unknown>, xdg: string, state: string): Promise<void> {
  const prev = {
    t: process.env.STYRE_TELEMETRY,
    c: process.env.XDG_CONFIG_HOME,
    s: process.env.XDG_STATE_HOME,
  };
  process.env.STYRE_TELEMETRY = "0";
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.XDG_STATE_HOME = state;
  process.exitCode = 0;
  try {
    await runCommand.run?.({ rawArgs: [], cmd: runCommand, args: { _: [], ...args } as never });
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.t === undefined) delete process.env.STYRE_TELEMETRY;
    else process.env.STYRE_TELEMETRY = prev.t;
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.c === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.c;
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev.s === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.s;
  }
}

// Write a profile.json whose must-have commands are resolved (assertResolved passes) but whose
// `build` invokes a program guaranteed absent on any machine.
function writeProfile(build: string): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-preflight-prof-"));
  const path = join(dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      slug: "preflight-test",
      targetRepo: dir,
      components: [
        {
          name: "api",
          kind: "custom",
          paths: ["**"],
          commands: { build, test: "sh -c true", check: { unavailable: true } },
        },
      ],
    }),
  );
  return path;
}

test("run: a missing toolchain program exits 69 before any dispatch, and writes no dump", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const state = mkdtempSync(join(tmpdir(), "styre-state-"));
  const profile = writeProfile("styre-definitely-absent-xyz build");
  // Resolves: the preflight prints + `return`s (it does not throw). Reaching exit 69 proves the
  // early return — dbPath/migrate/runTicket at run.ts:129+ were never reached.
  await invokeRun({ ticket: "ENG-1", profile }, xdg, state);
  expect(process.exitCode).toBe(69);
  // AC2: no SoT dump — parkDir would write under <XDG_STATE_HOME>/styre/…; nothing was created.
  expect(existsSync(join(state, "styre"))).toBe(false);
});

test("run --resume / --inspect are NOT gated by the toolchain preflight (ungated even with a missing tool)", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const state = mkdtempSync(join(tmpdir(), "styre-state-"));
  const profile = writeProfile("styre-definitely-absent-xyz build"); // the build tool is missing

  // AC7: --resume must enter resumeRun (which errors on the absent dump) BEFORE the preflight, so a
  // missing tool must NOT produce exit 69. If the preflight were ever placed ahead of the resume
  // early-return, this would exit 69 and never reach the "no parked run" error — so this pins the
  // placement, not just the current behavior.
  await expect(invokeRun({ resume: "ENG-1", profile }, xdg, state)).rejects.toThrow(
    /no parked run/,
  );
  expect(process.exitCode).not.toBe(69);

  // --inspect (a resume modifier) likewise bypasses the preflight — an inspect on a tool-less
  // machine must never be blocked by the toolchain check.
  await expect(invokeRun({ resume: "ENG-1", inspect: true, profile }, xdg, state)).rejects.toThrow(
    /no parked run/,
  );
  expect(process.exitCode).not.toBe(69);
});
