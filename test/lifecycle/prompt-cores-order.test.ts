// Amendment 2026-10-08, setup's prompts (final review A F5): around a prompt, core dumps are turned
// off BEFORE the stop handlers are removed, and the handlers are put back BEFORE core dumps are
// restored. Otherwise a Ctrl-\ in either gap takes SIGQUIT's default action with core dumps on: a
// Bun core of gigabytes. The core calls here are stand-ins; the real ones would change this test
// process's own limits.
import { afterEach, expect, test } from "bun:test";
import type { CoreDumpState } from "../../src/util/process/proc-table.ts";
import {
  type PromptCores,
  __resetSignalsForTests,
  installStopHandlers,
  suspendStopHandlers,
} from "../../src/util/process/signals.ts";

afterEach(() => __resetSignalsForTests());

const SIGS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
const counts = () => SIGS.map((s) => process.listenerCount(s));

test("core dumps go off while the handlers are still installed, and come back only after the handlers are back", async () => {
  const before = counts();
  const installed = before.map((n) => n + 1);
  const h = installStopHandlers(
    { command: "setup", run: null },
    // A stray signal during the test must not end the test run.
    { reraise: () => {}, exit: () => {}, stderr: () => {} },
  );
  const seen: Record<string, number[]> = {};
  const saved: CoreDumpState = { soft: 7n, hard: 9n, dumpable: 1 };
  const cores: PromptCores = {
    save: () => {
      seen.save = counts();
      return saved;
    },
    off: () => {
      seen.off = counts();
    },
    restore: () => {
      seen.restore = counts();
    },
    say: () => {},
  };
  try {
    const during = await suspendStopHandlers(() => counts(), cores);
    expect(during).toEqual(before);
    expect(seen.save).toEqual(installed);
    expect(seen.off).toEqual(installed);
    expect(seen.restore).toEqual(installed);
    expect(counts()).toEqual(installed);
  } finally {
    h.dispose();
  }
});

test("the order holds when the prompt throws", async () => {
  const before = counts();
  const installed = before.map((n) => n + 1);
  const h = installStopHandlers(
    { command: "setup", run: null },
    { reraise: () => {}, exit: () => {}, stderr: () => {} },
  );
  let atRestore: number[] = [];
  const cores: PromptCores = {
    save: () => ({ soft: 7n, hard: 9n, dumpable: 1 }),
    off: () => {},
    restore: () => {
      atRestore = counts();
    },
    say: () => {},
  };
  try {
    await expect(
      suspendStopHandlers(() => {
        throw new Error("EOF");
      }, cores),
    ).rejects.toThrow("EOF");
    expect(atRestore).toEqual(installed);
  } finally {
    h.dispose();
  }
});
