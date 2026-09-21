import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCheckExecution } from "../../src/dispatch/check-execution.ts";
import { runCheckExecution } from "../../src/dispatch/checks-run.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import { planProvision } from "../../src/dispatch/provision.ts";
import { nodeDef } from "../../src/setup/lang/node.ts";
import { nodeManager } from "../../src/setup/node-manager.ts";
import { TestEnvironmentPlanSchema } from "../../src/testing/environment-schema.ts";
import {
  inspectTestRuntime,
  planTestEnvironment,
  preparedToxCandidate,
  qualifyTestEnvironment,
  requireTestEnvironment,
} from "../../src/testing/environment.ts";
import type { CmdRunner, CommandResult } from "../../src/util/run-command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture(files: Record<string, string> = {}) {
  const r = mkdtempSync(join(tmpdir(), "styre-env-test-"));
  roots.push(r);
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), s);
  }
  return r;
}
function component(
  repo: string,
  command = "python3 -m pytest",
  policy: "managed" | "existing" = "existing",
  extra: Partial<Component> = {},
): Component {
  const c: Component = {
    name: "app",
    kind: "python",
    paths: ["**"],
    commands: { test: command },
    extensions: [],
    ...extra,
  };
  c.testEnvironment = planTestEnvironment(repo, c, policy);
  const p = c.testEnvironment;
  if (p && (p.adapter === "python" || p.adapter === "node"))
    c.testAction = { framework: p.framework, launcher: p.checkLauncher };
  return c;
}
const result = (stdout = "", exitCode = 0): CommandResult => ({
  stdout,
  stderr: "",
  exitCode,
  timedOut: false,
});
function runner(
  repo: string,
  options: {
    source?: string;
    collection?: CommandResult;
    runtimeVersion?: string;
    config?: string;
    managerVersion?: string;
    frameworkMissing?: boolean;
  } = {},
): { run: CmdRunner; calls: string[] } {
  const calls: string[] = [];
  const runtime = {
    executable: "/env/bin/python",
    version: options.runtimeVersion ?? "3.9.20",
    packages: { pytest: "8.3.3", tox: "4.16.0", "tox-current-env": "0.0.11" },
    source: options.source ?? join(repo, "pkg/__init__.py"),
  };
  const run: CmdRunner = async (cmd) => {
    calls.push(cmd);
    if (cmd === "git rev-parse HEAD") return result("abc123\n");
    if (cmd.includes("--showconfig"))
      return result(
        options.config ??
          `runner = current-env\nenv_name = py39\nchange_dir = ${repo}\nignore_outcome = False\ncommands = pytest --durations 25 __styre_identity__.py\n`,
      );
    if (cmd.includes("_styre_environment_probe.py"))
      return result(`STYRE_ENVIRONMENT_JSON=${JSON.stringify(runtime)}\n`, 5);
    if (
      cmd.includes("--collect-only") ||
      cmd.includes("--listTests") ||
      cmd.includes("list --json")
    )
      return options.collection ?? result("2 tests collected in 0.01s");
    if (cmd.includes("--version")) return result(options.managerVersion ?? "9.1.0");
    if (cmd.startsWith("node -e"))
      return result(
        JSON.stringify({
          executable: "/usr/bin/node",
          version: "22.0.0",
          packages: options.frameworkMissing
            ? {}
            : {
                jest: { path: join(repo, "node_modules/jest/index.js"), version: "29.0.0" },
                vitest: { version: "2" },
              },
        }),
      );
    return result(JSON.stringify(runtime));
  };
  return { run, calls };
}
test("supported plans require framework, check launcher and Node manager; unsupported requires reason", () => {
  expect(
    TestEnvironmentPlanSchema.safeParse({
      version: 1,
      policy: "existing",
      adapter: "python",
      suiteCommand: "python -m pytest",
    }).success,
  ).toBe(false);
  expect(
    TestEnvironmentPlanSchema.safeParse({
      version: 1,
      policy: "managed",
      adapter: "node",
      suiteCommand: "npm test",
      framework: "jest",
      checkLauncher: "jest",
    }).success,
  ).toBe(false);
});
test("an installed tox plugin is evidence, not authority to change managed policy", async () => {
  const r = fixture();
  const c = component(r, "python3 -m tox -e py39 --current-env --no-provision", "managed");
  expect(c.testEnvironment?.adapter).toBe("unsupported");
  const fake = runner(r);
  const inventory = await inspectTestRuntime(r, c, fake.run);
  expect(await preparedToxCandidate(r, c, inventory, fake.run)).toBe(
    "python3 -m tox -e py39 --current-env --no-provision",
  );
  expect(
    planProvision(
      [component(r, "python3 -m pytest", "existing", { prepare: "pip install -e ." })],
      r,
    ),
  ).toEqual([]);
});
test("source binding comes from selected launcher, not a successful outer interpreter", async () => {
  const r = fixture({ "pkg/__init__.py": "" });
  const c = component(r, "python3 -m tox -e py39 --current-env --no-provision");
  const bad = await qualifyTestEnvironment(r, c, {
    run: runner(r, { source: "/old/pkg/__init__.py" }).run,
  });
  expect(bad.status).toBe("requires-preparation");
  const good = await qualifyTestEnvironment(r, c, { collect: true, run: runner(r).run });
  expect(good.status).toBe("ready");
  expect(good.runtime.source).toBe(join(r, "pkg/__init__.py"));
  expect(good.collection?.count).toBe(2);
});
test.each([
  "python3 -m pytest tests/unit -k old",
  "python3 -m pytest --pyargs elsewhere",
  "python3 -m tox -e py39,py310",
  "nox -s tests",
])("unsupported selection cannot become an authored-check launcher: %s", (cmd) => {
  const r = fixture();
  expect(component(r, cmd).testEnvironment?.adapter).toBe("unsupported");
});
test.each([
  "commands = pytest tests/ __styre_identity__.py",
  "commands = pytest -k old __styre_identity__.py",
  "commands_pre = echo mutation\ncommands = pytest __styre_identity__.py",
  "commands = pytest\n",
  "ignore_outcome = True\ncommands = pytest __styre_identity__.py",
])("tox refuses selection/extra commands/hidden outcomes: %s", async (suffix) => {
  const r = fixture();
  const c = component(r, "python3 -m tox -e py39 --current-env --no-provision");
  const f = runner(r, {
    config: `runner = current-env\nenv_name = py39\nchange_dir = ${r}\nignore_outcome = False\n${suffix}\n`,
  });
  expect((await qualifyTestEnvironment(r, c, { run: f.run })).status).toBe("error");
  expect(f.calls.some((c) => c.includes("_styre_environment_probe.py"))).toBe(false);
});
test("wrong tox interpreter fails before running selected probe", async () => {
  const r = fixture();
  expect(
    (
      await qualifyTestEnvironment(
        r,
        component(r, "python3 -m tox -e py39 --current-env --no-provision"),
        {
          run: runner(r, { runtimeVersion: "3.11.5" }).run,
        },
      )
    ).status,
  ).toBe("error");
});
test.each([
  { expected: "empty", output: result("no tests collected", 5) },
  { expected: "error", output: result("collection failure", 2) },
  { expected: "error", output: { ...result(), timedOut: true, exitCode: null } },
])(
  "collection reports $expected without inventing a test verdict",
  async ({ expected, output }) => {
    const r = fixture();
    const o = await qualifyTestEnvironment(r, component(r), {
      collect: true,
      run: runner(r, { collection: output }).run,
    });
    expect(o.status).toBe(expected);
  },
);
test("changed suite/action and changed declared manager cannot reuse a prior plan", async () => {
  const r = fixture();
  const c = component(r);
  if (!c.testAction) throw Error("missing fixture action");
  c.testAction.launcher = "python3 -m pytest -k unrelated";
  expect((await qualifyTestEnvironment(r, c, { run: runner(r).run })).status).toBe("error");
  c.testAction.launcher = "python3 -m pytest";
  c.commands.test = "python3 -m pytest -v";
  expect((await qualifyTestEnvironment(r, c, { run: runner(r).run })).status).toBe("error");
});
test("observations change with lock content, not mtime cache alone", async () => {
  const r = fixture({ "uv.lock": "a" });
  const c = component(r);
  const a = await qualifyTestEnvironment(r, c, { run: runner(r).run });
  writeFileSync(join(r, "uv.lock"), "b");
  const b = await qualifyTestEnvironment(r, c, { run: runner(r).run });
  expect(a.fingerprint).not.toBe(b.fingerprint);
});
test("ancestor lockfile without workspace membership does not own an independent package", () => {
  const r = fixture({
    "package.json": '{"packageManager":"pnpm@9.1.0"}',
    "pnpm-lock.yaml": "",
    "apps/web/package.json": '{"packageManager":"npm@10.0.0","scripts":{"test":"jest"}}',
  });
  expect(nodeManager(r, join(r, "apps/web"))).toEqual({
    manager: "npm",
    version: "10.0.0",
    workspaceDir: "apps/web",
  });
});
test("workspace membership and exclusions control install owner, tests keep component cwd", () => {
  const r = fixture({
    "package.json": '{"packageManager":"pnpm@9.1.0"}',
    "pnpm-workspace.yaml": "packages:\n - 'apps/*'\n - '!apps/private'\n",
    "pnpm-lock.yaml": "",
    "apps/web/package.json": '{"scripts":{"test":"jest"}}',
    "apps/private/package.json": "{}",
  });
  expect(nodeManager(r, join(r, "apps/web"))).toMatchObject({ manager: "pnpm", workspaceDir: "." });
  expect(nodeManager(r, join(r, "apps/private"))).toMatchObject({
    manager: "npm",
    workspaceDir: "apps/private",
  });
  const c = component(r, "pnpm run test", "managed", {
    kind: "node",
    dir: "apps/web",
    prepare: "pnpm install --frozen-lockfile",
  });
  expect(c.testEnvironment).toMatchObject({
    adapter: "node",
    workspaceDir: ".",
    checkLauncher: "pnpm run test",
  });
  expect(planProvision([c, { ...c, name: "other" }], r)).toEqual([
    { component: "app", cwd: r, command: "pnpm install --frozen-lockfile" },
  ]);
});
test("Node detection uses declared manager consistently and rejects conflicts", () => {
  const r = fixture({
    "package.json": '{"packageManager":"pnpm@9.1.0","scripts":{"test":"jest"}}',
    "pnpm-lock.yaml": "",
  });
  expect(nodeDef.detect(r)[0]?.commands.test).toBe("pnpm run test");
  writeFileSync(join(r, "package-lock.json"), "{}");
  expect(nodeManager(r).reason).toContain("Conflicting");
});
test("Node non-default scripts qualify from component, version mismatch fails loudly", async () => {
  const r = fixture({
    "apps/web/package.json":
      '{"packageManager":"pnpm@9.1.0","scripts":{"test:unit":"jest --config tests/jest.config.js"}}',
  });
  const c = component(r, "pnpm run test:unit", "existing", { kind: "node", dir: "apps/web" });
  const good = await qualifyTestEnvironment(r, c, {
    collect: true,
    run: runner(r, { collection: result('["one.test.js"]') }).run,
  });
  expect(good.status).toBe("ready");
  expect(good.cwd).toBe(join(r, "apps/web"));
  expect(good.collection?.count).toBe(1);
  expect(
    (await qualifyTestEnvironment(r, c, { run: runner(r, { managerVersion: "8.0.0" }).run }))
      .status,
  ).toBe("error");
});
test("Vitest run cannot masquerade as a subcommand-free check context", () => {
  const r = fixture({
    "package.json": '{"scripts":{"test":"vitest run --config vitest.config.ts"}}',
  });
  expect(component(r, "npm run test", "managed", { kind: "node" }).testEnvironment?.adapter).toBe(
    "unsupported",
  );
});
test("Node preserves lifecycle environment and config by executing original script wrapper", () => {
  const r = fixture({
    "package.json": '{"scripts":{"test:unit":"jest --config tests/jest.config.js"}}',
  });
  expect(
    component(r, "npm run test:unit", "managed", { kind: "node" }).testEnvironment,
  ).toMatchObject({ checkLauncher: "npm run test:unit --", suiteCommand: "npm run test:unit" });
});

test("unique named test script is deterministic; competing suites remain unresolved", () => {
  const r = fixture({
    "package.json": '{"scripts":{"test:unit":"jest"},"packageManager":"pnpm@9.1.0"}',
  });
  expect(nodeDef.detect(r)[0]?.commands.test).toBe("pnpm run test:unit");
  writeFileSync(
    join(r, "package.json"),
    '{"scripts":{"test:unit":"jest","test:e2e":"playwright test"}}',
  );
  expect(nodeDef.detect(r)[0]?.commands.test).toMatchObject({
    unresolved: expect.stringContaining("Multiple test scripts"),
  });
});

test("resolved tox environment values are never retained as probe diagnostics", async () => {
  const r = fixture();
  const c = component(r, "python3 -m tox -e py39 --current-env --no-provision");
  const f = runner(r, {
    config: `runner = current-env\nenv_name = py39\nchange_dir = ${r}\nignore_outcome = False\nset_env =\n  API_TOKEN=fixture-sensitive-value\ncommands = pytest __styre_identity__.py\n`,
  });
  const obs = await qualifyTestEnvironment(r, c, { run: f.run });
  expect(obs.status).toBe("ready");
  expect(JSON.stringify(obs)).not.toContain("fixture-sensitive-value");
});

test("executed evidence retains fresh environment independently from frozen check plan", async () => {
  const r = fixture({ "uv.lock": "before" });
  const c = component(r);
  const fake = runner(r);
  await requireTestEnvironment(r, c, { run: fake.run });
  const plan = resolveCheckExecution({
    components: [c],
    testFile: "test_one.py",
    testName: "test_one",
  });
  writeFileSync(join(r, "uv.lock"), "after");
  const execution = await runCheckExecution({
    plan,
    components: [c],
    worktreePath: r,
    timeoutMs: 1000,
    run: async (cmd, opts) =>
      cmd.includes("test_one.py::test_one") ? result("1 passed") : fake.run(cmd, opts),
  });
  expect(execution.coarse).toBe("green");
  expect(execution.environment?.status).toBe("ready");
  expect(execution.environment?.fingerprint).not.toBe(plan.environmentFingerprint);
  c.testAction = { framework: "pytest", launcher: "python3 -m pytest -k unrelated" };
  let calls = 0;
  const stale = await runCheckExecution({
    plan,
    components: [c],
    worktreePath: r,
    timeoutMs: 1000,
    run: async () => {
      calls++;
      return result("1 passed");
    },
  });
  expect(stale.coarse).toBe("error");
  expect(calls).toBe(0);
});

test("a replay importing candidate source cannot report baseline behavioral evidence", async () => {
  const r = fixture({ "pkg/__init__.py": "" });
  const c = component(r);
  const plan = resolveCheckExecution({
    components: [c],
    testFile: "test_one.py",
    testName: "test_one",
  });
  const execution = await runCheckExecution({
    plan,
    components: [c],
    worktreePath: r,
    timeoutMs: 1000,
    run: runner(r, { source: "/candidate/pkg/__init__.py" }).run,
  });
  expect(execution.coarse).toBe("error");
  expect(execution.environment?.status).toBe("requires-preparation");
});
