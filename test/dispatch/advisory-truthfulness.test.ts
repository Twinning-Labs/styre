import { describe, expect, test } from "bun:test";
import { type AdvisoryLine, renderVerifyReport } from "../../src/dispatch/verify-report.ts";

function report(advisory: AdvisoryLine[]) {
  return renderVerifyReport({
    criteria: [{ seq: 1, text: "The reported bug no longer reproduces", label: "verified" }],
    advisory,
    binding: [],
    provenance: [],
    allClean: false,
  });
}

describe("ENG-402: behavioral-no-test must not be reported as a suite failure", () => {
  test("does not claim the test suite failed", () => {
    // handlers.ts overwrites a PASSING suite result to `fail` when a behavioral unit shipped no
    // test. Rendering that as "the test suite did not pass" puts a false statement about the
    // repo's own tests in front of the person deciding whether to merge.
    const out = report([
      {
        kind: "behavioral-no-test",
        checkType: "test",
        component: "frontend",
        changed: ["src/generators/utils/parse.ts"],
      },
    ]);
    expect(out).not.toContain("test suite did not pass");
    expect(out).toContain("without a test of its own");
    expect(out).toContain("suite itself passed");
  });

  test("names the component and the changed files", () => {
    const out = report([
      {
        kind: "behavioral-no-test",
        checkType: "test",
        component: "frontend",
        changed: ["src/generators/utils/parse.ts"],
      },
    ]);
    expect(out).toContain("frontend");
    expect(out).toContain("src/generators/utils/parse.ts");
  });

  test("a GENUINE suite failure still renders the did-not-pass wording, distinctly", () => {
    const out = report([{ kind: "suite", checkType: "test", result: "fail" }]);
    expect(out).toContain("test suite did not pass");
    expect(out).not.toContain("without a test of its own");
  });
});

describe("ENG-403: an advisory failure must say whether this change caused it", () => {
  test("pre-existing is stated explicitly and exonerates the change", () => {
    // darkreader__darkreader-7241: `npm run build` failed identically on the pristine base image
    // (an upstream tslib/rollup-plugin-typescript2 incompatibility). The PR reported the failure
    // and never said it pre-dated the change.
    const out = report([
      { kind: "integration", result: "fail", firstFailingJob: "frontend:build", preexisting: true },
    ]);
    expect(out).toContain("base commit");
    expect(out).toContain("did not cause it");
    expect(out).toContain("frontend:build");
  });

  test("introduced is called out as this change's doing", () => {
    const out = report([
      {
        kind: "integration",
        result: "fail",
        firstFailingJob: "frontend:build",
        preexisting: false,
      },
    ]);
    expect(out).toContain("PASSED at the base commit");
    expect(out).toContain("introduced");
  });

  test("unknown says so rather than implying either answer", () => {
    // Fail-closed on wording: silently reading as pre-existing would excuse a real regression.
    const out = report([
      { kind: "integration", result: "fail", firstFailingJob: "frontend:build" },
    ]);
    expect(out).toContain("could not be established");
    expect(out).not.toContain("did not cause it");
    expect(out).not.toContain("introduced");
  });
});

describe("ENG-402: a delivered test that proves nothing is said so plainly", () => {
  test("states it already passed at the base commit, and that the suite passed", () => {
    const out = report([
      {
        kind: "delivered-test-does-not-bind",
        checkType: "test",
        component: "frontend",
        changed: ["tests/generators/utils/parse.tests.ts"],
      },
    ]);
    expect(out).toContain("already PASSED at the base commit");
    expect(out).toContain("does not prove the change does anything");
    expect(out).toContain("tests/generators/utils/parse.tests.ts");
    expect(out).not.toContain("test suite did not pass");
  });

  test("is distinct from the no-test-at-all case", () => {
    const noTest = report([{ kind: "behavioral-no-test", checkType: "test" }]);
    expect(noTest).toContain("without a test of its own");
    expect(noTest).not.toContain("already PASSED at the base commit");
  });
});

describe("ENG-402: the binding proof is shown positively, not only on failure", () => {
  test("the PR states the test was confirmed to fail at the base commit", () => {
    const out = renderVerifyReport({
      criteria: [{ seq: 1, text: "bug no longer reproduces", label: "verified" }],
      binding: [{ component: "frontend", bound: ["tests/generators/utils/parse.tests.ts"] }],
      advisory: [],
      provenance: [],
      allClean: true,
    });
    expect(out).toContain("checked out at the base commit");
    expect(out).toContain("confirmed to FAIL there");
    expect(out).toContain("tests/generators/utils/parse.tests.ts");
  });

  test("no binding evidence renders no section at all", () => {
    const out = renderVerifyReport({
      criteria: [{ seq: 1, text: "bug no longer reproduces", label: "verified" }],
      binding: [],
      advisory: [],
      provenance: [],
      allClean: true,
    });
    expect(out).not.toContain("base commit");
  });
});
