import { isAbsolute, join, posix, resolve } from "node:path";
import { z } from "zod";
import { observedEnvironment } from "../testing/environment.ts";
import type { CommandResult } from "../util/run-command.ts";
import {
  type CoarseOrNone,
  buildCheckSelector,
  buildFileSelector,
  djangoLabel,
  djangoTestName,
  frameworkFor,
  interpretRunOutput,
  launcherFor,
} from "./check-selector.ts";
import { impactedComponents } from "./components.ts";
import { CheckFrameworkEnum, type Component } from "./profile.ts";

const repoPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !isAbsolute(p) &&
      !p.includes("\\") &&
      p.split("/").every((s) => s !== ".." && s !== "." && s !== ""),
    "expected a normalized repository-relative path",
  );
const repoDir = z.union([z.literal("."), repoPath]);
/** Persist with the RED-first signal. Never reconstruct a selector under a different cwd or launcher. */
export const CheckExecutionPlanSchema = z
  .object({
    version: z.literal(1),
    environmentFingerprint: z.string().optional(),
    component: z.string().min(1),
    framework: CheckFrameworkEnum,
    cwd: repoDir,
    selectorCwd: repoDir,
    testFile: repoPath,
    testName: z.string().min(1).optional(),
    launcher: z.string().min(1),
    runArgs: z.string().min(1),
  })
  .strict();
export type CheckExecutionPlan = z.infer<typeof CheckExecutionPlanSchema>;

/** A nested owner wins over an enclosing aggregate. Equal specificity is ambiguous, never first-wins. */
export function checkOwner(components: Component[], testFile: string): Component {
  repoPath.parse(testFile);
  const owners = impactedComponents(components, [testFile]).filter(
    (c) => !c.dir || c.dir === "." || testFile.startsWith(`${c.dir}/`),
  );
  const depth = Math.max(
    -1,
    ...owners.map((c) => (c.dir && c.dir !== "." ? c.dir.split("/").length : 0)),
  );
  const closest = owners.filter(
    (c) => (c.dir && c.dir !== "." ? c.dir.split("/").length : 0) === depth,
  );
  if (closest.length !== 1)
    throw new Error(
      `test ${testFile} requires one component owner; found ${closest.map((c) => c.name).join(", ") || "none"}`,
    );
  return closest[0];
}

export function executionDirectories(component: Component): { cwd: string; selectorCwd: string } {
  const cwd = component.dir ?? ".";
  repoDir.parse(cwd);
  const selectorDir = component.testAction?.selectorDir ?? ".";
  if (isAbsolute(selectorDir) || selectorDir.includes("\\"))
    throw new Error("testAction.selectorDir must be relative to the component directory");
  const selectorCwd = posix.normalize(posix.join(cwd, selectorDir)).replace(/\/$/, "") || ".";
  repoDir.parse(selectorCwd); // rejects leaving the repository
  return { cwd, selectorCwd };
}

export function resolveCheckExecution(p: {
  components: Component[];
  testFile: string;
  testName?: string;
  interp?: string;
}): CheckExecutionPlan {
  const component = checkOwner(p.components, p.testFile);
  const framework = frameworkFor(component);
  if (!framework)
    throw new Error(
      `component ${component.name} has no qualified test framework; run styre setup or configure testAction`,
    );
  const dirs = executionDirectories(component);
  const file = posix.relative(dirs.selectorCwd, p.testFile);
  let runArgs =
    p.testName === undefined
      ? buildFileSelector(framework, file)
      : buildCheckSelector(framework, { testFile: file, testName: p.testName }).runArgs;
  // Mocha wrappers may contain default globs. The report must identify the requested tests;
  // another file/title (or a hook failure) cannot stand in for evidence about ours.
  if (framework === "mocha")
    runArgs += " --reporter json --no-dry-run --no-parallel --no-bail --no-invert";
  if (framework === "django-runtests") runArgs += " --verbosity 2";
  return CheckExecutionPlanSchema.parse({
    version: 1,
    component: component.name,
    environmentFingerprint: observedEnvironment(component)?.fingerprint,
    framework,
    ...dirs,
    testFile: p.testFile,
    ...(p.testName === undefined ? {} : { testName: p.testName }),
    launcher: launcherFor(component, framework, { interp: p.interp }),
    runArgs,
  });
}

export interface ExecutionVerdict {
  coarse: CoarseOrNone;
  reason?: string;
  behavioralFailure?: boolean;
}
const error = (reason: string): ExecutionVerdict => ({ coarse: "error", reason });
const none = (reason: string): ExecutionVerdict => ({ coarse: "selected-none", reason });
const mochaTest = z.object({
  fullTitle: z.string(),
  file: z.string(),
  err: z.record(z.string(), z.unknown()).optional(),
});
const mochaReport = z.object({
  stats: z.object({
    tests: z.number().int().nonnegative(),
    passes: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  tests: z.array(mochaTest),
  passes: z.array(mochaTest),
  failures: z.array(mochaTest),
  pending: z.array(mochaTest),
});

function mochaVerdict(
  plan: CheckExecutionPlan,
  out: CommandResult,
  root: string,
): ExecutionVerdict {
  // The executor reads a fresh runner-owned reporter file, separate from package-manager
  // banners, test console output, and completion footers.
  let report: z.infer<typeof mochaReport> | undefined;
  try {
    const parsed = mochaReport.safeParse(JSON.parse(out.stdout));
    if (parsed.success) report = parsed.data;
  } catch {
    /* malformed/incomplete reporter output */
  }
  if (!report) return error("Mocha did not produce a complete JSON test report");
  const { stats, tests, passes, failures, pending } = report;
  if (
    stats.tests !== tests.length ||
    stats.passes !== passes.length ||
    stats.failures !== failures.length ||
    stats.pending !== pending.length
  )
    return error("Mocha report counts disagree");
  const path = (t: z.infer<typeof mochaTest>) => resolve(root, plan.selectorCwd, t.file);
  const key = (t: z.infer<typeof mochaTest>) => JSON.stringify([path(t), t.fullTitle]);
  const testKeys = new Set(tests.map(key));
  const passKeys = new Set(passes.map(key));
  const failKeys = new Set(failures.map(key));
  const pendingKeys = new Set(pending.map(key));
  // Mocha counts FAIL events, not distinct tests. A test may emit more than one failure
  // (observed in MUI 39353). Validate the event counts, then reconcile distinct test identities.
  // Hooks are failure events without a corresponding completed test and cannot count as RED.
  const outcomes = [...passKeys, ...failKeys, ...pendingKeys];
  if (
    testKeys.size !== tests.length ||
    passKeys.size !== passes.length ||
    pendingKeys.size !== pending.length ||
    new Set(outcomes).size !== outcomes.length ||
    outcomes.length !== tests.length ||
    outcomes.some((k) => !testKeys.has(k))
  )
    return error(
      "Mocha report has duplicate identities, hook failures, or incomplete test outcomes",
    );
  if ((failures.length === 0) !== (out.exitCode === 0))
    return error("Mocha exit status disagrees with its test report");
  const expected = resolve(root, plan.testFile);
  const matches = (t: z.infer<typeof mochaTest>) =>
    path(t) === expected && (plan.testName === undefined || t.fullTitle === plan.testName);
  if (plan.testName !== undefined && tests.some((t) => !matches(t)))
    return error("Mocha executed an unexpected file or test identity");
  // File-scoped binding may inherit a wrapper's suite globs. Evaluate only this file's rows;
  // unrelated passing/failing tests never substitute for evidence about the delivered file.
  const targetTests = tests.filter(matches);
  const targetPasses = passes.filter(matches);
  const targetFailures = failures.filter(matches);
  if (targetTests.length === 0 || targetPasses.length + targetFailures.length === 0)
    return none("Mocha executed no non-pending target test");
  if (plan.testName !== undefined && targetTests.length !== 1)
    return error("Mocha test identity is not unique");
  if (targetFailures.length > 0)
    return {
      coarse: "red",
      behavioralFailure: targetFailures.every(
        (t) =>
          t.err?.code === "ERR_ASSERTION" ||
          t.err?.name === "AssertionError" ||
          (typeof t.err?.stack === "string" && /^AssertionError(?:\b|:)/.test(t.err.stack)),
      ),
    };
  if (pending.some(matches)) return error("Mocha did not execute every test in the requested file");
  return { coarse: "green" };
}

function djangoVerdict(
  plan: CheckExecutionPlan,
  out: CommandResult,
  root: string,
): ExecutionVerdict {
  const text = `${out.stdout}\n${out.stderr}`;
  const module = djangoLabel(posix.relative(plan.selectorCwd, plan.testFile));
  const identity =
    plan.testName === undefined ? undefined : `${module}.${djangoTestName(plan.testName)}`;
  const cases = [
    ...text.matchAll(
      /^([\p{ID_Start}_][\p{ID_Continue}_]*) \(([^)]+)\)(?:\r?\n[^\n]*?)? \.\.\. (ok|FAIL|ERROR|skipped[^\r\n]*|expected failure|unexpected success)\s*$/gmu,
    ),
  ];
  const count = /\bRan (\d+) tests? in\b/.exec(text);
  if (!count || Number(count[1]) !== cases.length)
    return error("Django did not report a complete set of test identities");
  for (const c of cases) {
    const id = c[2].endsWith(`.${c[1]}`) ? c[2] : `${c[2]}.${c[1]}`;
    if (identity ? id !== identity : !id.startsWith(`${module}.`))
      return error("Django executed an unexpected test identity");
  }
  if (identity && cases.length > 1) return error("Django test identity is not unique");
  const executed = cases.filter((c) => c[3] === "ok" || c[3] === "FAIL" || c[3] === "ERROR");
  if (!executed.length) return none("Django executed no non-skipped target test");
  if (cases.some((c) => c[3] === "ERROR")) return error("Django reported a test or fixture error");
  if (cases.some((c) => c[3] === "FAIL") && out.exitCode === 1) {
    const failed = cases.filter((c) => c[3] === "FAIL");
    const sections = text.split(/^={5,}\r?$/m).filter((s) => /^\s*FAIL:/m.test(s));
    const expectedFile = resolve(root, plan.testFile);
    // unittest reports fixture assertions as FAIL too. Require every failed test's final
    // traceback to include its actual body in the target file; setUp/tearDown failures and
    // abbreviated/custom reports remain unproven, rather than manufacturing regression binding.
    const bodyFailures = failed.every((c) =>
      sections.some((section) => {
        const header = /^\s*FAIL: ([^ ]+) \(([^)]+)\)/m.exec(section);
        if (!header || header[1] !== c[1] || header[2] !== c[2]) return false;
        const trace = section.split("Traceback (most recent call last):").at(-1) ?? "";
        return [...trace.matchAll(/File "([^"]+)", line \d+, in ([^\r\n]+)/g)].some(
          (frame) =>
            frame[2].trim() === c[1] && resolve(root, plan.selectorCwd, frame[1]) === expectedFile,
        );
      }),
    );
    return { coarse: "red", behavioralFailure: sections.length === failed.length && bodyFailures };
  }
  if (cases.every((c) => c[3] === "ok") && out.exitCode === 0) return { coarse: "green" };
  return error("Django exit status or skipped tests prevent a verified result");
}

/** Infrastructure failure and zero selection are never behavioral RED or GREEN. */
export function interpretCheckExecution(
  plan: CheckExecutionPlan,
  out: CommandResult,
  worktreePath: string,
): ExecutionVerdict {
  if (out.timedOut || out.exitCode === null || out.exitCode === 126 || out.exitCode === 127)
    return error("test process timed out or could not be launched");
  if (plan.framework === "mocha") return mochaVerdict(plan, out, worktreePath);
  if (plan.framework === "django-runtests") return djangoVerdict(plan, out, worktreePath);
  if (
    plan.framework === "pytest" &&
    out.exitCode === 0 &&
    !/(?:^|[\s,=])[1-9]\d* passed\b/m.test(`${out.stdout}\n${out.stderr}`)
  )
    return none("pytest reported no passing executed test");
  return { coarse: interpretRunOutput(plan.framework, out) };
}

export function executionCwd(plan: CheckExecutionPlan, worktreePath: string): string {
  // Validate plans read from checkpoints before a shell or filesystem operation.
  CheckExecutionPlanSchema.parse(plan);
  return join(worktreePath, plan.cwd);
}

/** A nonzero process is not proof of a regression. These adapters establish behavioral
 * failures; unsupported output protocols explicitly leave delivered binding unproven. */
export function provesBehavioralFailure(
  plan: CheckExecutionPlan,
  result: { coarse: CoarseOrNone; rawOutput: string; behavioralFailure?: boolean },
): boolean {
  if (result.coarse !== "red") return false;
  if (plan.framework === "mocha" || plan.framework === "django-runtests")
    return result.behavioralFailure === true;
  if (plan.framework === "pytest") {
    const failures = /(?:^|[\s,=])([1-9]\d*) failed\b/m.exec(result.rawOutput);
    const assertions = [...result.rawOutput.matchAll(/^E\s+(?:assert\s|AssertionError\b)/gm)];
    return (
      failures !== null &&
      assertions.length === Number(failures[1]) &&
      !/(?:^|[\s,=])[1-9]\d* errors?\b/m.test(result.rawOutput)
    );
  }
  return false;
}
