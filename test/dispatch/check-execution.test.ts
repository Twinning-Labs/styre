import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckExecutionPlanSchema,
  checkOwner,
  interpretCheckExecution,
  provesBehavioralFailure,
  resolveCheckExecution,
} from "../../src/dispatch/check-execution.ts";
import { runCheckExecution } from "../../src/dispatch/checks-run.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import { resolveTestAction } from "../../src/setup/test-action.ts";
import type { CommandResult } from "../../src/util/run-command.ts";

const component: Component = {
  name: "ui",
  kind: "node",
  dir: "packages/ui",
  paths: ["packages/ui/**"],
  commands: { test: "npm test" },
  extensions: [".js"],
  testAction: { framework: "mocha", launcher: "npm test --", selectorDir: "../.." },
};
const file = "packages/ui/checks/ENG-1_ac1_test.js";
const title = "suite [literal] leaf 'quoted'";
const plan = resolveCheckExecution({ components: [component], testFile: file, testName: title });
const out = (over: Partial<CommandResult> = {}): CommandResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});
function report(
  kind: "pass" | "fail" | "pending",
  extras: { file?: string; fullTitle?: string; duplicate?: boolean } = {},
) {
  const item = {
    fullTitle: extras.fullTitle ?? title,
    file: extras.file ?? `/repo/${file}`,
    err: kind === "fail" ? { message: "expected 1 to equal 2" } : {},
  };
  const tests = extras.duplicate ? [item, item] : [item];
  return JSON.stringify({
    stats: {
      tests: tests.length,
      passes: kind === "pass" ? tests.length : 0,
      failures: kind === "fail" ? tests.length : 0,
      pending: kind === "pending" ? tests.length : 0,
    },
    tests,
    passes: kind === "pass" ? tests : [],
    failures: kind === "fail" ? tests : [],
    pending: kind === "pending" ? tests : [],
  });
}

test("nested owner and launcher cwd are distinct from wrapper selector cwd", () => {
  expect(plan.cwd).toBe("packages/ui");
  expect(plan.selectorCwd).toBe(".");
  expect(plan.runArgs).toContain(`'${file}'`);
  expect(plan.runArgs).toContain("--grep");
  const aggregate = { ...component, name: "root", dir: undefined, paths: ["**"] };
  expect(checkOwner([aggregate, component], file).name).toBe("ui");
  expect(() => checkOwner([component, { ...component, name: "ambiguous" }], file)).toThrow(
    "one component owner",
  );
});

test("ordinary nested runner gets a component-relative, quoted selector", () => {
  const p = resolveCheckExecution({
    components: [{ ...component, kind: "python", extensions: [".py"], testAction: undefined }],
    testFile: "packages/ui/tests/space name.py",
    testName: "Case::test_x[a::b]",
  });
  expect(p.runArgs).toBe("'tests/space name.py::Case::test_x[a::b]'");
});

test("invalid paths and cwd escapes are rejected before launch", () => {
  for (const testFile of ["../outside.js", "/tmp/x.js", "packages/../x.js", "packages\\x.js"])
    expect(() =>
      resolveCheckExecution({ components: [component], testFile, testName: title }),
    ).toThrow();
  expect(() =>
    resolveCheckExecution({
      components: [
        {
          ...component,
          testAction: { framework: "mocha", launcher: "npm test --", selectorDir: "../../.." },
        },
      ],
      testFile: file,
      testName: title,
    }),
  ).toThrow();
  expect(CheckExecutionPlanSchema.safeParse({ ...plan, version: 999 }).success).toBe(false);
});

test("Mocha requires completed unique file/fullTitle evidence and matching status", () => {
  expect(interpretCheckExecution(plan, out({ stdout: report("pass") }), "/repo").coarse).toBe(
    "green",
  );
  expect(
    interpretCheckExecution(plan, out({ exitCode: 1, stdout: report("fail") }), "/repo").coarse,
  ).toBe("red");
  expect(interpretCheckExecution(plan, out({ stdout: report("pending") }), "/repo").coarse).toBe(
    "selected-none",
  );
  for (const stdout of [
    "0 passing",
    report("pass", { fullTitle: "some other test" }),
    report("pass", { file: "/repo/other.js" }),
    report("pass", { duplicate: true }),
    report("fail"),
    `${report("pass")}\ntruncated trailing output`,
  ])
    expect(interpretCheckExecution(plan, out({ stdout }), "/repo").coarse).toBe("error");
  expect(
    interpretCheckExecution(plan, out({ stdout: report("pass"), timedOut: true }), "/repo").coarse,
  ).toBe("error");
});

const django: Component = {
  name: "py",
  kind: "python",
  paths: ["**"],
  commands: {},
  extensions: [".py"],
  testAction: { framework: "django-runtests", launcher: "python tests/runtests.py --parallel 1" },
};
const dp = resolveCheckExecution({
  components: [django],
  testFile: "tests/styre_checks/ENG-466_ac1_test.py",
  testName: "ParentTests::test_parent_link",
});
test("Django Class::method becomes exact dotted identity; bare method is rejected", () => {
  expect(dp.runArgs).toBe(
    "'styre_checks.ENG-466_ac1_test.ParentTests.test_parent_link' --verbosity 2",
  );
  expect(() =>
    resolveCheckExecution({
      components: [django],
      testFile: dp.testFile,
      testName: "test_parent_link",
    }),
  ).toThrow("Class.method");
  const text =
    "test_parent_link (styre_checks.ENG-466_ac1_test.ParentTests) ... FAIL\n\nRan 1 test in 0.001s\n\nFAILED (failures=1)";
  expect(interpretCheckExecution(dp, out({ exitCode: 1, stderr: text }), "/repo").coarse).toBe(
    "red",
  );
  expect(
    interpretCheckExecution(dp, out({ stderr: text.replace("FAIL", "ok") }), "/repo").coarse,
  ).toBe("green");
  expect(
    interpretCheckExecution(dp, out({ stderr: text.replace("FAIL", "skipped 'no db'") }), "/repo")
      .coarse,
  ).toBe("selected-none");
  expect(
    interpretCheckExecution(
      dp,
      out({ stderr: text.replace("test_parent_link", "test_other") }),
      "/repo",
    ).coarse,
  ).toBe("error");
  expect(
    interpretCheckExecution(
      dp,
      out({ exitCode: 1, stderr: text.replace("FAIL", "ERROR") }),
      "/repo",
    ).coarse,
  ).toBe("error");
});

test("baseline proof excludes missing dependencies, collection errors, and zero selected", () => {
  const pp = resolveCheckExecution({
    components: [{ ...django, testAction: undefined }],
    testFile: "tests/test_bug.py",
  });
  expect(
    provesBehavioralFailure(pp, {
      coarse: "red",
      rawOutput: "E       assert 1 == 2\n1 failed in 0.01s",
    }),
  ).toBe(true);
  for (const rawOutput of [
    "No module named pytest",
    "1 error in 0.01s",
    "1 failed, 1 error",
    "no tests ran",
  ])
    expect(provesBehavioralFailure(pp, { coarse: "red", rawOutput })).toBe(false);
  for (const stdout of ["", "1 skipped", "1 test collected"])
    expect(interpretCheckExecution(pp, out({ stdout }), "/repo").coarse).toBe("selected-none");
});

// Native compatibility checks are opt-in; CI/unit tests above do not download runners.
// STYRE_TEST_NATIVE_ROOT contains node_modules/mocha@10.2.0 and venv with Django/pytest.
const nativeRoot = process.env.STYRE_TEST_NATIVE_ROOT;
const native = nativeRoot ? test : test.skip;
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "styre-native-contract-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

native(
  "native Mocha wrapper: composed identity, cwd, config overrides, skip, hook and duplicate",
  async () => {
    const root = fixture();
    symlinkSync(join(nativeRoot ?? "", "node_modules"), join(root, "node_modules"), "dir");
    mkdirSync(join(root, "packages/ui/checks"), { recursive: true });
    writeFileSync(
      join(root, "packages/ui/package.json"),
      JSON.stringify({
        scripts: { test: "cd ../../ && env NODE_ENV=test mocha 'packages/ui/**/*.js'" },
      }),
    );
    writeFileSync(
      join(root, ".mocharc.json"),
      JSON.stringify({
        require: "./setup.cjs",
        dryRun: true,
        parallel: true,
        bail: true,
        invert: true,
      }),
    );
    writeFileSync(join(root, "setup.cjs"), "global.styreSetup = true;\n");
    writeFileSync(
      join(root, "packages/ui/unrelated.js"),
      "describe('unrelated',()=>it('fails',()=>{throw Error('must not execute')}));\n",
    );
    const action = resolveTestAction(join(root, "packages/ui"), "npm test");
    expect(action?.framework).toBe("mocha");
    const resolved = resolveCheckExecution({
      components: [{ ...component, testAction: action ?? undefined }],
      testFile: file,
      testName: title,
    });
    const run = () => runCheckExecution({ plan: resolved, worktreePath: root, timeoutMs: 15000 });
    const body =
      "if (!global.styreSetup || process.env.NODE_ENV !== 'test') throw Error('configuration lost');";
    const source = (kind: string, code: string) =>
      `describe('suite [literal]',()=>${kind}("leaf 'quoted'",()=>{${body}${code}}));\n`;
    writeFileSync(join(root, file), source("it", "throw Error('real body ran');"));
    const first = await run();
    if (first.coarse !== "red") throw new Error(JSON.stringify(first)); // dryRun=true must NOT manufacture green
    writeFileSync(join(root, file), source("it", ""));
    expect((await run()).coarse).toBe("green");
    writeFileSync(join(root, file), source("it.skip", ""));
    expect((await run()).coarse).toBe("selected-none");
    writeFileSync(join(root, file), source("it", "") + source("it", ""));
    expect((await run()).coarse).toBe("error");
    writeFileSync(
      join(root, file),
      `beforeEach(()=>{throw Error('broken setup')});\n${source("it", "")}`,
    );
    expect((await run()).coarse).toBe("error");
    const filePlan = resolveCheckExecution({
      components: [{ ...component, testAction: action ?? undefined }],
      testFile: file,
    });
    writeFileSync(join(root, file), source("it", "require('node:assert').strictEqual(1, 2);"));
    const fileFailure = await runCheckExecution({
      plan: filePlan,
      worktreePath: root,
      timeoutMs: 15000,
    });
    expect(fileFailure.coarse).toBe("red");
    expect(provesBehavioralFailure(filePlan, fileFailure)).toBe(true);
    writeFileSync(join(root, file), source("it", ""));
    const targetPass = await runCheckExecution({
      plan: filePlan,
      worktreePath: root,
      timeoutMs: 15000,
    });
    expect(targetPass.exitCode).toBe(1); // unrelated wrapper-selected test still fails
    expect(targetPass.coarse).toBe("green"); // it cannot masquerade as target binding
  },
  60000,
);

native(
  "native Django executes exact hyphenated module/class/method, including docstrings",
  async () => {
    const root = fixture();
    mkdirSync(join(root, "checks"));
    writeFileSync(join(root, "checks/__init__.py"), "");
    writeFileSync(
      join(root, "runner.py"),
      "from django.conf import settings\nsettings.configure(SECRET_KEY='test', INSTALLED_APPS=[], DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}})\nimport django, sys\ndjango.setup()\nfrom django.core.management import execute_from_command_line\nexecute_from_command_line(['manage.py', 'test'] + sys.argv[1:])\n",
    );
    const c = {
      ...django,
      testAction: {
        framework: "django-runtests" as const,
        // This fixture rewrites equal-sized Python source within one timestamp second.
        // Start without bytecode writes so every subprocess imports the current variant.
        launcher: `${nativeRoot}/venv/bin/python -B runner.py --parallel 1`,
      },
    };
    const p = resolveCheckExecution({
      components: [c],
      testFile: "checks/ENG-466_test.py",
      testName: "ParentTests::test_parent_link",
    });
    const run = () => runCheckExecution({ plan: p, worktreePath: root, timeoutMs: 15000 });
    const source = (body: string) =>
      `from django.test import SimpleTestCase\nclass ParentTests(SimpleTestCase):\n    def test_parent_link(self):\n        """Checks a real behavior."""\n        ${body}\n    def test_unrelated(self):\n        self.fail('must not run')\n`;
    const writeTest = (content: string) => {
      writeFileSync(join(root, p.testFile), content);
      // Deliberately identical metadata: CI must not depend on when the wall clock ticks.
      utimesSync(join(root, p.testFile), 1700000000, 1700000000);
    };
    writeTest(source("self.assertEqual(1, 2)"));
    const failure = await run();
    expect(failure.coarse).toBe("red");
    expect(provesBehavioralFailure(p, failure)).toBe(true);
    writeTest(source("self.assertEqual(1, 1)"));
    expect((await run()).coarse).toBe("green");
    writeTest(source("self.skipTest('not evidence')"));
    expect((await run()).coarse).toBe("selected-none");
    for (const phase of ["setUp", "tearDown"]) {
      writeTest(
        source("self.assertEqual(1, 1)").replace(
          "class ParentTests(SimpleTestCase):",
          `class ParentTests(SimpleTestCase):\n    def ${phase}(self):\n        self.fail('fixture assertion')`,
        ),
      );
      const fixtureFailure = await run();
      expect(fixtureFailure.coarse).toBe("red");
      expect(provesBehavioralFailure(p, fixtureFailure)).toBe(false);
    }
  },
  60000,
);

native(
  "native pytest nested component and parametrized identity",
  async () => {
    const root = fixture();
    mkdirSync(join(root, "api/tests"), { recursive: true });
    writeFileSync(
      join(root, "api/tests/test_bug.py"),
      "import pytest\nclass TestCase:\n    @pytest.mark.parametrize('value', [1], ids=['a::b'])\n    def test_bug(self, value):\n        assert value == 2\n",
    );
    const p = resolveCheckExecution({
      components: [
        {
          name: "api",
          kind: "python",
          paths: ["api/**"],
          dir: "api",
          commands: {},
          extensions: [".py"],
        },
      ],
      testFile: "api/tests/test_bug.py",
      testName: "TestCase::test_bug[a::b]",
      interp: `${nativeRoot}/venv/bin/python`,
    });
    const result = await runCheckExecution({ plan: p, worktreePath: root, timeoutMs: 15000 });
    expect(result.coarse).toBe("red");
    expect(provesBehavioralFailure(p, result)).toBe(true);
  },
  30000,
);

test("a Mocha timeout or runtime error cannot establish delivered regression binding", () => {
  for (const err of [
    { code: "ERR_MOCHA_TIMEOUT", message: "Timeout exceeded" },
    { stack: "ReferenceError: missing" },
  ]) {
    const data = JSON.parse(report("fail"));
    data.failures[0].err = err;
    data.tests[0].err = err;
    const verdict = interpretCheckExecution(
      plan,
      out({ exitCode: 1, stdout: JSON.stringify(data) }),
      "/repo",
    );
    expect(verdict.coarse).toBe("red");
    expect(provesBehavioralFailure(plan, { ...verdict, rawOutput: JSON.stringify(data) })).toBe(
      false,
    );
  }
  const data = JSON.parse(report("fail"));
  data.failures[0].err = { code: "ERR_ASSERTION" };
  data.tests[0].err = { code: "ERR_ASSERTION" };
  const verdict = interpretCheckExecution(
    plan,
    out({ exitCode: 1, stdout: JSON.stringify(data) }),
    "/repo",
  );
  expect(provesBehavioralFailure(plan, { ...verdict, rawOutput: JSON.stringify(data) })).toBe(true);
});

test("root spelling and shell-sensitive file names have deterministic ownership/selectors", () => {
  expect(checkOwner([{ ...component, dir: ".", paths: ["**"] }], file).name).toBe("ui");
  const p = resolveCheckExecution({
    components: [{ ...component, testAction: { framework: "jest", launcher: "npm test --" } }],
    testFile: "packages/ui/checks/space 'quote'.js",
    testName: "leaf",
  });
  expect(p.runArgs).toContain("'checks/space '\\''quote'\\''.js'");
});

test("Mocha reconciles repeated failure events without treating duplicate tests as unique", () => {
  const data = JSON.parse(report("fail"));
  data.failures[0].err = { code: "ERR_ASSERTION" };
  data.failures.push({ ...data.failures[0] });
  data.stats.failures = 2; // actual MUI 39353 shape: tests=1, failures=2
  const result = interpretCheckExecution(
    plan,
    out({ exitCode: 2, stdout: JSON.stringify(data) }),
    "/repo",
  );
  expect(result.coarse).toBe("red");
  expect(result.behavioralFailure).toBe(true);
  data.failures[1].fullTitle = "beforeEach hook";
  expect(
    interpretCheckExecution(plan, out({ exitCode: 2, stdout: JSON.stringify(data) }), "/repo")
      .coarse,
  ).toBe("error");
});

test("file-scoped Mocha evidence ignores unrelated failures but named AC evidence rejects them", () => {
  const data = JSON.parse(report("pass"));
  const unrelated = {
    fullTitle: "unrelated",
    file: "/repo/other.js",
    err: { code: "ERR_ASSERTION" },
  };
  data.tests.push(unrelated);
  data.failures.push(unrelated);
  data.stats.tests = 2;
  data.stats.failures = 1;
  const result = out({ exitCode: 1, stdout: JSON.stringify(data) });
  const filePlan = resolveCheckExecution({ components: [component], testFile: file });
  expect(interpretCheckExecution(filePlan, result, "/repo").coarse).toBe("green");
  expect(interpretCheckExecution(plan, result, "/repo").coarse).toBe("error");
  const noTarget = { ...filePlan, testFile: "packages/ui/not-run.js" };
  expect(interpretCheckExecution(noTarget, result, "/repo").coarse).toBe("selected-none");
});
