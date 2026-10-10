import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `styre run` must USE the profile `applyToolchainGate` hands back, not merely call the gate.
 *
 * WHY THIS EXISTS. The gate's whole effect is a RETURN VALUE: it narrows the profile to the
 * components this machine can use. Dropping the assignment leaves the gate looking correct —
 * it still refuses a fully-broken host, its own tests still pass — while the run proceeds with
 * the component it just declared unusable, and dies in `provision` on the very `npm install`
 * the gate existed to route around (ENG-412). That is a MISSED line, not a wrong one, so no
 * behavioural test of the gate can catch it; a source invariant can.
 */
test("run.ts assigns applyToolchainGate's narrowed profile back to `profile`", () => {
  const src = readFileSync("src/cli/run.ts", "utf8");

  expect(src.includes("applyToolchainGate(")).toBe(true);
  // The narrowed profile must be adopted, or the narrowing is decorative. Asserted on a boolean
  // rather than the source: a `toMatch` failure here prints the whole of run.ts.
  expect(/profile\s*=\s*toolchain\.profile\s*;/.test(src)).toBe(true);
});

test("run and resume report what they skipped — the narrowing is never silent", () => {
  const run = readFileSync("src/cli/run.ts", "utf8");
  const park = readFileSync("src/cli/park.ts", "utf8");

  // Said to the operator at run time, the same notice on a fresh run and on a resume...
  expect(run.includes("toolchainNotice(")).toBe(true);
  expect(park.includes("toolchainNotice(")).toBe(true);
  // ...and carried into the run so it can reach the PR (handlers.ts turns this into a signal).
  expect(run.includes("unusableComponents:")).toBe(true);
  expect(park.includes("unusableComponents: toolchain.unusable")).toBe(true);
});

test("the toolchain signal uses a result the schema actually allows", () => {
  // ground_truth_signal.result is CHECK (result IN ('pass','fail','error')). An invented fourth
  // value throws at INSERT, inside a handler, where it surfaces only as an escalated step.
  // Its one writer, `recordUnusableComponents`, used by provision and by resume.
  const provision = readFileSync("src/dispatch/provision.ts", "utf8");
  const at = provision.indexOf('signalType: "toolchain"');
  expect(at).toBeGreaterThan(-1);
  const block = provision.slice(at);
  const result = block.match(/result:\s*"(\w+)"/)?.[1] ?? "(none)";

  expect(["pass", "fail", "error"]).toContain(result);
  // And specifically `error`: the component was never measured, so `fail` would over-claim.
  expect(result).toBe("error");
});
