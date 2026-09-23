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

test.skipIf(!process.env.STYRE_ENV_NATIVE_PYTHON)(
  "native Python: reporting-only pytest options keep collection and check verdicts readable",
  async () => {
    // The launcher Sphinx's tox.ini implies. -rA adds a summary section and --durations a timing
    // table; neither may change collection counts, GREEN/RED, or behavioral-failure evidence.
    const launcher = "python3 -m pytest -rA --durations 25";
    const root = mkdtempSync(join(tmpdir(), "styre-native-py-report-"));
    try {
      writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
      writeFileSync(
        join(root, "test_example.py"),
        "def test_pass():\n    assert 1 == 1\n\ndef test_fail():\n    assert 1 == 2\n",
      );
      const c = parseProfile({
        slug: "native",
        targetRepo: root,
        components: [{ name: "app", kind: "python", paths: ["**"], commands: { test: launcher } }],
      }).components[0];
      c.testEnvironment = planTestEnvironment(root, c, "existing");
      expect(c.testEnvironment?.adapter).toBe("python");
      c.testAction = { framework: "pytest", launcher };
      const qualified = await qualifyTestEnvironment(root, c, { collect: true });
      expect(qualified.status).toBe("ready");
      expect(qualified.collection?.count).toBe(2);
      await requireTestEnvironment(root, c);
      const run = async (testName: string) => {
        const plan = resolveCheckExecution({
          components: [c],
          testFile: "test_example.py",
          testName,
        });
        return {
          plan,
          result: await runCheckExecution({
            plan,
            components: [c],
            worktreePath: root,
            timeoutMs: 30000,
          }),
        };
      };
      const pass = await run("test_pass");
      expect(pass.result.coarse).toBe("green");
      expect(pass.result.command.startsWith(launcher)).toBe(true);
      const fail = await run("test_fail");
      expect(fail.result.coarse).toBe("red");
      expect(provesBehavioralFailure(fail.plan, fail.result)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
