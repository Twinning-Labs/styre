import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `isPrimary` (src/dispatch/profile.ts) is the ONLY place allowed to decide whether a component
 * takes part in the run.
 *
 * WHY A GREP INVARIANT. `Component.role` is `optional()`, not `default("primary")` — a default
 * would make the field required on the inferred type and force a literal into ~14 files of
 * hand-built test fixtures, burying a behavioural change in mechanical churn. The price of
 * `optional()` is that absent-means-primary is a convention, and a convention that lives in
 * several places eventually disagrees with itself: `c.role === "primary"` silently excludes every
 * pre-ENG-425 component, and `c.role !== "primary"` silently includes them all.
 *
 * So the convention lives in exactly one function, and this test fails the build if a second
 * place starts deciding for itself. Same reasoning as `check-executor-invariant.test.ts`: the
 * defect this guards against is a MISSED call site, and no behavioural test of one call site can
 * catch a future second one.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("no module outside profile.ts compares .role against a role literal", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    if (file.endsWith("profile.ts")) continue; // defines isPrimary
    const text = readFileSync(file, "utf8");
    // `role === "primary"` / `role !== "fixture"` — any direct verdict on a role value.
    if (/\.role\s*[!=]==\s*["']/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("isPrimary is still exported and still the thing the role gate calls", () => {
  // Without this, both invariants above could pass vacuously after a rename.
  expect(readFileSync("src/dispatch/profile.ts", "utf8")).toContain("export function isPrimary");
  expect(readFileSync("src/cli/component-roles.ts", "utf8")).toContain("isPrimary(c)");
});

test("run.ts applies the role gate BEFORE the toolchain gate", () => {
  // ORDERING, not mere presence. A fixture component must not be probed for tooling: probing it
  // either passes (and provisions a decoy — the pytest-5631 bug) or fails (and reports a missing
  // toolchain for something the run was never going to touch). Deciding what a component IS
  // precedes asking whether this machine can run it.
  const text = readFileSync("src/cli/run.ts", "utf8");
  const roleAt = text.indexOf("applyRoleGate(profile)");
  const toolchainAt = text.indexOf("applyToolchainGate(profile)");
  expect(roleAt).toBeGreaterThan(-1);
  expect(toolchainAt).toBeGreaterThan(-1);
  expect(roleAt).toBeLessThan(toolchainAt);
});

test("the run reports the narrowing on stderr and threads it to the registry", () => {
  const text = readFileSync("src/cli/run.ts", "utf8");
  expect(text).toContain("formatNonPrimaryComponents(roles.nonPrimary)");
  expect(text).toContain("nonPrimaryComponents: roles.nonPrimary");
});
