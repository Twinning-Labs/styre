import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  advanceBranchHead,
  cleanupParkedRun,
  resumeParkedTicket,
  runFreshTicket,
  runNeedsYouTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";
import { makeTempDir } from "../helpers/temp.ts";

test("park/resume helpers return CLI exits without overwriting their caller's exit status", async () => {
  const original = process.exitCode ?? 0;
  let parked: Awaited<ReturnType<typeof runParkedTicket>> | undefined;
  let needsYou: Awaited<ReturnType<typeof runNeedsYouTicket>> | undefined;
  try {
    process.exitCode = 23;
    parked = await runParkedTicket();
    expect(parked.exitCode).toBe(75);
    expect(process.exitCode).toBe(23);
    needsYou = await runNeedsYouTicket();
    expect(needsYou.exitCode).toBe(75);
    expect(process.exitCode).toBe(23);
    const inspected = await resumeParkedTicket(parked, { inspect: true });
    expect(inspected.exitCode).toBe(0);
    expect(process.exitCode).toBe(23);
    advanceBranchHead(parked);
    const refused = await resumeParkedTicket(parked);
    expect(refused.exitCode).toBe(65);
    expect(process.exitCode).toBe(23);
  } finally {
    process.exitCode = original;
    if (parked) cleanupParkedRun(parked);
    if (needsYou) cleanupParkedRun(needsYou);
  }
});

test("a fresh process exits successfully after capturing a simulated CLI failure", () => {
  const helper = new URL("../helpers/run-harness.ts", import.meta.url).href;
  const temp = new URL("../helpers/temp.ts", import.meta.url).href;
  const script = `
    import { runParkedTicket, cleanupParkedRun } from ${JSON.stringify(helper)};
    import { removeTempDirsOnExit } from ${JSON.stringify(temp)};
    removeTempDirsOnExit();
    const parked = await runParkedTicket();
    try {
      if (parked.exitCode !== 75) throw new Error("lost observed CLI exit");
    } finally {
      cleanupParkedRun(parked);
    }
  `;
  // A bare `bun -e` has no test preload, so the script removes its folders on exit, and its TMPDIR
  // is a folder this test owns in case it dies first. (Bun.spawn without `env` would pass the
  // TMPDIR this process started with, not the preload's per-run root.)
  const childTmp = makeTempDir("styre-child-tmp-");
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TMPDIR: childTmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(readdirSync(childTmp)).toEqual([]);
});

test("fresh-run helper preserves caller status on success and a thrown refusal", async () => {
  const original = process.exitCode ?? 0;
  let fresh: Awaited<ReturnType<typeof runFreshTicket>> | undefined;
  try {
    process.exitCode = 23;
    fresh = await runFreshTicket();
    expect(process.exitCode).toBe(23);
    await expect(runFreshTicket({ reuseStateOf: fresh })).rejects.toThrow(
      /checkpoint already exists|--fresh/i,
    );
    expect(process.exitCode).toBe(23);
  } finally {
    process.exitCode = original;
    fresh?.cleanup();
  }
});
