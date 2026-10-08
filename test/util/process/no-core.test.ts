// ENG-485 amendment 2026-10-08: before Styre re-raises SIGQUIT (Ctrl-\), it turns core dumps off for
// itself, so the exit by SIGQUIT (131, D13) writes no core. The real calls run in a child process:
// turning them off in the test process itself would change what the rest of the run can do.
import { expect, test } from "bun:test";
import { join } from "node:path";

const PROC_TABLE = join(import.meta.dir, "../../../src/util/process/proc-table.ts");

/** Runs the real `turnOffCoreDumps` in a child whose soft core limit was first raised to its hard
 *  limit, and returns the child's core state before and after. */
function inChild(): { hard: string; before: State; after: State } {
  const script = `
    import { coreDumpState, turnOffCoreDumps } from ${JSON.stringify(PROC_TABLE)};
    const before = coreDumpState();
    turnOffCoreDumps();
    console.log(JSON.stringify({ before, after: coreDumpState() }));
  `;
  const r = Bun.spawnSync(
    [
      "sh",
      "-c",
      'ulimit -c "$(ulimit -H -c)"; ulimit -H -c >&2; exec "$@"',
      "sh",
      process.execPath,
      "-e",
      script,
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  if (r.exitCode !== 0) throw new Error(`the child failed: ${r.stderr.toString()}`);
  return { hard: r.stderr.toString().trim(), ...JSON.parse(r.stdout.toString()) };
}
interface State {
  /** The soft core limit, as a decimal string (RLIM_INFINITY too). */
  limit: string;
  /** Linux: PR_GET_DUMPABLE; null elsewhere. */
  dumpable: number | null;
}

test("turnOffCoreDumps leaves the process with a core limit of 0 and, on Linux, not dumpable", () => {
  const { hard, before, after } = inChild();
  // The child really could dump before the call, whenever its hard limit allows it at all.
  if (hard !== "0") expect(before.limit).not.toBe("0");
  if (process.platform === "linux") expect(before.dumpable).toBe(1);
  expect(after.limit).toBe("0");
  expect(after.dumpable).toBe(process.platform === "linux" ? 0 : null);
});

// ---- setup's prompt (amendment 2026-10-08, addition): the soft limit only, then restored -----------

/** Runs `body` in a child (with saveCoreDumps, which only reads, turnOffCoreDumps,
 *  turnOffCoreDumpsForPrompt and restoreCoreDumps in scope) after `limits` set its core limits, and returns what the body printed. Every number is a
 *  decimal string, so JSON carries it whole. */
function child(limits: string, body: string): Record<string, unknown> {
  const script = `
    import { restoreCoreDumps, saveCoreDumps, turnOffCoreDumps, turnOffCoreDumpsForPrompt } from ${JSON.stringify(PROC_TABLE)};
    const show = (s) => ({ soft: String(s.soft), hard: String(s.hard), dumpable: s.dumpable });
    const out = {};
    ${body}
    console.log(JSON.stringify(out));
  `;
  const r = Bun.spawnSync(
    ["sh", "-c", `${limits}; exec "$@"`, "sh", process.execPath, "-e", script],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  if (r.exitCode !== 0) throw new Error(`the child failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

/** The soft core limit alone set to a value above 0 and below the hard limit, so the restore must
 *  bring back an exact soft value, distinct from the hard one. */
const SOME_LIMIT = "ulimit -S -c 4096";
/** Said when the hard core limit is 0: these tests cannot run, and they fail rather than pass
 *  without checking anything. */
const NO_HARD =
  "the hard core limit is 0: either this machine sets it so, or something earlier in this test run lowered the test process's hard limit (the bug these tests guard against)";

test("for a prompt only the soft limit is lowered, and the restore brings back the exact soft limit and, on Linux, the dumpable flag", () => {
  const out = child(
    SOME_LIMIT,
    `
    out.before = show(saveCoreDumps());
    const saved = saveCoreDumps();
    turnOffCoreDumpsForPrompt();
    out.during = show(saveCoreDumps());
    restoreCoreDumps(saved);
    out.after = show(saveCoreDumps());
  `,
  ) as Record<string, { soft: string; hard: string; dumpable: number | null }>;
  const { before, during, after } = out as Required<typeof out>;
  expect(before?.hard, NO_HARD).not.toBe("0");
  // The child really started with a soft limit of its own, above 0 and below its hard limit.
  expect(before?.soft).not.toBe("0");
  expect(before?.soft).not.toBe(before?.hard);
  expect(during?.soft).toBe("0");
  expect(during?.hard).toBe(before?.hard); // never lowered
  expect(during?.dumpable).toBe(process.platform === "linux" ? 0 : null);
  expect(after).toEqual(before);
  if (process.platform === "linux") expect(before?.dumpable).toBe(1);
});

test("a restore after the hard limit was lowered fails loudly: the old limits cannot come back", () => {
  const out = child(
    'ulimit -c "$(ulimit -H -c)"',
    `
    out.hard = String(saveCoreDumps().hard);
    const saved = saveCoreDumps();
    turnOffCoreDumps(); // the SIGQUIT form: soft and hard to 0
    try {
      restoreCoreDumps(saved);
      out.restored = true;
    } catch (err) {
      out.error = String(err);
    }
  `,
  );
  expect(out.hard, NO_HARD).not.toBe("0");
  expect(out.restored).toBeUndefined();
  expect(String(out.error)).toContain("setrlimit");
});
