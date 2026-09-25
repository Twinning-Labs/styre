import { type AgentConfig, requiredEnvFor } from "../config/agent-config.ts";
import {
  CLAUDE_MIN_CLI_VERSION,
  CLAUDE_REQUIRED_HELP,
  type HelpRequirement,
} from "./providers/claude.ts";
import { CODEX_MIN_CLI_VERSION } from "./providers/codex.ts";

/** Result of probing the configured agent CLI before dispatch (ENG-326). `version: null` on the
 *  `ok` branch means the binary is present but its `--version` output was unparseable — fail-open. */
export type AgentCliPreflight =
  | { ok: true; version: string | null; unauthHint?: string }
  | { ok: false; reason: "missing"; command: string }
  | { ok: false; reason: "unsupported-version"; command: string; found: string; required: string }
  | { ok: false; reason: "missing-capability"; command: string; missing: string[] }
  | { ok: false; reason: "provider-not-enforceable"; command: string };

/** Per-provider options `<cli> --help` must list for the adapter's capability-isolation flags to
 *  exist (ENG-476). Probed, not inferred from a version number: an option either exists or not. */
const PROVIDER_REQUIRED_HELP: Record<string, readonly HelpRequirement[]> = {
  claude: CLAUDE_REQUIRED_HELP,
};

/** Providers Styre refuses to dispatch through because they cannot enforce a step's capability
 *  table (ENG-476, operator decision 2026-09-24). Codex's `read-only` sandbox still runs shell
 *  commands and reads outside the project; confinement via permission profiles is ENG-484. */
const NOT_ENFORCEABLE_PROVIDERS = new Set(["codex"]);

/** Per-provider minimum CLI version. Single source of truth = the adapter constants. */
const PROVIDER_MIN_VERSION: Record<string, string> = {
  claude: CLAUDE_MIN_CLI_VERSION,
  codex: CODEX_MIN_CLI_VERSION,
};

type Version = [number, number, number];

/** Parse the LAST full `MAJOR.MINOR.PATCH` triple in `text`. Requiring all three components and
 *  taking the last match rejects two noise classes that a one-sided position rule would miss: a
 *  *leading* unrelated dotted number (a build date like `2026.07.22`) is skipped by "last", and a
 *  *trailing* two-part fragment (a `(build 1.2)` suffix) is skipped by "full triple". A version
 *  reporting fewer than three components is treated as unreadable → the caller fails OPEN (a present
 *  binary is never blocked on a format we cannot parse). */
export function parseCliVersion(text: string): Version | null {
  const matches = [...text.matchAll(/(\d+)\.(\d+)\.(\d+)/g)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 if a<b, 0 if equal, 1 if a>b (major, then minor, then patch). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

interface PreflightDeps {
  onPath?: (command: string) => boolean;
  runVersion?: (command: string) => { ok: boolean; output: string };
  runHelp?: (command: string) => { ok: boolean; output: string };
  env?: NodeJS.ProcessEnv;
}

/** PATH-existence check via `command -v` (mirrors probeCommandExists; `sh` always exists, so a
 *  missing binary returns false rather than throwing — we never spawn the missing binary directly). */
function defaultOnPath(command: string): boolean {
  return Bun.spawnSync(["sh", "-c", 'command -v "$1"', "sh", command]).success;
}

function defaultRunVersion(command: string): { ok: boolean; output: string } {
  const r = Bun.spawnSync([command, "--version"], { timeout: 5_000 });
  const dec = new TextDecoder();
  return { ok: r.success, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

/** The name a missing requirement is reported under, e.g. `--permission-mode dontAsk`. */
export function requirementName(req: HelpRequirement): string {
  return req.choice === undefined ? req.option : `${req.option} ${req.choice}`;
}

/** True when `help` lists the requirement. The option must start a line in the OPTION column —
 *  exactly two spaces of indent, optionally after a short alias like `-p, ` — so a flag named in a
 *  description, even at the start of a wrapped description line, does not count. A required choice
 *  must appear within that option's own entry (up to the next option line). */
export function helpLists(help: string, req: HelpRequirement): boolean {
  const lines = help.split("\n");
  const escaped = req.option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionLine = new RegExp(`^ {2}(?:-[A-Za-z], )?${escaped}(?=[\\s,=]|$)`);
  const start = lines.findIndex((l) => optionLine.test(l));
  if (start === -1) return false;
  if (req.choice === undefined) return true;
  const nextOption = lines.findIndex((l, i) => i > start && /^ {2}-/.test(l));
  const entry = lines.slice(start, nextOption === -1 ? undefined : nextOption).join("\n");
  return entry.includes(req.choice);
}

function defaultRunHelp(command: string): { ok: boolean; output: string } {
  const r = Bun.spawnSync([command, "--help"], { timeout: 10_000 });
  const dec = new TextDecoder();
  return { ok: r.success, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
}

function unauthHintFor(
  provider: string,
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const key = requiredEnvFor(provider);
  return key && !env[key]
    ? `${command} is installed but ${key} is unset; it may not be authenticated`
    : undefined;
}

export function preflightAgentCli(
  config: AgentConfig,
  deps: PreflightDeps = {},
): AgentCliPreflight {
  const onPath = deps.onPath ?? defaultOnPath;
  const runVersion = deps.runVersion ?? defaultRunVersion;
  const runHelp = deps.runHelp ?? defaultRunHelp;
  const env = deps.env ?? process.env;

  // The default command equals the provider name for both built-in adapters (claude.ts:87 /
  // codex.ts:128 factory defaults). config.command overrides it.
  const command = config.command ?? config.provider;

  // ENG-476: a provider that cannot enforce a step's capability table is refused before anything
  // else, so an operator is never told to install or upgrade a CLI Styre will then refuse anyway.
  if (NOT_ENFORCEABLE_PROVIDERS.has(config.provider)) {
    return { ok: false, reason: "provider-not-enforceable", command };
  }

  if (!onPath(command)) return { ok: false, reason: "missing", command };

  const hint = unauthHintFor(config.provider, command, env);
  const withHint = (version: string | null): AgentCliPreflight =>
    hint ? { ok: true, version, unauthHint: hint } : { ok: true, version };

  const floor = PROVIDER_MIN_VERSION[config.provider];
  if (!floor) return withHint(null); // unknown provider: no declared floor, PATH existence is all we assert

  const found = parseCliVersion(runVersion(command).output);
  const required = parseCliVersion(floor);
  if (found !== null && required && compareVersions(found, required) < 0) {
    return {
      ok: false,
      reason: "unsupported-version",
      command,
      found: found.join("."),
      required: floor,
    };
  }

  // ENG-476: the isolation flags must exist on THIS binary. Unlike the version floor (which fails
  // open on an unreadable version), this fails closed: an unreadable or failing --help is treated
  // as every flag missing, because dispatching without them silently drops the isolation.
  const tokens = PROVIDER_REQUIRED_HELP[config.provider] ?? [];
  if (tokens.length > 0) {
    const help = runHelp(command);
    const missing = (help.ok ? tokens.filter((t) => !helpLists(help.output, t)) : [...tokens]).map(
      requirementName,
    );
    if (missing.length > 0) return { ok: false, reason: "missing-capability", command, missing };
  }

  return withHint(found === null ? null : found.join(".")); // unparseable version → fail-open
}
