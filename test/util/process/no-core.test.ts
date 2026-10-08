// ENG-485 amendment 2026-10-08: before Styre re-raises SIGQUIT (Ctrl-\), it turns core dumps off for
// itself, so the exit by SIGQUIT (131, D13) writes no core. The real calls run in a child process:
// turning them off in the test process itself would change what the rest of the run can do.
import { expect, test } from "bun:test";
import { join } from "node:path";

const SIGNALS = join(import.meta.dir, "../../../src/util/process/signals.ts");

/** Runs the real `turnOffCoreDumps` in a child whose soft core limit was first raised to its hard
 *  limit, and returns the child's core state before and after. */
function inChild(): { hard: string; before: State; after: State } {
  const script = `
    import { coreDumpState, turnOffCoreDumps } from ${JSON.stringify(SIGNALS)};
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
