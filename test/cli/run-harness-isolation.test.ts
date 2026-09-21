import { expect, test } from "bun:test";
import {
  advanceBranchHead,
  cleanupParkedRun,
  resumeParkedTicket,
  runFreshTicket,
  runNeedsYouTicket,
  runParkedTicket,
} from "../helpers/run-harness.ts";

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
  const script = `
    import { runParkedTicket, cleanupParkedRun } from ${JSON.stringify(helper)};
    const parked = await runParkedTicket();
    try {
      if (parked.exitCode !== 75) throw new Error("lost observed CLI exit");
    } finally {
      cleanupParkedRun(parked);
    }
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
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
