// ENG-485 section 6.3 / D8: a graceful stop sends SIGTERM to the agent's whole tree, waits the grace
// period, and only then sends SIGKILL. The stop clock is virtual (the 5 seconds cost no real time);
// signals and the process table are real. The test first waits for the process to be READY (its
// SIGTERM trap installed), and waits for "gone" with a bounded poll, never a fixed sleep, so neither
// start up speed nor reaping lag on a loaded machine can change the outcome.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import { installVirtualGrace } from "../helpers/graceful-stop.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "styre-escalation-"));
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
  Bun.spawnSync(["pkill", "-9", "-f", "sleep 309"]);
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}
const sleeping = (): boolean => Bun.spawnSync(["pgrep", "-f", "sleep 309"]).exitCode === 0;

test("a graceful stop of an agent that ignores SIGTERM sends SIGKILL only after the 5 second grace, and ends the tree", async () => {
  const ready = join(dir, "ready");
  // `trap '' TERM` is inherited by `sleep`: neither process yields to SIGTERM.
  const h = door.launch({
    argv: ["sh", "-c", `trap '' TERM; touch '${ready}'; sleep 309`],
    cwd: dir,
    env: process.env,
    kind: "agent",
    context: { ident: null, stepId: null, worktree: dir },
  });
  expect(await waitFor(() => existsSync(ready), 10_000), "the process never became ready").toBe(
    true,
  );
  expect(await waitFor(sleeping, 3_000)).toBe(true); // the child is in the table too

  const rec = installVirtualGrace();
  await h.stop("graceful");

  expect(rec.sent[0]?.sig).toBe("SIGTERM");
  const firstKill = rec.sent.find((s) => s.sig === "SIGKILL");
  expect(firstKill, "no SIGKILL was ever sent").toBeDefined();
  // 5 s is the grace of ENG-485 D8, written out here so a changed constant is noticed.
  expect((firstKill?.at ?? 0) - (rec.sent[0]?.at ?? 0)).toBeGreaterThanOrEqual(5_000);
  // No SIGKILL before that point: every signal sent before it is SIGTERM.
  expect(
    rec.sent.filter((s) => s.at < (firstKill?.at ?? 0)).every((s) => s.sig === "SIGTERM"),
  ).toBe(true);
  // The process and its sleep are gone: bounded poll for the (real) reaping, not a fixed sleep.
  expect(await waitFor(() => !sleeping(), 3_000), "the tree was still running after SIGKILL").toBe(
    true,
  );
  // proc.exited settles once the child is reaped; bounded by a race, not waited for unconditionally.
  expect(
    await Promise.race([h.proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)]),
  ).toBe(true);
  // Release the record with the real clock.
  door.__setStopDepsForTests(undefined);
  await h.finish();
});

test("a graceful stop of an agent that yields to SIGTERM never sends SIGKILL", async () => {
  const ready = join(dir, "ready2");
  const h = door.launch({
    argv: ["sh", "-c", `touch '${ready}'; exec sleep 309`],
    cwd: dir,
    env: process.env,
    kind: "agent",
    context: { ident: null, stepId: null, worktree: dir },
  });
  expect(await waitFor(() => existsSync(ready), 10_000)).toBe(true);
  expect(await waitFor(sleeping, 3_000)).toBe(true);
  const rec = installVirtualGrace();
  await h.stop("graceful");
  expect(rec.sent.length).toBeGreaterThan(0);
  expect(rec.sent.every((s) => s.sig === "SIGTERM")).toBe(true);
  expect(await waitFor(() => !sleeping(), 3_000)).toBe(true);
  door.__setStopDepsForTests(undefined);
  await h.finish();
});
