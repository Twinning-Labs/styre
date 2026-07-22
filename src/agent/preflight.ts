import { type AgentConfig, requiredEnvFor } from "../config/agent-config.ts";
import { CLAUDE_MIN_CLI_VERSION } from "./providers/claude.ts";
import { CODEX_MIN_CLI_VERSION } from "./providers/codex.ts";

/** Result of probing the configured agent CLI before dispatch (ENG-326). `version: null` on the
 *  `ok` branch means the binary is present but its `--version` output was unparseable — fail-open. */
export type AgentCliPreflight =
  | { ok: true; version: string | null; unauthHint?: string }
  | { ok: false; reason: "missing"; command: string }
  | { ok: false; reason: "unsupported-version"; command: string; found: string; required: string };

/** Per-provider minimum CLI version. Single source of truth = the adapter constants. */
const PROVIDER_MIN_VERSION: Record<string, string> = {
  claude: CLAUDE_MIN_CLI_VERSION,
  codex: CODEX_MIN_CLI_VERSION,
};

type Version = [number, number, number];

/** Parse the LAST `N.N(.N)` token in `text`. Last-match (not first) avoids a false hard-fail when
 *  a line leads with an unrelated dotted number (a build date, a runtime version). Missing patch → 0. */
export function parseCliVersion(text: string): Version | null {
  const matches = [...text.matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
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
  const env = deps.env ?? process.env;

  // The default command equals the provider name for both built-in adapters (claude.ts:87 /
  // codex.ts:128 factory defaults). config.command overrides it.
  const command = config.command ?? config.provider;

  if (!onPath(command)) return { ok: false, reason: "missing", command };

  const hint = unauthHintFor(config.provider, command, env);
  const withHint = (version: string | null): AgentCliPreflight =>
    hint ? { ok: true, version, unauthHint: hint } : { ok: true, version };

  const floor = PROVIDER_MIN_VERSION[config.provider];
  if (!floor) return withHint(null); // unknown provider: no declared floor, PATH existence is all we assert

  const found = parseCliVersion(runVersion(command).output);
  if (found === null) return withHint(null); // unparseable → fail-open

  const required = parseCliVersion(floor);
  if (required && compareVersions(found, required) < 0) {
    return {
      ok: false,
      reason: "unsupported-version",
      command,
      found: found.join("."),
      required: floor,
    };
  }
  return withHint(found.join("."));
}
