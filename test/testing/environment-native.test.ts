import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provesBehavioralFailure,
  resolveCheckExecution,
} from "../../src/dispatch/check-execution.ts";
import { runCheckExecution } from "../../src/dispatch/checks-run.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import {
  planTestEnvironment,
  qualifyTestEnvironment,
  requireTestEnvironment,
} from "../../src/testing/environment.ts";

const deps = process.env.STYRE_ENV_NATIVE_NODE_DEPS;
for (const fw of ["jest", "vitest", "mocha"] as const)
  test.skipIf(!deps)(
    `native ${fw}: collection and broken config stay distinct`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), `styre-native-${fw}-`));
      try {
        symlinkSync(deps as string, join(root, "node_modules"), "dir");
        const config =
          fw === "jest"
            ? "jest.config.cjs"
            : fw === "vitest"
              ? "vitest.config.mjs"
              : ".mocharc.json";
        const body = `${fw} --config ${config}`;
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({
            name: "native-env-fixture",
            version: "1.0.0",
            scripts: { "test:unit": body },
          }),
        );
        writeFileSync(
          join(root, config),
          fw === "jest"
            ? "if(process.env.npm_lifecycle_event!=='test:unit')throw Error('script lifecycle lost');module.exports={testMatch:['**/test/*.test.js'],maxWorkers:1};"
            : fw === "vitest"
              ? "export default {test:{include:['test/*.test.js'],pool:'forks',poolOptions:{forks:{singleFork:true}}}};"
              : "{}",
        );
        mkdirSync(join(root, "test"));
        writeFileSync(
          join(root, "test/example.test.js"),
          fw === "vitest"
            ? "import {test,expect} from 'vitest';test('one',()=>expect(1).toBe(1));"
            : "it('one',()=>{if(1!==1)throw Error('bad');});",
        );
        const c = parseProfile({
          slug: "native",
          targetRepo: root,
          components: [
            { name: "app", kind: "node", paths: ["**"], commands: { test: "npm run test:unit" } },
          ],
        }).components[0];
        c.testEnvironment = planTestEnvironment(root, c, "existing");
        const p = c.testEnvironment;
        if (!p || p.adapter !== "node") throw Error("missing node plan");
        c.testAction = { framework: p.framework, launcher: p.checkLauncher };
        const good = await qualifyTestEnvironment(root, c, { collect: true });
        expect({
          status: good.status,
          reason: good.reason,
          probes: good.status === "ready" ? undefined : good.probes,
        }).toMatchObject({ status: "ready" });
        expect(good.collection?.count).toBe(1);
        writeFileSync(join(root, config), "this is not valid configuration (");
        expect((await qualifyTestEnvironment(root, c, { collect: true })).status).toBe("error");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

test.skipIf(!process.env.STYRE_ENV_NATIVE_PYTHON)(
  "native Python: ordinary managed environment distinguishes empty from import failure",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-native-py-"));
    try {
      writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
      const c = parseProfile({
        slug: "native",
        targetRepo: root,
        components: [
          { name: "app", kind: "python", paths: ["**"], commands: { test: "python3 -m pytest" } },
        ],
      }).components[0];
      c.testEnvironment = planTestEnvironment(root, c, "managed");
      c.testAction = { framework: "pytest", launcher: "python3 -m pytest" };
      const empty = await qualifyTestEnvironment(root, c, { collect: true });
      expect({ status: empty.status, reason: empty.reason }).toMatchObject({ status: "empty" });
      writeFileSync(
        join(root, "test_example.py"),
        "def test_one():\n assert False, 'collection never executes this body'\n",
      );
      const good = await qualifyTestEnvironment(root, c, { collect: true });
      expect(good.status).toBe("ready");
      expect(good.collection?.count).toBe(1);
      writeFileSync(
        join(root, "test_example.py"),
        "import styre_definitely_missing_dependency_xyz\n",
      );
      const bad = await qualifyTestEnvironment(root, c, { collect: true });
      expect(bad.status).toBe("error");
      expect(bad.probes?.some((p) => p.stdout.includes("ModuleNotFoundError"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

for (const launcher of [
  "python3 -m pytest -rA --durations 25",
  "python3 -m pytest --durations=10 -q",
])
  test.skipIf(!process.env.STYRE_ENV_NATIVE_PYTHON)(
    `native Python: reporting-only options keep verdicts readable: ${launcher}`,
    async () => {
      // -rA prints passing tests' captured output (a pytester-style inner failure here) where
      // `E assert` lines are counted as evidence; a -q launcher stacked on the collection probe's
      // own -q hides `N tests collected`. Neither may reach single-check or collection output.
      const root = mkdtempSync(join(tmpdir(), "styre-native-py-report-"));
      try {
        writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
        writeFileSync(
          join(root, "test_example.py"),
          [
            "def test_pass():",
            "    assert 1 == 1",
            "",
            "def test_fail():",
            "    assert 1 == 2",
            "",
            "def test_crash():",
            "    raise AttributeError('not an assertion')",
            "",
          ].join("\n"),
        );
        // Replayed file-scoped (delivered-test binding): a passing pytester-style test prints an
        // inner session's failure, and the only real failure is not an assertion.
        writeFileSync(
          join(root, "test_binding.py"),
          [
            "def test_prints_inner_failure():",
            "    print('E       assert 1 == 2')",
            "    print('=== 1 failed in 0.01s ===')",
            "",
            "def test_crash():",
            "    raise AttributeError('not an assertion')",
            "",
          ].join("\n"),
        );
        const c = parseProfile({
          slug: "native",
          targetRepo: root,
          components: [
            { name: "app", kind: "python", paths: ["**"], commands: { test: launcher } },
          ],
        }).components[0];
        const plan = planTestEnvironment(root, c, "existing");
        if (plan?.adapter !== "python") throw Error("expected a supported pytest plan");
        c.testEnvironment = plan;
        c.testAction = { framework: "pytest", launcher: plan.checkLauncher };
        const qualified = await qualifyTestEnvironment(root, c, { collect: true });
        expect({ status: qualified.status, reason: qualified.reason }).toMatchObject({
          status: "ready",
        });
        expect(qualified.collection?.count).toBe(5);
        await requireTestEnvironment(root, c);
        const run = async (testName?: string, testFile = "test_example.py") => {
          const check = resolveCheckExecution({ components: [c], testFile, testName });
          const result = await runCheckExecution({
            plan: check,
            components: [c],
            worktreePath: root,
            timeoutMs: 30000,
          });
          return { check, result };
        };
        expect((await run("test_pass")).result.coarse).toBe("green");
        const fail = await run("test_fail");
        expect(fail.result.coarse).toBe("red");
        expect(provesBehavioralFailure(fail.check, fail.result)).toBe(true);
        const crash = await run("test_crash");
        expect(crash.result.coarse).toBe("red");
        expect(provesBehavioralFailure(crash.check, crash.result)).toBe(false);
        const binding = await run(undefined, "test_binding.py");
        expect(binding.result.coarse).toBe("red");
        expect(provesBehavioralFailure(binding.check, binding.result)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
