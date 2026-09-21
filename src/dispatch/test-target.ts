import { type CommandValue, type Profile, isPrimary } from "./profile.ts";

/** Literal argv only. This is target selection, not a shell evaluator or proof of test purpose.
 * Repository wrappers remain explicit commands; direct tox/nox invocations need concrete targets. */
function words(command: string): { argv: string[]; complete: boolean } {
  const argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | null = null;
  const finish = (complete: boolean) => ({ argv: started ? [...argv, word] : argv, complete });
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "single") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++i];
      if (next === undefined || next === "\n") return finish(false);
      started = true;
      word += quote === "double" && !["$", "`", '"', "\\"].includes(next) ? `\\${next}` : next;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = null;
      else if (char === "$" || char === "`") return finish(false);
      else word += char;
      continue;
    }
    if (char === "\n" || char === "\r") return finish(false);
    if (/\s/.test(char)) {
      if (started) argv.push(word);
      word = "";
      started = false;
      continue;
    }
    if (char === "#" && !started) return finish(true);
    if ("$`;|&<>()*?[]{}".includes(char)) return finish(false);
    started = true;
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else word += char;
  }
  return finish(quote === null);
}

const basename = (word: string) => word.split("/").at(-1) ?? word;
const concrete = (value: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) && value !== "ALL";

/** null means no unselected orchestrator was found, NOT that tests were collected or passed.
 * Unknown orchestration syntax fails closed rather than guessing through configuration/options. */
export function testTargetProblem(command: string): string | null {
  const mentionsRunner = /(?:^|[\s'"/])(?:tox|nox)(?:\s|['"]|$)/.test(command);
  const parsed = words(command);
  const args = parsed.argv;
  const hasRunner = mentionsRunner || args.some((word) => ["tox", "nox"].includes(basename(word)));
  if (!parsed.complete || /[\r\n]/.test(command))
    return hasRunner
      ? "Cannot establish a literal tox/nox target; use an explicit environment/session command."
      : null;
  if (args[0] === "env") args.shift();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? "")) args.shift();
  if (args[0] === "uv" && args[1] === "run") args.splice(0, 2);
  else if (args[0] === "pipx" && args[1] === "run") args.splice(0, 2);
  else if (args[0] === "uvx") args.shift();
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(basename(args[0] ?? "")) && args[1] === "-m")
    args.splice(0, 2);
  const runner = basename(args.shift() ?? "");
  if (runner !== "tox" && runner !== "nox") {
    return hasRunner
      ? "Cannot qualify this tox/nox wrapper; configure a direct invocation with literal targets."
      : null;
  }
  const hint =
    runner === "tox"
      ? "Select concrete tox environments with -e/--envlist (not ALL)."
      : "Select concrete nox sessions with -s/--session.";
  if (runner === "tox" && ["run", "r", "run-parallel", "p"].includes(args[0] ?? "")) args.shift();
  let selected = false;
  // Closed option grammar avoids accepting a selector token used as another option's value.
  const flags = new Set(
    runner === "tox"
      ? [
          "-r",
          "--recreate",
          "--sitepackages",
          "--skip-pkg-install",
          "--no-recreate-provision",
          "-q",
          "-v",
          "--quiet",
          "--verbose",
        ]
      : [
          "-r",
          "--reuse-existing-virtualenvs",
          "-R",
          "--no-install",
          "--stop-on-first-error",
          "--no-error-on-missing-interpreters",
          "--error-on-missing-interpreters",
          "--verbose",
        ],
  );
  const values = new Set(
    runner === "tox"
      ? ["-c", "--conf", "--workdir", "--root", "--result-json"]
      : ["-f", "--noxfile", "--report", "--envdir", "--reuse-venv"],
  );
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break; // runner posargs cannot establish target selection
    const eq = arg.indexOf("=");
    const option = eq < 0 ? arg : arg.slice(0, eq);
    const selector =
      runner === "tox" ? ["-e", "--envlist"] : ["-s", "-e", "--session", "--sessions"];
    if (selector.includes(option) || (runner === "tox" && /^-e[^-]/.test(arg))) {
      const value =
        eq >= 0
          ? arg.slice(eq + 1)
          : runner === "tox" && arg.startsWith("-e") && arg !== "-e"
            ? arg.slice(2)
            : args[++i];
      const targets = value?.split(",") ?? [];
      if (!targets.length || !targets.every(concrete)) return hint;
      if (runner === "nox" && targets.length !== 1) return hint;
      selected = true;
      if (runner === "nox" && eq < 0) {
        while (args[i + 1] && !args[i + 1].startsWith("-")) {
          if (!concrete(args[++i])) return hint;
        }
      }
      continue;
    }
    if (flags.has(arg)) continue;
    if (values.has(option)) {
      const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
      if (!value || value.startsWith("-")) return `${hint} Missing literal value for ${option}.`;
      continue;
    }
    return `${hint} Unsupported or non-executing option: ${arg}.`;
  }
  return selected ? null : hint;
}

export function qualifyTestCommand(value: CommandValue): CommandValue {
  if (typeof value !== "string") return value;
  const problem = testTargetProblem(value);
  return problem ? { unresolved: problem } : value;
}

export function unresolvedTestTargets(
  profile: Pick<Profile, "components" | "repoCommands">,
): string[] {
  const problems: string[] = [];
  for (const c of profile.components.filter(isPrimary)) {
    for (const [key, value] of Object.entries(c.commands)) {
      if (typeof value === "object" && "unresolved" in value)
        problems.push(`${c.name}.${key}: ${value.unresolved}`);
      else if (key === "test" && typeof value === "string") {
        const problem = testTargetProblem(value);
        if (problem) problems.push(`${c.name}.test: ${problem}`);
      }
    }
  }
  for (const [name, command] of Object.entries(profile.repoCommands)) {
    const problem = testTargetProblem(command);
    if (problem) problems.push(`repo.${name}: ${problem}`);
  }
  return problems;
}

export function assertTestTargets(profile: Pick<Profile, "components" | "repoCommands">): void {
  const problems = unresolvedTestTargets(profile);
  if (problems.length)
    throw new Error(
      `Unresolved test targets — edit the profile or re-run styre setup:\n${problems.join("\n")}`,
    );
}
