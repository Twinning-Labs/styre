import { expect, test } from "bun:test";
import { renderVerifyReport } from "../../src/dispatch/verify-report.ts";
import type { VerifyReport } from "../../src/dispatch/verify-report.ts";

const base: VerifyReport = { criteria: [], advisory: [], provenance: [], allClean: true };

test("empty report renders nothing", () => {
  expect(renderVerifyReport(base)).toBe("");
});

test("clean run: criteria list, no advisory/provenance sections", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: "returns 201", label: "verified" }],
    allClean: true,
  });
  expect(out).toContain("### Change-scoped verify");
  expect(out).toContain("✅ AC-1 — returns 201");
  expect(out).toContain(
    "Confirmed by an automated test that failed before this change and passes now.",
  );
  expect(out).not.toContain("Please review before merging");
  expect(out).not.toContain("How the automated checks changed");
});

test("each label renders its symbol + explanation", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [
      { seq: 1, text: "a", label: "satisfied" },
      { seq: 2, text: "b", label: "not-expressible" },
      { seq: 3, text: "c", label: "environmental" },
      { seq: 4, text: "d", label: "check-unreplaced" },
      { seq: 5, text: "e", label: "still-red" },
      { seq: 6, text: "f", label: "no-check" },
    ],
    allClean: false,
  });
  expect(out).toContain("✅ AC-1 — a");
  expect(out).toContain("Already working before this change");
  expect(out).toContain("⚪ AC-2 — b");
  expect(out).toContain("left to human code review");
  expect(out).toContain("⚪ AC-3 — c");
  expect(out).toContain('an "environmental" check');
  expect(out).toContain("⚠️ AC-4 — d");
  expect(out).toContain("judged to not actually match");
  expect(out).toContain("⚠️ AC-5 — e");
  expect(out).toContain("➖ AC-6 — f");
  expect(out).toContain("No automated check was created");
});

test("advisory section: suite/integration/env-red with the 'not a merge gate' wording", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: "x", label: "still-red" }],
    advisory: [
      { kind: "integration", result: "fail", firstFailingJob: "backend:test" },
      { kind: "suite", checkType: "backend", result: "error" },
      { kind: "environmental-red", seq: 1 },
    ],
    allClean: false,
  });
  expect(out).toContain("Please review before merging — these did NOT block the merge");
  expect(out).toContain("full integration test run FAILED (first failing job: `backend:test`)");
  expect(out).toContain("`backend` test suite did not pass (result: error)");
  expect(out).toContain("This was not used as a merge gate.");
  expect(out).toContain("automated check for AC-1 is still failing");
});

test("provenance section only for installed/rejected", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [
      { seq: 1, text: "x", label: "verified" },
      { seq: 2, text: "y", label: "check-unreplaced" },
    ],
    provenance: [
      { seq: 1, disposition: "installed", reason: "asserted stale field" },
      { seq: 2, disposition: "rejected", reason: "no correct check possible" },
    ],
    allClean: false,
  });
  expect(out).toContain("How the automated checks changed during verification");
  expect(out).toContain("check for AC-1 was rewritten mid-verification");
  expect(out).toContain("asserted stale field");
  expect(out).toContain("check for AC-2 was judged wrong and could not be replaced");
  expect(out).toContain("no correct check possible");
});

test("AC text is escaped and truncated (M3)", () => {
  const nasty = `\`code\` <details>bad</details> ${"x".repeat(200)}`;
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: nasty, label: "verified" }],
    allClean: true,
  });
  expect(out).not.toContain("<details>");
  expect(out).not.toContain("`code`");
  expect(out).toContain("&lt;details");
  // truncated to <= 120 chars of AC text (plus ellipsis)
  const acLine = out.split("\n").find((l) => l.includes("✅ AC-1")) ?? "";
  expect(acLine.length).toBeGreaterThan(0);
  expect(acLine.length).toBeLessThan(160);
});
