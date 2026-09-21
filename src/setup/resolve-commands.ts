import { commandFor, isScriptRunner, isUnavailable } from "../dispatch/components.ts";
import type { CommandValue, Component } from "../dispatch/profile.ts";
import { qualifyTestCommand } from "../dispatch/test-target.ts";

const MUST_HAVE = ["build", "test", "check"] as const;

export interface ResolveOpts {
  interactive: boolean;
  /** Returns the operator's line, or null for EOF / non-interactive. */
  ask: (question: string) => string | null;
}

/** Resolve every component's must-have commands to a string or `{ unavailable: true }`, prompting
 *  the operator (interactive) for missing ones. Emits warnings for unavailable commands and for
 *  script-runner commands (which cannot be tightly Bash-scoped). */
export function resolveCommands(
  components: Component[],
  opts: ResolveOpts,
): { components: Component[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = components.map((c) => {
    const commands: Record<string, CommandValue> = { ...c.commands };
    if (commands.test !== undefined) commands.test = qualifyTestCommand(commands.test);
    for (const k of MUST_HAVE) {
      const value = commands[k];
      if (typeof value === "object" && "unresolved" in value) {
        const answer = opts.interactive
          ? opts.ask(
              `${c.name}.${k}: ${value.unresolved} Supply an explicit command, or leave blank to keep unresolved:`,
            )
          : null;
        if (answer?.trim() && answer.trim().toLowerCase() !== "none")
          commands[k] = k === "test" ? qualifyTestCommand(answer.trim()) : answer.trim();
        if (typeof commands[k] !== "string")
          warnings.push(
            `⚠ ${c.name}.${k}: unresolved — testing has not been declared unavailable.`,
          );
        continue;
      }
      if (commandFor({ ...c, commands }, k) !== undefined) continue; // already a real command
      if (isUnavailable({ ...c, commands }, k)) continue; // already confirmed-none
      const answer = opts.interactive
        ? opts.ask(
            `${c.name} (${c.kind}) has no ${k} command — supply one, or leave blank for none:`,
          )
        : null;
      if (answer && answer.trim() !== "" && answer.trim().toLowerCase() !== "none") {
        commands[k] = k === "test" ? qualifyTestCommand(answer.trim()) : answer.trim();
      } else if (k === "test" && answer?.trim().toLowerCase() !== "none") {
        commands[k] = {
          unresolved:
            "No test command selected. Declare a suite or explicitly mark testing unavailable.",
        };
        warnings.push(`⚠ ${c.name}.test: unresolved (not unavailable).`);
      } else {
        commands[k] = { unavailable: true };
        warnings.push(`⚠ ${c.name}: no ${k} command — styre cannot ground-truth-${k} this stack.`);
      }
    }
    for (const [k, v] of Object.entries(commands)) {
      if (typeof v === "string" && isScriptRunner(v)) {
        warnings.push(
          `⚠ ${c.name}.${k} = "${v}" is a shell script — its Bash scope cannot be tightened.`,
        );
      }
    }
    return { ...c, commands };
  });
  return { components: out, warnings };
}
