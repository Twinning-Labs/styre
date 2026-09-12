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

/**
 * ENG-435: there is no ordering left to pin, so this pins the thing that replaced it.
 *
 * The previous guards asserted the role gate preceded a LIST of named consumers. An independent
 * review broke that in two lines: inserting a new consumer above the gate passed, and
 * re-introducing the original bug as `assertResolved({ ...profile })` — one character of
 * spelling difference — passed too. A guard that enumerates call sites cannot see the call site
 * nobody thought to enumerate, which is the same shape as the defect it was written to prevent.
 *
 * `run.ts` now obtains its profile ONLY through `loadRunProfile`, which narrows as part of
 * loading. An un-narrowed profile is never bound to a name, so a new consumer cannot be on the
 * wrong side of anything. This invariant cannot pass vacuously the way an ordering list could:
 * it fails on the presence of a raw loader, not on the absence of a string somebody remembered
 * to add.
 */
test("run.ts never loads a profile except through the narrowing loader", () => {
  const text = readFileSync("src/cli/run.ts", "utf8");
  const rawLoaders = ["loadProfile(", "loadProfileByConvention("];
  const found = rawLoaders.filter((l) => text.includes(l));
  expect(found).toEqual([]);
  expect(text).toContain("loadRunProfile(");
});

test("the narrowing loader is the only place that partitions by role for a run", () => {
  // If a second caller starts narrowing on its own, the "one property of loading" claim is gone
  // and the ordering problem comes back by another door.
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    if (file.endsWith("component-roles.ts") || file.endsWith("load-profile.ts")) continue;
    if (/partitionByRole\s*\(/.test(readFileSync(file, "utf8"))) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("the resume path is handed what the narrowing removed", () => {
  // ENG-425's NEVER SILENT contract. The resume path was the one ENG-425 missed entirely; a
  // narrowing it cannot report is the silence that contract forbids.
  const text = readFileSync("src/cli/run.ts", "utf8");
  const resumeAt = text.indexOf("resumeRun(");
  expect(resumeAt).toBeGreaterThan(-1);
  expect(text.slice(resumeAt, resumeAt + 400)).toContain("loaded.nonPrimary");
});
