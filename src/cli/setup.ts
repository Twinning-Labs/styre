import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { claudeAgentRunner } from "../agent/providers/claude.ts";
import { selectAgentRunner } from "../agent/registry.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { configDir } from "../config/paths.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { discoverComponents } from "../setup/discover.ts";
import type { EnrichDeps } from "../setup/enrich.ts";
import { enrichRuntimeContext } from "../setup/enrich.ts";
import { mergeRuntimeContext } from "../setup/merge.ts";
import { probeProfile } from "../setup/probe.ts";
import { resolveCommands } from "../setup/resolve-commands.ts";

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

/** Probe a repo, enrich its runtime context via the agent, and write the profile JSON. Testable
 *  core (the citty command is a thin wrapper that supplies the real runner + cred precondition). */
export async function runSetup(args: {
  repo: string;
  out?: string;
  checks?: string;
  slug?: string;
  force?: boolean;
  reprobe?: boolean;
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
  if (existsSync(outPath) && !clean) {
    // Layer 3: idempotent re-probe — enrich without clobbering operator-resolved runtime context.
    const existing = loadProfile(outPath);
    profile = {
      ...profile,
      runtimeContext: mergeRuntimeContext(existing.runtimeContext, profile.runtimeContext),
    };
  }
  // Layer: agent-assisted discovery + interactive command-resolution ladder.
  const discovered = await discoverComponents(
    repoDir,
    { components: profile.components, repoCommands: profile.repoCommands },
    { runner: args.deps.runner, agentConfig: args.deps.agentConfig },
  );

  const interactive = Boolean(process.stdin.isTTY);
  const { components, warnings } = resolveCommands(discovered.components, {
    interactive,
    ask: (q) => (interactive ? (globalThis.prompt(q) ?? null) : null),
  });
  for (const w of warnings) console.warn(w);

  // SECURITY-BEARING CONFIRM: every command (incl. agent-supplied ones) runs via `sh -c` at verify
  // and seeds the implement Bash allowlist. Show the FULL final command list and require explicit
  // operator sign-off — not just prompting for the ones that were missing.
  if (interactive) {
    console.log(
      "\nResolved components (commands run with repo write + network; paths drive verify routing):",
    );
    for (const c of components) {
      console.log(`  ${c.name} [${c.kind}]  paths: ${c.paths.join(", ")}`);
      for (const [k, v] of Object.entries(c.commands)) {
        console.log(`    ${k}: ${typeof v === "string" ? v : "(none)"}`);
      }
    }
    for (const [name, cmd] of Object.entries(discovered.repoCommands)) {
      console.log(`  repo.${name}: ${cmd}`);
    }
    const ok = globalThis.prompt("Approve these components (commands + paths)? [y/N]");
    if (ok?.trim().toLowerCase() !== "y") {
      throw new Error("setup aborted: operator did not approve the command list");
    }
  }

  profile = { ...profile, components, repoCommands: discovered.repoCommands };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`);
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
}

/** Non-fatal note about creds a later `styre run` will need. */
function credNote(profile: Profile): string | null {
  const missing: string[] = [];
  if (profile.checksSystem === "github" && !process.env.GITHUB_TOKEN)
    missing.push("GITHUB_TOKEN (PR/push + checks)");
  if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY (ticket ingest + projection)");
  return missing.length > 0 ? `note — not set for \`styre run\`: ${missing.join(", ")}` : null;
}

export const setupCommand = defineCommand({
  meta: { name: "setup", description: "Probe a repo and write a Styre profile JSON." },
  args: {
    repo: { type: "positional", required: true, description: "Path to the target repo" },
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
  },
  async run({ args }) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("setup: ANTHROPIC_API_KEY is required (runtime-context prose enrichment)");
    }
    const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
    const { outPath, profile, needsInput } = await runSetup({
      repo: args.repo,
      out: args.out,
      checks: args.checks,
      slug: args.slug,
      force: args.force,
      reprobe: args.reprobe,
      deps: { runner, agentConfig: DEFAULT_AGENT_CONFIG },
    });
    console.log(`setup: wrote ${outPath}`);
    if (needsInput.length > 0) {
      const lines = needsInput.map((s) => `         - ${s}`).join("\n");
      console.log(
        `setup: NEEDS INPUT — the probe could not determine these runtime-context sections.\n       Edit ${outPath} and set presence/detail (or re-run after adding tooling):\n${lines}`,
      );
    }
    const note = credNote(profile);
    if (note) console.log(`setup: ${note}`);
    console.log(`setup: run with  styre run <ticket> --profile ${outPath}`);
  },
});
