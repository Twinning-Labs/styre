import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component, TestAction } from "../dispatch/profile.ts";

/**
 * Qualify a component's test invocation at setup time (ENG-399).
 *
 * WHY THIS EXISTS. `frameworkFor` used to regex a component's `test` command for `jest`/`vitest`.
 * Node projects almost never expose the framework there — they expose `npm run test:ci`, and the
 * framework name lives one level down in `package.json` scripts. On darkreader__darkreader-7241
 * that indirection made the framework unresolvable even though `jest 27.3.1` was a direct
 * dependency and every script named it, and the run escalated at design having written no code.
 *
 * Resolving the NAME is necessary but not sufficient, so this also records the LAUNCHER. Running
 * bare `jest` discards the wrapper's `--config`; darkreader has no root jest config and a
 * three-project `tests/jest.config.js`, so the bare invocation would load none of the
 * ts-jest/jsdom/tsconfig setup the check needs.
 *
 * SCOPE (ENG-427): node/sveltekit, plus python where the repo declares its own runner. The
 * remaining stacks keep the pre-ENG-399 inference path, which resolves correctly for them today
 * (go/rust/jvm/php are fixed per kind).
 *
 * Python was the deferral ENG-399 called out explicitly, and django is the case it produced:
 * `frameworkFor` returned `pytest` for every python component, `binaryFor` built
 * `python3 -m pytest`, and a django image ships no pytest at all — its runner is
 * `./tests/runtests.py`. 46.2% of SWE-bench Verified is django. A run there authored a check that
 * could never execute, recorded the failure as `environmental`, and opened a pull request on no
 * evidence.
 */

/** Package managers whose `run` passes trailing args straight through to the script. */
const PASSTHROUGH_RUNNERS = new Set(["pnpm", "yarn", "bun"]);

/** `npm run <script> -- <args>` needs the separator; the others do not. */
const SEPARATOR_RUNNERS = new Set(["npm"]);

const SCRIPT_INVOCATION = /^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:._-]+)\s*$/;

/** Longest-first so `ts-jest` never matches before a real runner is considered. */
const FRAMEWORK_PATTERNS: ReadonlyArray<[RegExp, TestAction["framework"]]> = [
  [/\bvitest\b/, "vitest"],
  [/(?:^|[\s/])jest\b/, "jest"],
];

function frameworkInCommand(cmd: string): TestAction["framework"] | null {
  for (const [re, fw] of FRAMEWORK_PATTERNS) if (re.test(cmd)) return fw;
  return null;
}

function readScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {}; // absent or malformed package.json — no indirection to follow
  }
}

/**
 * Resolve `command` to a framework, following ONE level of `<pm> run <script>` indirection.
 *
 * One level only, deliberately: a script that shells out to another script is a chain this
 * cannot follow reliably, and guessing past the first hop would reintroduce exactly the
 * confident-but-wrong inference this replaces. Unresolvable returns null, and the caller records
 * no `testAction` rather than a guess.
 */
export function resolveTestAction(componentDir: string, command: string): TestAction | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const direct = frameworkInCommand(trimmed);
  if (direct) return { framework: direct, launcher: trimmed };

  const m = SCRIPT_INVOCATION.exec(trimmed);
  if (!m) return null;
  const [, runner, script] = m;
  const body = readScripts(componentDir)[script];
  if (body === undefined) return null;

  const framework = frameworkInCommand(body);
  if (!framework) return null;

  // Keep the WRAPPER as the launcher, not the resolved body: the wrapper is what carries the
  // repo's own configuration (`--config`, `--runInBand`, env setup), and it is the invocation
  // the repo itself is known to work with.
  const needsSeparator = SEPARATOR_RUNNERS.has(runner);
  const launcher = needsSeparator ? `${trimmed} --` : trimmed;
  if (!needsSeparator && !PASSTHROUGH_RUNNERS.has(runner)) return null;
  return { framework, launcher };
}

/**
 * Does this python component ship django's own test runner?
 *
 * Keyed on `tests/runtests.py` EXISTING, not on the component's `test` command. django's declared
 * command is `tox` (a `tox.ini` is present), which says nothing about how a single test is run —
 * and the AC check needs the runner, not the CI wrapper. The file's presence is the fact that
 * actually decides it, and it is a property of the repo, so it belongs here at setup time rather
 * than being re-derived per run.
 *
 * Verified in the official django image: the runner works from the repo root, needs no
 * `--settings`, and takes dotted labels relative to `tests/`.
 */
function djangoTestAction(moduleDir: string): TestAction | null {
  if (!existsSync(join(moduleDir, "tests", "runtests.py"))) return null;
  // A `tests/runtests.py` alone is not django — require django itself to be the thing being
  // built, which its own repo declares by shipping `django/__init__.py` beside it.
  if (!existsSync(join(moduleDir, "django", "__init__.py"))) return null;
  return { framework: "django-runtests", launcher: "python ./tests/runtests.py --parallel 1" };
}

/** Attach `testAction` to components whose real test invocation can be resolved from the repo:
 *  node/sveltekit via `package.json` scripts (ENG-399), python via its own runner (ENG-427). */
export function withTestActions(repoDir: string, components: Component[]): Component[] {
  return components.map((c) => {
    const moduleDir = join(repoDir, c.dir ?? "");
    if (c.kind === "python") {
      const action = djangoTestAction(moduleDir);
      // No django runner → leave `testAction` absent, which keeps `frameworkFor`'s pytest
      // inference. That is still right for the ~30% of the corpus that genuinely runs pytest.
      return action ? { ...c, testAction: action } : c;
    }
    if (c.kind !== "node" && c.kind !== "sveltekit") return c;
    const cmd = c.commands.test;
    if (typeof cmd !== "string") return c;
    const action = resolveTestAction(moduleDir, cmd);
    return action ? { ...c, testAction: action } : c;
  });
}
