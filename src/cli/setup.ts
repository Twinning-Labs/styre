import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { preflightAgentCli } from "../agent/preflight.ts";
import { resolveAgentRunner } from "../agent/resolve.ts";
import { DEFAULT_AGENT_CONFIG, requiredEnvFor } from "../config/agent-config.ts";
import { discoverRuntimeConfig } from "../config/discover.ts";
import { configDir } from "../config/paths.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../config/runtime-config.ts";
import { deriveSlug } from "../config/slug.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { unrootedManifestWarnings } from "../setup/detect-components.ts";
import { discoverComponents } from "../setup/discover.ts";
import type { EnrichDeps } from "../setup/enrich.ts";
import { enrichRuntimeContext } from "../setup/enrich.ts";
import { mergeRuntimeContext } from "../setup/merge.ts";
import { probeProfile } from "../setup/probe.ts";
import { resolveCommands } from "../setup/resolve-commands.ts";
import { createAnalytics } from "../telemetry/analytics/index.ts";
import type { SetupInput } from "../telemetry/analytics/properties.ts";
import { agentCliError } from "./errors.ts";
import { guard } from "./output.ts";

const CHECKS = new Set(["github", "external", "none"]);

/** Runtime-context sections the probe couldn't determine — the operator should fill these in. */
export function unknownRuntimeSections(profile: Profile): string[] {
  const rc = profile.runtimeContext;
  const out: string[] = [];
  if (rc.topology.type === "unknown") out.push("topology");
  for (const name of [
    "data",
    "caching",
    "observability",
    "configSecrets",
    "documentation",
  ] as const) {
    if (rc[name].presence === "unknown") out.push(name);
  }
  if (rc.releasePackaging.mechanism === "unknown") out.push("releasePackaging");
  return out;
}

/** Ensure the profile carries a stable analytics id. Resolution order: the profile's own id →
 *  a fallback (e.g. an existing on-disk id, preserved across --force/--reprobe) → a fresh UUID.
 *  Never encodes the slug. */
export function ensureAnalyticsId(profile: Profile, fallbackId?: string): Profile {
  const analyticsId = profile.analyticsId ?? fallbackId ?? randomUUID();
  return profile.analyticsId === analyticsId ? profile : { ...profile, analyticsId };
}

const STACK_KEYWORDS: Array<[RegExp, string]> = [
  [/node|typescript|javascript|express|nest|bun|deno/i, "node"],
  [/python|django|flask|fastapi/i, "python"],
  [/\bgo\b|golang/i, "go"],
  [/rust|cargo/i, "rust"],
  [/java|kotlin|spring/i, "jvm"],
  [/ruby|rails/i, "ruby"],
  [/php|laravel/i, "php"],
  [/\.net|c#|dotnet/i, "dotnet"],
];

/** Coarse stack bucket from the probed TECHNOLOGY_STACK promptVar (never the raw string). */
function stackBucket(profile: Profile): string {
  const raw = profile.promptVars.TECHNOLOGY_STACK ?? "";
  for (const [re, label] of STACK_KEYWORDS) if (re.test(raw)) return label;
  return "other";
}

/** Map a profile to the allow-listed setup_completed inputs. */
export function deriveSetupInput(profile: Profile): SetupInput {
  return {
    projectId: profile.analyticsId ?? "",
    checksSystem: profile.checksSystem,
    componentCount: profile.components.length,
    componentKinds: [...new Set(profile.components.map((c) => c.kind))],
    stackBucket: stackBucket(profile),
    topologyType: profile.runtimeContext.topology.type,
  };
}

/** Probe a repo, enrich its runtime context via the agent, and write the profile JSON. Testable
 *  core (the citty command is a thin wrapper that supplies the real runner + cred precondition).
 *  Assumes `args.repo` is an explicit, operator-named path — it does NOT itself gate on the
 *  disposability marker. Any future caller that passes a discovered / no-arg repo MUST call
 *  `assertInPlaceMarker(repo)` first, as the citty wrapper below does. Do not let this wrapper-only
 *  gate silently erode. */
export async function runSetup(args: {
  repo: string;
  out?: string;
  checks?: string;
  slug?: string;
  force?: boolean;
  reprobe?: boolean;
  trustAgentCommands?: boolean;
  deps: EnrichDeps;
}): Promise<{ outPath: string; profile: Profile; needsInput: string[] }> {
  const repoDir = resolve(args.repo);
  if (!existsSync(repoDir)) throw new Error(`setup: repo path not found: ${repoDir}`);
  if (args.checks !== undefined && !CHECKS.has(args.checks)) {
    throw new Error(`setup: --checks must be github|external|none (got '${args.checks}')`);
  }
  const clean = args.force === true || args.reprobe === true;
  const scanProfile = probeProfile(repoDir, {
    slug: args.slug,
    checksSystem: args.checks as "github" | "external" | "none" | undefined,
  });
  // Layer 1+2: deterministic scan, then mandatory agent enrichment (throws on failure → no write).
  const enriched = await enrichRuntimeContext(repoDir, scanProfile.runtimeContext, args.deps);
  let profile: Profile = { ...scanProfile, runtimeContext: enriched };

  const outPath =
    args.out && args.out.length > 0
      ? resolve(args.out)
      : join(configDir(), profile.slug, "profile.json");
  // Preserve an existing project's analytics id whenever a profile is already on disk — even under
  // --force/--reprobe — so the same project keeps a STABLE id and is never double-counted.
  const priorAnalyticsId = existsSync(outPath) ? loadProfile(outPath).analyticsId : undefined;
  if (existsSync(outPath) && !clean) {
    // Layer 3: idempotent re-probe — enrich without clobbering operator-resolved runtime context.
    const existing = loadProfile(outPath);
    profile = {
      ...profile,
      analyticsId: existing.analyticsId ?? profile.analyticsId,
      runtimeContext: mergeRuntimeContext(existing.runtimeContext, profile.runtimeContext),
    };
  }
  // Layer: agent-assisted discovery + interactive command-resolution ladder.
  const interactive = Boolean(process.stdin.isTTY);
  const discovered = await discoverComponents(
    repoDir,
    { components: profile.components, repoCommands: profile.repoCommands },
    { runner: args.deps.runner, agentConfig: args.deps.agentConfig },
    { interactive, trustAgentCommands: args.trustAgentCommands === true },
  );
  for (const w of discovered.warnings) console.warn(w);
  for (const w of unrootedManifestWarnings(repoDir)) console.warn(w);
  const { components, warnings } = resolveCommands(discovered.components, {
    interactive,
    ask: (q) => (interactive ? (globalThis.prompt(q) ?? null) : null),
  });
  for (const w of warnings) console.warn(w);

  // SECURITY-BEARING CONFIRM: every command (incl. agent-supplied ones) runs via `sh -c` at verify
  // and seeds the implement Bash allowlist. Show the FULL final command list and require explicit
  // operator sign-off — not just prompting for the ones that were missing.
  if (interactive) {
    process.stderr.write(
      "\nResolved components (commands run with repo write + network; paths drive verify routing):\n",
    );
    for (const c of components) {
      process.stderr.write(`  ${c.name} [${c.kind}]  paths: ${c.paths.join(", ")}\n`);
      for (const [k, v] of Object.entries(c.commands)) {
        process.stderr.write(`    ${k}: ${typeof v === "string" ? v : "(none)"}\n`);
      }
      if (c.prepare !== undefined) {
        process.stderr.write(`    prepare: ${c.prepare} (stored, not run)\n`);
      }
    }
    for (const [name, cmd] of Object.entries(discovered.repoCommands)) {
      process.stderr.write(`  repo.${name}: ${cmd}\n`);
    }
    const ok = globalThis.prompt("Approve these components (commands + paths)? [y/N]");
    if (ok?.trim().toLowerCase() !== "y") {
      throw new Error("setup aborted: operator did not approve the command list");
    }
  }

  profile = ensureAnalyticsId(
    { ...profile, components, repoCommands: discovered.repoCommands },
    priorAnalyticsId,
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`);
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
}

/** Non-fatal note about creds a later `styre run` will need. Tracker-aware: if any JIRA_* var is
 *  present we treat JIRA as the intended tracker and require the full trio; otherwise LINEAR_API_KEY. */
export function credNote(profile: Profile): string | null {
  const missing: string[] = [];
  if (profile.checksSystem === "github" && !process.env.GITHUB_TOKEN)
    missing.push("GITHUB_TOKEN (PR/push + checks)");
  const usingJira = !!(
    process.env.JIRA_BASE_URL ||
    process.env.JIRA_EMAIL ||
    process.env.JIRA_API_TOKEN
  );
  if (usingJira) {
    const jira: [string, string][] = [
      ["JIRA_BASE_URL", "site URL"],
      ["JIRA_EMAIL", "account email"],
      ["JIRA_API_TOKEN", "API token"],
    ];
    for (const [k, label] of jira)
      if (!process.env[k]) missing.push(`${k} (${label} — JIRA ticket ingest + projection)`);
  } else if (!process.env.LINEAR_API_KEY) {
    missing.push("LINEAR_API_KEY (ticket ingest + projection)");
  }
  return missing.length > 0 ? `note — not set for \`styre run\`: ${missing.join(", ")}` : null;
}

export const setupCommand = defineCommand({
  meta: { name: "setup", description: "Probe a repo and write a Styre profile JSON." },
  args: {
    repo: {
      type: "positional",
      required: false,
      description:
        "Path to the target repo (omit to discover the cwd repo — requires a .styre-disposable marker)",
    },
    out: {
      type: "string",
      description: "Output path (default: $XDG_CONFIG_HOME/styre/<slug>/profile.json)",
    },
    checks: { type: "string", description: "Override checks-system: github | external | none" },
    slug: { type: "string", description: "Override the derived project slug" },
    force: { type: "boolean", description: "Overwrite an existing profile" },
    reprobe: {
      type: "boolean",
      description: "Re-probe from scratch, discarding operator-resolved runtime context",
    },
    config: {
      type: "string",
      description: "Path to a runtime config.json (selects the agent provider)",
    },
    "trust-agent-commands": {
      type: "boolean",
      description:
        "Headless only: accept agent-refined command strings. These run as code at verify — the metacharacter filter is hygiene, not a sandbox. Use only on trusted repos / isolated environments. Off by default.",
    },
  },
  run: (ctx) => guard("setup", () => setupImpl({ args: ctx.args as unknown as SetupArgs })),
});

export interface SetupArgs {
  repo?: string;
  out?: string;
  checks?: string;
  slug?: string;
  force?: boolean;
  reprobe?: boolean;
  config?: string;
  "trust-agent-commands"?: boolean;
}

export async function setupImpl({ args }: { args: SetupArgs }): Promise<void> {
  // No positional `repo`: discover the cwd repo and gate it on the disposability marker BEFORE
  // any write-capable enrichment agent call (runSetup's enrichRuntimeContext/discoverComponents).
  // An explicit `setup <repo>` requires no marker — the operator named the target.
  let repo = args.repo;
  if (!repo) {
    const { discoverRepoRoot, assertInPlaceMarker } = await import("../dispatch/in-place.ts");
    repo = discoverRepoRoot(); // no-arg → discover cwd's repo (throws fail-closed if not a git repo)
    assertInPlaceMarker(repo); // gate BEFORE runSetup's write-capable enrichment agent
  }
  const effSlug = args.slug && args.slug.length > 0 ? args.slug : deriveSlug(resolve(repo));
  const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug: effSlug });
  const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
  const requiredKey = requiredEnvFor(agentConfig.provider);
  if (requiredKey && !process.env[requiredKey]) {
    throw new Error(
      `setup: ${requiredKey} is required for provider '${agentConfig.provider}' (runtime-context prose enrichment)`,
    );
  }
  // The env key alone doesn't prove the CLI is usable. Probe the binary before the write-capable
  // enrichment agent runs, so a missing/old CLI fails the setup gate with an actionable message
  // instead of surfacing later as an opaque transient agent failure (ENG-326).
  const cliPreflight = preflightAgentCli(agentConfig);
  if (!cliPreflight.ok) throw agentCliError(cliPreflight);
  if (cliPreflight.unauthHint) process.stderr.write(`setup: ${cliPreflight.unauthHint}\n`);
  const runner = resolveAgentRunner(agentConfig);
  const { outPath, profile, needsInput } = await runSetup({
    repo,
    out: args.out,
    checks: args.checks,
    slug: effSlug,
    force: args.force,
    reprobe: args.reprobe,
    trustAgentCommands: args["trust-agent-commands"] === true,
    deps: { runner, agentConfig },
  });
  process.stderr.write(`setup: wrote ${outPath}\n`);
  if (needsInput.length > 0) {
    const lines = needsInput.map((s) => `         - ${s}`).join("\n");
    process.stderr.write(
      `setup: NEEDS INPUT — the probe could not determine these runtime-context sections.\n       Edit ${outPath} and set presence/detail (or re-run after adding tooling):\n${lines}\n`,
    );
  }
  const credNoteMsg = credNote(profile);
  if (credNoteMsg) process.stderr.write(`setup: ${credNoteMsg}\n`);
  process.stderr.write(`setup: run with styre run <ticket> --profile ${outPath}\n`);

  try {
    const analytics = createAnalytics(DEFAULT_RUNTIME_CONFIG);
    analytics.setupCompleted(deriveSetupInput(profile));
    await analytics.shutdown();
  } catch {
    /* telemetry must never fail a completed setup */
  }
}
