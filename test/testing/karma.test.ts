import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeComponent } from "../../src/dispatch/check-capability.ts";
import { frameworkFor } from "../../src/dispatch/check-selector.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { testCapabilities } from "../../src/testing/environment-schema.ts";
import { planTestEnvironment, testEnvironmentProblem } from "../../src/testing/environment.ts";
import { karmaVerdict } from "../../src/testing/karma.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(body = "./node_modules/.bin/karma start --browsers Firefox --single-run") {
  const root = mkdtempSync(join(tmpdir(), "styre-karma-contract-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: body } }));
  writeFileSync(join(root, "karma.conf.js"), 'module.exports=c=>c.set({frameworks:["jasmine"]});');
  const c = parseProfile({
    slug: "fixture",
    targetRepo: root,
    components: [{ name: "browser", kind: "node", paths: ["**"], commands: { test: "npm test" } }],
  }).components[0];
  c.testEnvironment = planTestEnvironment(root, c, "existing");
  return { root, c };
}
test("Karma qualifies suite intent without inventing an authored framework", async () => {
  const { root, c } = fixture();
  expect(c.testEnvironment?.adapter).toBe("karma");
  if (!c.testEnvironment) throw Error("missing plan");
  expect(testCapabilities(c.testEnvironment)).toMatchObject({
    suite: "supported",
    authoredChecks: "unsupported",
  });
  expect(testEnvironmentProblem(root, c)).toBeUndefined();
  expect(frameworkFor(c)).toBeNull();
  const capability = await probeComponent(c, {
    worktreePath: root,
    run: async () => {
      throw Error("must not probe invented launcher");
    },
  });
  expect(capability.runnable).toBe(false);
  c.testAction = { framework: "mocha", launcher: "npm test --" };
  expect(frameworkFor(c)).toBeNull();
  expect(testEnvironmentProblem(root, c)).toContain("Suite-only");
});
test("changed script and unsupported wrappers fail closed", () => {
  const { root, c } = fixture();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "karma start --browsers Chrome --single-run" } }),
  );
  expect(testEnvironmentProblem(root, c)).toContain("differs");
  for (const body of [
    "karma start",
    "karma start --browsers Firefox --single-run || true",
    "karma start custom.js --browsers Firefox --single-run",
  ]) {
    expect(fixture(body).c.testEnvironment?.adapter).toBe("unsupported");
  }
});
const completion = () => ({
  version: 1,
  browsers: [
    {
      id: "browser-1",
      name: "Firefox",
      success: 2,
      failed: 0,
      skipped: 0,
      total: 2,
      error: false,
      disconnected: false,
    },
  ],
  success: 2,
  failed: 0,
  exitCode: 0,
  error: false,
  disconnected: false,
});
test("only completed nonempty browser evidence yields a suite verdict", () => {
  expect(karmaVerdict(completion(), 0, 1)).toBe("pass");
  const failed = completion();
  failed.browsers[0].success = 1;
  failed.browsers[0].failed = 1;
  failed.success = 1;
  failed.failed = 1;
  failed.exitCode = 1;
  expect(karmaVerdict(failed, 1, 1)).toBe("fail");
  expect(karmaVerdict(failed, 0, 1)).toBe("error");
  expect(karmaVerdict(undefined, 0, 1)).toBe("error");
  expect(karmaVerdict(completion(), null, 1)).toBe("error");
  expect(karmaVerdict(completion(), 0, 2)).toBe("error");
  for (const field of ["error", "disconnected"] as const) {
    const r = completion();
    r.browsers[0][field] = true;
    expect(karmaVerdict(r, 0, 1)).toBe("error");
  }
  const empty = completion();
  empty.browsers[0].success = 0;
  empty.browsers[0].total = 0;
  empty.success = 0;
  expect(karmaVerdict(empty, 0, 1)).toBe("error");
  const inconsistent = completion();
  inconsistent.browsers[0].total = 3;
  expect(karmaVerdict(inconsistent, 0, 1)).toBe("error");
});

test("npm builtins cannot masquerade as script execution", () => {
  const { root, c } = fixture();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { install: "karma start --browsers Firefox --single-run" } }),
  );
  c.commands.test = "npm install";
  expect(planTestEnvironment(root, c, "existing")?.adapter).toBe("unsupported");
});
