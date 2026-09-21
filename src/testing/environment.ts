import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Component } from "../dispatch/profile.ts";
import { pythonImportName } from "../setup/lang/python.ts";
import { nodeManager } from "../setup/node-manager.ts";
import { resolveTestAction } from "../setup/test-action.ts";
import { runBoundedCommand } from "../util/run-bounded-command.ts";
import type { CmdRunner, CommandResult } from "../util/run-command.ts";
import { testCapabilities } from "./capabilities.ts";
import {
  type EnvironmentObservation,
  type TestEnvironmentPlan,
  TestEnvironmentPlanSchema,
} from "./environment-schema.ts";
import { karmaPlan, qualifyKarma } from "./karma.ts";

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const PYTHON_INVENTORY = `import sys,json,importlib.util,importlib.metadata as m
packages={}
for n in ['pytest','tox','tox-current-env','Django']:
 try: packages[n]=m.version(n)
 except m.PackageNotFoundError: packages[n]=None
data={'executable':sys.executable,'version':sys.version.split()[0],'packages':packages}`;
const NODE_INVENTORY = `const fs=require('fs'),path=require('path');const packages={};for(const name of ['jest','vitest','mocha','karma']){try{let file=require.resolve(name,{paths:[process.cwd()]});let dir=path.dirname(file);let version=null;while(dir!==path.dirname(dir)){const p=path.join(dir,'package.json');if(fs.existsSync(p)){const m=JSON.parse(fs.readFileSync(p));if(m.name===name){version=m.version;break;}}dir=path.dirname(dir);}packages[name]={path:file,version};}catch{packages[name]=null;}}console.log(JSON.stringify({executable:process.execPath,version:process.versions.node,packages}));`;
const FILES = [
  "package.json",
  "karma.conf.js",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc.yml",
  ".pnp.cjs",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "tox.ini",
  "tox.toml",
  "setup.cfg",
  "setup.py",
  "pytest.ini",
  "conftest.py",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
];

function probeEvidence(purpose: string, result: CommandResult & { truncated?: boolean }) {
  // Resolved tox configuration may contain substituted credentials in set_env or URLs.
  // Keep only structural facts, never the raw configuration or its error output.
  if (purpose === "resolved tox configuration") {
    const fields: Record<string, string> = {};
    for (const line of result.stdout.split("\n")) {
      const m = /^(runner|env_name|ignore_outcome)\s*=\s*([A-Za-z0-9_.-]*)$/.exec(line);
      if (m) fields[m[1]] = m[2];
    }
    return {
      purpose,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: JSON.stringify(fields),
      stderr: result.stderr
        ? "Tox configuration diagnostic withheld; inspect locally if needed"
        : "",
      truncated: result.truncated === true,
    };
  }
  const cap = 16384;
  const excerpt = (s: string) =>
    s.length <= cap ? s : `${s.slice(0, cap / 2)}\n[truncated]\n${s.slice(-cap / 2)}`;
  return {
    purpose,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: excerpt(result.stdout),
    stderr: excerpt(result.stderr),
    truncated:
      result.truncated === true || result.stdout.length > cap || result.stderr.length > cap,
  };
}

function fingerprint(repo: string, c: Component, runtime: Record<string, unknown>): string {
  const dirs = new Set([
    repo,
    join(repo, c.dir ?? "."),
    join(repo, c.testEnvironment?.workspaceDir ?? "."),
  ]);
  const files: Record<string, string> = {};
  for (const dir of dirs)
    for (const name of FILES) {
      const p = join(dir, name);
      if (existsSync(p)) files[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  return createHash("sha256")
    .update(
      JSON.stringify({
        host: hostname(),
        platform: process.platform,
        arch: process.arch,
        plan: c.testEnvironment,
        commands: c.commands,
        runtime,
        files,
      }),
    )
    .digest("hex");
}
function pythonCommand(c: Component): string {
  const command = c.testEnvironment?.suiteCommand ?? c.commands.test;
  if (typeof command === "string") {
    const m = /^(python(?:3(?:\.\d+)?)?)\s/.exec(command);
    if (m) return m[1];
  }
  return "python3";
}
export async function inspectTestRuntime(
  repo: string,
  c: Component,
  run: CmdRunner = runBoundedCommand,
): Promise<EnvironmentObservation> {
  const cwd = join(repo, c.dir ?? ".");
  const python = c.kind === "python";
  const toxManaged =
    c.testEnvironment?.policy === "managed" &&
    / -m tox -e (py\d+)$/.exec(c.testEnvironment.suiteCommand);
  const interp = toxManaged
    ? shellQuote(join(cwd, ".tox", toxManaged[1], "bin", "python"))
    : pythonCommand(c);
  const command = python
    ? `${interp} -c ${shellQuote(`${PYTHON_INVENTORY}\nprint(json.dumps(data))`)}`
    : `node -e ${shellQuote(NODE_INVENTORY)}`;
  const out = await run(command, { cwd, timeoutMs: 15_000 });
  let runtime: Record<string, unknown> = {};
  let reason: string | undefined;
  try {
    if (out.exitCode !== 0 || out.timedOut) throw Error("Runtime inspection failed");
    runtime = JSON.parse(out.stdout);
    if (
      typeof runtime.executable !== "string" ||
      typeof runtime.version !== "string" ||
      !runtime.packages
    )
      throw Error("Malformed runtime observation");
  } catch (e) {
    reason = String(e);
  }
  const sha = await run("git rev-parse HEAD", { cwd: repo, timeoutMs: 5000 });
  return {
    version: 1,
    component: c.name,
    phase: "inventory",
    status: reason ? "requires-preparation" : "ready",
    reason,
    cwd,
    sourceSha: sha.exitCode === 0 ? sha.stdout.trim() : null,
    fingerprint: fingerprint(repo, c, runtime),
    runtime,
    probes: [probeEvidence("runtime inventory", out), probeEvidence("source revision", sha)],
  };
}

/** Build portable intent. This never selects existing-env policy merely because a plugin exists. */
export function planTestEnvironment(
  repo: string,
  c: Component,
  policy: "managed" | "existing",
): TestEnvironmentPlan | undefined {
  if (!["python", "node", "sveltekit"].includes(c.kind) || typeof c.commands.test !== "string")
    return undefined;
  const command = c.commands.test;
  const base = { version: 1 as const, policy, suiteCommand: command, workspaceDir: c.dir ?? "." };
  if (c.kind === "python") {
    const tox = /^python3 -m tox -e (py\d+)( --current-env --no-provision)?$/.exec(command);
    if (tox && ((policy === "existing" && tox[2]) || (policy === "managed" && !tox[2])))
      return TestEnvironmentPlanSchema.parse({
        ...base,
        adapter: "python",
        framework: "pytest",
        checkLauncher: `${command}${policy === "managed" ? " --no-provision" : ""} --`,
      });
    if (
      /^(?:python3?|python3\.\d+) -m pytest(?: -q| -v| --verbose| --strict-markers)*$/.test(command)
    )
      return TestEnvironmentPlanSchema.parse({
        ...base,
        adapter: "python",
        framework: "pytest",
        checkLauncher: command,
      });
    if (
      /^python3? \.\/tests\/runtests\.py --parallel 1$/.test(command) &&
      c.testAction?.framework === "django-runtests"
    )
      return TestEnvironmentPlanSchema.parse({
        ...base,
        adapter: "python",
        framework: "django-runtests",
        checkLauncher: command,
      });
    return {
      ...base,
      adapter: "unsupported",
      reason:
        "Python suite requires an explicit supported single-check context (python -m pytest, Django runner, or a single current-env tox target under existing policy).",
    };
  }
  const selection = nodeManager(repo, join(repo, c.dir ?? "."));
  const moduleDir = join(repo, c.dir ?? ".");
  const action = resolveTestAction(moduleDir, command);
  const scriptName = /^(?:npm|pnpm|yarn|bun) (?:run )?([\w:.-]+)$/.exec(command)?.[1];
  const pkg = existsSync(join(moduleDir, "package.json"))
    ? JSON.parse(readFileSync(join(moduleDir, "package.json"), "utf8"))
    : {};
  const body = scriptName ? pkg.scripts?.[scriptName] : undefined;
  const karma = karmaPlan(repo, c, policy);
  if (karma) return karma;
  // Scope/filter arguments cannot leak into authored checks. Unknown wrappers need their own adapter.
  if (
    typeof body !== "string" ||
    !/^(?:jest|vitest|mocha)(?: (?:--(?:config|require|timeout|ui|reporter) [\w./-]+|--(?:runInBand|exit|silent|no-cache)))*$/.test(
      body,
    )
  )
    return {
      ...base,
      adapter: "unsupported",
      reason:
        "Test script needs a supported single-framework launcher without suite paths, filters, shell wrappers, or watch/run subcommands.",
    };
  if (!selection.manager || !action || !["jest", "vitest", "mocha"].includes(action.framework))
    return {
      ...base,
      adapter: "unsupported",
      reason:
        selection.reason ??
        "Cannot qualify the Node test framework/launcher; retain the wrapper and declare its test context.",
    };
  if (existsSync(join(repo, selection.workspaceDir, ".pnp.cjs")))
    return {
      ...base,
      adapter: "unsupported",
      reason:
        "Yarn PnP requires a manager-loader probe; this adapter currently qualifies node_modules installs only.",
    };
  const prefix = command.trim().split(/\s+/)[0];
  if (prefix !== selection.manager)
    return {
      ...base,
      adapter: "unsupported",
      reason: "Test command and declared package manager disagree.",
    };
  if (
    pkg.scripts?.[`pre${scriptName}`] ||
    pkg.scripts?.[`post${scriptName}`] ||
    (selection.manager === "bun" && pkg.scripts?.[action.framework])
  )
    return {
      ...base,
      adapter: "unsupported",
      reason: "Script lifecycle hooks or executable-name scripts require a dedicated check adapter",
    };
  return TestEnvironmentPlanSchema.parse({
    ...base,
    adapter: "node",
    manager: selection.manager,
    managerVersion: selection.version,
    workspaceDir: selection.workspaceDir,
    framework: action.framework,
    checkLauncher: action.launcher,
  });
}

/** Inspect resolved tox configuration, never execute its install or test commands. */
export async function preparedToxCandidate(
  repo: string,
  c: Component,
  inventory: EnvironmentObservation,
  run: CmdRunner = runBoundedCommand,
): Promise<string | undefined> {
  if (c.kind !== "python" || inventory.status !== "ready") return;
  const packages = inventory.runtime.packages as Record<string, string | null>;
  if (!packages.tox || !packages["tox-current-env"] || !packages.pytest) return;
  const version = String(inventory.runtime.version).split(".");
  const target = `py${version[0]}${version[1]}`;
  // The interpreter is explicit so tox and its plugin cannot resolve through another PATH entry.
  const command = `python3 -m tox -e ${target} --current-env --no-provision`;
  const inspect: CmdRunner = async (cmd, opts) => {
    const out = await run(cmd, opts);
    inventory.probes ??= [];
    inventory.probes.push(probeEvidence("resolved tox configuration", out));
    return out;
  };
  const problem = await toxProblem(repo, c, command, inventory, inspect);
  if (problem) {
    inventory.reason = `No automatic tox target: ${problem}`;
    return;
  }
  return command;
}

async function toxProblem(
  repo: string,
  c: Component,
  command: string,
  inventory: EnvironmentObservation,
  run: CmdRunner,
): Promise<string | undefined> {
  const match = /^python3 -m tox -e (py\d+)( --current-env --no-provision)?$/.exec(command);
  if (!match) return "Unsupported tox context";
  const version = String(inventory.runtime.version).split(".");
  if (match[1] !== `py${version[0]}${version[1]}`)
    return "Selected tox Python does not match the measured interpreter";
  const packages = inventory.runtime.packages as Record<string, string | null>;
  const current = !!match[2];
  if (current && (!packages?.["tox-current-env"] || !packages.tox?.startsWith("4.")))
    return "Requires an observed tox 4/current-env plugin";
  if (!command.startsWith("python3 -m tox"))
    return "Use python3 -m tox so the measured interpreter owns the plugin";
  const r = await run(
    `${command}${current ? "" : " --no-provision"} --showconfig -- __styre_identity__.py`,
    {
      cwd: join(repo, c.dir ?? "."),
      timeoutMs: 15000,
    },
  );
  if (r.exitCode !== 0 || r.timedOut) return "Could not resolve selected tox configuration";
  const fields: Record<string, string[]> = {};
  let key = "";
  for (const line of r.stdout.split("\n")) {
    const m = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (m) {
      key = m[1];
      fields[key] = m[2] ? [m[2]] : [];
    } else if (line.startsWith(" ") && key && line.trim()) fields[key].push(line.trim());
    else if (line.trim()) key = "";
  }
  if (
    fields.runner?.join("") !== (current ? "current-env" : "virtualenv") ||
    fields.env_name?.join("") !== match[1]
  )
    return "Tox resolved a different execution context";
  if (fields.depends?.length || fields.commands_pre?.length || fields.commands_post?.length)
    return "Additional tox commands/dependencies require qualification";
  if (fields.change_dir?.join("") !== join(repo, c.dir ?? "."))
    return "Tox changes the component working directory";
  if (fields.ignore_outcome?.join("") !== "False") return "Tox must preserve test failures";
  if (
    fields.commands?.length !== 1 ||
    !/^(?:python -m )?pytest(?: (?:-q|-v|-rA|--durations \d+))* __styre_identity__\.py$/.test(
      fields.commands[0],
    )
  )
    return "Tox must forward the exact check selector to one pytest command without default paths or filters";

  return;
}

/** Validate intent without executing project code or installing anything. */
export function testEnvironmentProblem(repo: string, c: Component): string | undefined {
  const plan = c.testEnvironment;
  if (!plan) return "No test environment plan";
  if (!TestEnvironmentPlanSchema.safeParse(plan).success) return "Malformed test environment plan";
  if (plan.adapter === "unsupported") return plan.reason;
  if (plan.suiteCommand !== c.commands.test)
    return "Test command changed without requalifying its plan";
  const current = planTestEnvironment(repo, c, plan.policy);
  if (
    JSON.stringify(current && TestEnvironmentPlanSchema.parse(current)) !==
    JSON.stringify(TestEnvironmentPlanSchema.parse(plan))
  )
    return "Test environment intent differs from current declarations; rerun setup";
  const capability = testCapabilities(plan, c.testPolicy);
  if (capability.authoredChecks === "unsupported")
    return c.testAction
      ? "Suite-only plan cannot authorize an authored-check action; rerun setup"
      : undefined;
  if (
    c.testAction?.framework !== capability.framework ||
    c.testAction?.launcher !== capability.launcher ||
    c.testAction?.selectorDir
  )
    return "Single-check launcher differs from qualified suite context; rerun setup";
}

export async function qualifyTestEnvironment(
  repo: string,
  c: Component,
  opts: { collect?: boolean; run?: CmdRunner } = {},
): Promise<EnvironmentObservation> {
  const execute = opts.run ?? runBoundedCommand;
  const probes: NonNullable<EnvironmentObservation["probes"]> = [];
  const run: CmdRunner = async (command, options) => {
    const result = await execute(command, options);
    const purpose = command.includes("--showconfig")
      ? "resolved tox configuration"
      : command.includes("_styre_environment_probe.py")
        ? "selected launcher runtime"
        : command.includes("--collect-only") ||
            command.includes("--listTests") ||
            command.includes("--dry-run") ||
            command.includes("list --json")
          ? "collection"
          : command.includes("--version")
            ? "manager version"
            : command === "git rev-parse HEAD"
              ? "source revision"
              : "runtime inventory";
    probes.push(probeEvidence(purpose, result));
    return result;
  };
  const obs = await inspectTestRuntime(repo, c, run);
  obs.probes = probes;
  obs.phase = "qualification";
  const plan = c.testEnvironment;
  const fail = (status: EnvironmentObservation["status"], reason: string) => ({
    ...obs,
    status,
    reason,
  });
  const problem = testEnvironmentProblem(repo, c);
  if (problem) return fail(plan?.adapter === "unsupported" ? "unsupported" : "error", problem);
  if (!plan || plan.adapter === "unsupported")
    return fail("unsupported", "No supported test environment plan");
  obs.runtime.capabilities = testCapabilities(plan, c.testPolicy);
  if (obs.status !== "ready") return obs;
  if (plan.adapter === "karma") {
    const qualified = await qualifyKarma(obs.cwd, plan, run);
    obs.runtime.karma = qualified.evidence;
    obs.fingerprint = fingerprint(repo, c, obs.runtime);
    return {
      ...obs,
      status: qualified.ready ? "ready" : "requires-preparation",
      reason: qualified.reason,
    };
  }
  if (plan.adapter === "python") {
    if (plan.suiteCommand.includes("tox")) {
      const problem = await toxProblem(repo, c, plan.suiteCommand, obs, run);
      if (problem) return fail("error", problem);
    }
    // Observe the selected launcher itself. In particular, tox can change PATH, Python or
    // PYTHONPATH; an outer-interpreter import does not prove its execution context.
    const module = pythonImportName(join(repo, c.dir ?? "."));
    if (plan.framework === "pytest") {
      const dir = mkdtempSync(join(tmpdir(), "styre-env-"));
      const probe = join(dir, "_styre_environment_probe.py");
      try {
        const source =
          module && /^[A-Za-z_]\w*$/.test(module)
            ? `s=importlib.util.find_spec(${JSON.stringify(module)}); source=None if s is None else s.origin`
            : "source=None";
        writeFileSync(
          probe,
          `${PYTHON_INVENTORY}\n${source}\ndata['source']=source\nprint('STYRE_ENVIRONMENT_JSON='+json.dumps(data))\n`,
          { mode: 0o600 },
        );
        const result = await run(
          `${plan.checkLauncher} ${shellQuote(probe)} --collect-only -q -s`,
          { cwd: obs.cwd, timeoutMs: 30000 },
        );
        const records = result.stdout
          .split("\n")
          .filter((line) => line.startsWith("STYRE_ENVIRONMENT_JSON="));
        if (result.timedOut || ![0, 5].includes(result.exitCode ?? -1) || records.length !== 1)
          return fail(
            "error",
            "Selected test launcher did not produce exactly one bounded runtime observation",
          );
        const runtime = JSON.parse(records[0].slice("STYRE_ENVIRONMENT_JSON=".length));
        if (
          typeof runtime.executable !== "string" ||
          typeof runtime.version !== "string" ||
          !runtime.packages?.pytest
        )
          return fail("error", "Malformed selected-launcher observation");
        if (plan.suiteCommand.includes("tox")) {
          const target = / -e (py\d+)/.exec(plan.suiteCommand)?.[1];
          if (target !== `py${runtime.version.split(".").slice(0, 2).join("")}`)
            return fail("error", "Tox launched a different Python version than its target");
        }
        obs.runtime = {
          ...runtime,
          sourceBinding: module ? "current-checkout" : "no-importable-package-declared",
        };
      } catch {
        return fail("error", "Could not read selected-launcher evidence");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      // Django's runner uses the declared interpreter directly, with no orchestrator wrapper.
      const script = `import importlib.util,json; s=importlib.util.find_spec('django'); print(json.dumps({'source':None if s is None else s.origin}))`;
      const r = await run(`${pythonCommand(c)} -c ${shellQuote(script)}`, {
        cwd: obs.cwd,
        timeoutMs: 15000,
      });
      try {
        obs.runtime.source = JSON.parse(r.stdout).source;
      } catch {
        return fail("error", "Django source inspection failed");
      }
      if (r.exitCode !== 0 || r.timedOut) return fail("error", "Django source inspection failed");
    }
    if (
      module &&
      (typeof obs.runtime.source !== "string" ||
        !resolve(obs.runtime.source).startsWith(`${resolve(repo, c.dir ?? ".")}/`))
    )
      return fail(
        "requires-preparation",
        "Selected test launcher imports Python source outside the current component checkout",
      );
  } else {
    const packages = obs.runtime.packages as Record<string, unknown>;
    if (!plan.framework || !packages[plan.framework])
      return fail(
        "requires-preparation",
        "Selected Node framework is not resolvable from this component",
      );
    const manager = await run(`COREPACK_ENABLE_NETWORK=0 ${plan.manager} --version`, {
      cwd: join(repo, plan.workspaceDir),
      timeoutMs: 15000,
    });
    if (manager.exitCode !== 0 || manager.timedOut)
      return fail("requires-preparation", "Declared package manager is unavailable");
    const actual = manager.stdout.trim();
    obs.runtime.manager = { name: plan.manager, version: actual };
    if (plan.managerVersion && actual !== plan.managerVersion)
      return fail("error", "Installed package-manager version differs from the declaration");
    const current = planTestEnvironment(repo, c, plan.policy);
    if (
      current?.adapter !== "node" ||
      current.framework !== plan.framework ||
      current.checkLauncher !== plan.checkLauncher
    )
      return fail("error", "Node script/framework changed; rerun setup");
  }
  obs.fingerprint = fingerprint(repo, c, obs.runtime);
  if (!opts.collect) return obs;
  let command: string;
  switch (plan.framework) {
    case "pytest":
      command = `${plan.checkLauncher} --collect-only -q`;
      break;
    case "jest":
      command = `${plan.checkLauncher} --listTests --json --runInBand`;
      break;
    case "vitest":
      command = `${plan.checkLauncher} list --json`;
      break;
    case "mocha":
      command = `${plan.checkLauncher} --dry-run --reporter json`;
      break;
    default:
      return obs; // Django has no collection-only CLI; capability remains separate from verdict.
  }
  const r = await run(command, { cwd: obs.cwd, timeoutMs: 60000 });
  let count: number | null = null;
  if (plan.framework === "pytest") {
    const m = /(\d+) tests? collected/.exec(r.stdout);
    if (m) count = Number(m[1]);
    else if (r.exitCode === 5) count = 0;
  } else {
    try {
      const text = r.stdout.trim();
      const json = JSON.parse(
        text.slice(Math.min(...[text.indexOf("["), text.indexOf("{")].filter((n) => n >= 0))),
      );
      count = Array.isArray(json) ? json.length : (json.stats?.tests ?? null);
    } catch {
      /* unrecognized output is explicit below */
    }
  }
  obs.collection = { count, exitCode: r.exitCode, timedOut: r.timedOut };
  if (
    r.timedOut ||
    r.exitCode === null ||
    (r.exitCode !== 0 && !(plan.framework === "pytest" && r.exitCode === 5)) ||
    count === null
  )
    return fail("error", "Collection did not produce a qualified test inventory");
  obs.status = count === 0 ? "empty" : "ready";
  return obs;
}

const observations = new WeakMap<Component, EnvironmentObservation>();
export function observedEnvironment(c: Component): EnvironmentObservation | undefined {
  return observations.get(c);
}
export async function requireTestEnvironment(
  repo: string,
  c: Component,
  opts: { collect?: boolean; run?: CmdRunner } = {},
): Promise<EnvironmentObservation | undefined> {
  if (!c.testEnvironment) return undefined; // legacy profiles are explicitly unqualified, never fabricated observations
  const observation = await qualifyTestEnvironment(repo, c, opts);
  observations.set(c, observation);
  return observation;
}
