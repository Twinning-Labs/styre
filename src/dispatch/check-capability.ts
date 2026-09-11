import { type CheckFramework, frameworkFor, launcherFor } from "./check-selector.ts";
import type { Component } from "./profile.ts";
import { resolvePythonInterpreter } from "./provision.ts";
import type { CmdRunner } from "./reuse.ts";

/**
 * CAN STYRE ACTUALLY RUN A CHECK FOR THIS COMPONENT? (ENG-426)
 *
 * WHY THIS EXISTS. `probeCommandExists` — the toolchain preflight's probe — answers "is the
 * leading program on PATH". For `python3 -m pytest` the leading program is `python3`, which is
 * always there, so the probe is STRUCTURALLY INCAPABLE of noticing that pytest is not installed.
 * `resolvePythonInterpreter` has the same shape: it proves an interpreter exists, never that the
 * framework does.
 *
 * On django__django-12325 that blindness cost a whole run. `frameworkFor` returns `pytest` for
 * every python component unconditionally, `binaryFor` built `python3 -m pytest`, no probe could
 * see that django's image ships no pytest (true of the OFFICIAL SWE-bench image too — django's
 * runner is `./tests/runtests.py`), and the gap surfaced only as a RED-first failure reading
 * `No module named pytest`. That was classified `environmental` — correctly — which made it
 * permanently advisory, and the run went on to spend $6.42 and open a pull request on the
 * strength of no executed evidence at all.
 *
 * A probe cannot make that check runnable; resolving the real runner is a separate piece of work.
 * What it can do is turn a discovery made at tick 16, for $6.42, into one made before the
 * authoring agent is ever dispatched — with a reason that names the framework instead of leaving
 * `No module named pytest` buried in a raw output blob.
 *
 * IT RUNS A COMMAND, DELIBERATELY. Existence on PATH is exactly the question that was already
 * being asked and already being answered wrongly. The probe commands below are version/loader
 * invocations: they must not run tests, write files, or take meaningful time.
 */
export interface CapabilityProbe {
  component: string;
  /** The framework styre resolved for this component, or `null` when it could resolve none. */
  framework: CheckFramework | null;
  /** True iff styre can execute a check here. `false` with `framework: null` means the framework
   *  itself was unresolvable — a different failure, reported as such. */
  runnable: boolean;
  /** The command tried and what came back — the operator-facing reason. */
  detail: string;
}

/**
 * The cheapest invocation that proves a framework can run, WITHOUT running a test.
 *
 * `--version` appended to the launcher covers most frameworks because the launcher is the
 * framework's own entry point. Two do not, and both are called out rather than left to fail
 * confusingly:
 *  - `go`'s launcher is `go test`, and `go test --version` is not a thing — `go version` is.
 *  - `minitest`'s launcher is `ruby -Itest`, so `--version` would prove only that Ruby exists,
 *    which is the exact mistake this module was written to stop making. Require the library.
 */
export function capabilityCommandFor(fw: CheckFramework, launcher: string): string {
  if (fw === "go") return "go version";
  if (fw === "minitest") return `${launcher} -e "require 'minitest/autorun'"`;
  return `${launcher} --version`;
}

const PROBE_TIMEOUT_MS = 60_000;

/** Probe one component. Never throws — an unresolvable framework and a failed probe are both
 *  ANSWERS, and a probe that crashed the run would be worse than the blindness it replaces. */
export async function probeComponent(
  component: Component,
  opts: { worktreePath: string; run?: CmdRunner },
): Promise<CapabilityProbe> {
  const fw = frameworkFor(component);
  if (!fw) {
    return {
      component: component.name,
      framework: null,
      runnable: false,
      detail: `no test framework could be resolved for component \`${component.name}\` (${component.kind})`,
    };
  }
  let interp: string | undefined;
  if (fw === "pytest") {
    try {
      interp = resolvePythonInterpreter();
    } catch {
      return {
        component: component.name,
        framework: fw,
        runnable: false,
        detail: `no python interpreter is on PATH, so \`pytest\` cannot be invoked for component \`${component.name}\``,
      };
    }
  }
  const command = capabilityCommandFor(fw, launcherFor(component, fw, { interp }));
  const { runCommand } = await import("../util/run-command.ts");
  const cwd = `${opts.worktreePath}${component.dir ? `/${component.dir}` : ""}`;
  const out = await (opts.run ?? runCommand)(command, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  const runnable = out.exitCode === 0;
  return {
    component: component.name,
    framework: fw,
    runnable,
    detail: runnable
      ? `\`${command}\` succeeded`
      : `\`${command}\` failed (exit ${out.exitCode ?? "timeout"}): ${`${out.stdout}\n${out.stderr}`.trim().slice(0, 300)}`,
  };
}

/** Probe every component that could own an authored check. Sequential on purpose: these are
 *  sub-second version calls, and a parallel spawn storm on a constrained box is not worth it. */
export async function probeCheckCapability(
  components: Component[],
  opts: { worktreePath: string; run?: CmdRunner },
): Promise<CapabilityProbe[]> {
  const out: CapabilityProbe[] = [];
  for (const c of components) out.push(await probeComponent(c, opts));
  return out;
}

/** The stderr/PR sentence for components that cannot run a check. */
export function formatIncapable(probes: CapabilityProbe[]): string {
  return probes
    .filter((p) => !p.runnable)
    .map((p) => `- ${p.component}: ${p.detail}`)
    .join("\n");
}
