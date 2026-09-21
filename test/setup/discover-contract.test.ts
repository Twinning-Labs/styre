import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { runSetup } from "../../src/cli/setup.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { type Component, isPrimary } from "../../src/dispatch/profile.ts";
import { unresolvedTestTargets } from "../../src/dispatch/test-target.ts";
import { DiscoverSchema, normalizeDiscovery } from "../../src/setup/discover-schema.ts";
import { discoverComponents } from "../../src/setup/discover.ts";
import { planTestEnvironment } from "../../src/testing/environment.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const unresolved = {
  unresolved:
    "No declared Python test framework. Select an existing runner or an explicit test-authoring workflow.",
};
function component(name: string, test: Component["commands"][string] = unresolved): Component {
  return { name, kind: "python", paths: [`${name}/**`], commands: { test }, extensions: [".py"] };
}
function runnerFor(payload: unknown) {
  return new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: `\`\`\`styre-setup-discover\n${JSON.stringify(payload)}\n\`\`\``,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
}
function proposal(name: string, commands: Record<string, unknown>, role = "primary") {
  return { name, paths: [`${name}/**`], commands, role };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test fixture value");
  return value;
}
const policy = { interactive: false, trustAgentCommands: true };

test("recorded Sphinx shape retains both fixture roles, unresolved observations and a valid primary command", async () => {
  const root = mkdtempSync(join(tmpdir(), "styre-discovery-contract-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "karma start --browsers Firefox --single-run" } }),
  );
  const scan = [
    { ...component("frontend", "npm run test"), kind: "node" as const },
    component("python", "git status"),
    component("tests-roots-test-setup"),
    component("tests-roots-test-theming"),
  ];
  const payload = {
    components: scan.map((c) =>
      proposal(c.name, c.commands, c.name.startsWith("tests-roots-") ? "fixture" : "primary"),
    ),
    repoCommands: {},
  };
  required(payload.components[1]).commands = { test: "git status --short" };
  const runner = runnerFor(payload);
  const out = await discoverComponents(
    root,
    { components: scan, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG },
    policy,
  );
  expect(out.warnings).toEqual([]);
  expect(out.components.filter(isPrimary).map((c) => c.name)).toEqual(["frontend", "python"]);
  expect(out.components[1]?.commands.test).toBe("git status --short");
  expect(out.components[2]?.commands.test).toEqual(unresolved);
  expect(out.components[3]?.commands.test).toEqual(unresolved);
  expect(unresolvedTestTargets({ ...out, components: out.components.slice(1) })).toEqual([]);
  const frontend = required(out.components[0]);
  frontend.testEnvironment = required(planTestEnvironment(root, frontend, "existing"));
  expect(frontend.testEnvironment.adapter).toBe("unsupported");
  const problems = unresolvedTestTargets(out);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toStartWith("frontend.test:");
  expect(runner.inputs).toHaveLength(1);
});

test("unavailable, altered and invented observations cannot replace primary commands, but valid metadata survives", async () => {
  for (const original of [unresolved, "git status"]) {
    for (const value of [
      { unavailable: true },
      { unresolved: "new assertion" },
      { unresolved: unresolved.unresolved, unavailable: true },
      42,
      null,
      [],
      "",
    ]) {
      const scan = [component("core", original), component("fixture")];
      const out = await discoverComponents(
        process.cwd(),
        { components: scan, repoCommands: {} },
        {
          runner: runnerFor({
            components: [proposal("core", { test: value }), proposal("fixture", {}, "fixture")],
          }),
          agentConfig: DEFAULT_AGENT_CONFIG,
        },
        policy,
      );
      expect(out.components[0]?.commands.test).toEqual(original);
      expect(isPrimary(required(out.components[0]))).toBe(true);
      expect(isPrimary(required(out.components[1]))).toBe(false);
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toContain("components[0].commands[0]");
      expect(out.warnings[0]).not.toContain("new assertion");
    }
  }
});

test("omission and exact echoes preserve every machine observation without authoring object overrides", () => {
  const scan = [component("core")];
  required(scan[0]).commands.build = { unavailable: true };
  for (const commands of [{}, required(scan[0]).commands]) {
    const normalized = normalizeDiscovery(
      scan,
      DiscoverSchema.parse({ components: [proposal("core", commands)] }),
    );
    expect(normalized.components[0]?.commands).toEqual({});
    expect(normalized.diagnostics).toEqual([]);
  }
});

test("unknown and duplicate identities cannot overwrite scanned components", async () => {
  const scan = [component("core")];
  const unknown = normalizeDiscovery(
    scan,
    DiscoverSchema.parse({ components: [proposal("ghost", {}, "fixture")] }),
  );
  expect(unknown.components).toEqual([]);
  expect(unknown.diagnostics[0]?.code).toBe("unknown-component");
  const out = await discoverComponents(
    process.cwd(),
    { components: scan, repoCommands: {} },
    {
      runner: runnerFor({
        components: [proposal("core", {}, "primary"), proposal("core", {}, "fixture")],
      }),
      agentConfig: DEFAULT_AGENT_CONFIG,
    },
    policy,
  );
  expect(out.components).toEqual(scan);
  expect(out.warnings[0]).toContain("components.[1].name: custom");
});

test("invalid repo slots do not discard classification or print rejected command values", async () => {
  const out = await discoverComponents(
    process.cwd(),
    { components: [component("fixture")], repoCommands: {} },
    {
      runner: runnerFor({
        components: [proposal("fixture", {}, "fixture")],
        repoCommands: { invalid: { secret: "do-not-print" }, integration: "git status" },
      }),
      agentConfig: DEFAULT_AGENT_CONFIG,
    },
    policy,
  );
  expect(isPrimary(required(out.components[0]))).toBe(false);
  expect(out.repoCommands).toEqual({ integration: "git status" });
  expect(out.warnings[0]).toContain("repoCommands[0]");
  expect(out.warnings.join()).not.toContain("do-not-print");
});

test("malformed JSON and metadata failures report locations without leaking input values", async () => {
  for (const text of [
    '```styre-setup-discover\n{"secret":"sensitive-marker",BROKEN}\n```',
    '```styre-setup-discover\n{"components":[{"name":"core","paths":["core/**"],"role":"sensitive-marker"}]}\n```',
  ]) {
    const runner = new FakeAgentRunner(() => ({
      completed: true,
      exitCode: 0,
      stdout: text,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    }));
    const scan = [component("core")];
    const out = await discoverComponents(
      process.cwd(),
      { components: scan, repoCommands: {} },
      { runner, agentConfig: DEFAULT_AGENT_CONFIG },
      policy,
    );
    expect(out.components).toEqual(scan);
    expect(out.warnings.join()).toContain("malformed");
    expect(out.warnings.join()).not.toContain("sensitive-marker");
  }
});

test("full setup persists fixture classification while still refusing the unsupported primary frontend", async () => {
  const root = mkdtempSync(join(tmpdir(), "styre-discovery-setup-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "./node_modules/.bin/karma start --browsers Firefox --single-run" },
    }),
  );
  writeFileSync(
    join(root, "pyproject.toml"),
    '[project]\nname="sample"\nversion="1.0"\n[tool.pytest.ini_options]\ntestpaths=["tests"]\n',
  );
  for (const dir of ["tests/roots/test-setup", "tests/roots/test-theming"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, "setup.py"),
      'from setuptools import setup\nsetup(name="fixture")\n',
    );
  }
  const runner = new FakeAgentRunner((input) => {
    const match = /Draft components \(JSON\): (.+)\n/.exec(input.prompt);
    const payload = match
      ? {
          components: (JSON.parse(match[1]) as Component[]).map((c) =>
            proposal(c.name, c.commands, c.dir?.startsWith("tests/roots/") ? "fixture" : "primary"),
          ),
          repoCommands: {},
        }
      : Object.fromEntries(
          [
            "topology",
            "data",
            "caching",
            "observability",
            "configSecrets",
            "documentation",
            "releasePackaging",
          ].map((k) => [k, { detail: "" }]),
        );
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`${match ? "styre-setup-discover" : "styre-setup-enrich"}\n${JSON.stringify(payload)}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const out = await runSetup({
    repo: root,
    out: join(root, "out/profile.json"),
    testEnvironment: "existing",
    trustAgentCommands: true,
    deps: { runner, agentConfig: DEFAULT_AGENT_CONFIG },
  });
  expect(out.profile.components.filter((c) => !isPrimary(c))).toHaveLength(2);
  expect(out.unresolvedCommands).toHaveLength(1);
  expect(out.unresolvedCommands[0]).toStartWith("frontend.test:");
  const persisted = JSON.parse(readFileSync(out.outPath, "utf8"));
  expect(persisted.components.filter((c: Component) => !isPrimary(c))).toHaveLength(2);
});
