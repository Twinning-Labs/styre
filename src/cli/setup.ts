import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { configDir } from "../config/paths.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { mergeRuntimeContext } from "../setup/merge.ts";
import { probeProfile } from "../setup/probe.ts";

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

/** Probe a repo and write its profile JSON. Testable core (the citty command is a thin wrapper). */
export function runSetup(args: {
  repo: string;
  out?: string;
  checks?: string;
  slug?: string;
  force?: boolean;
  reprobe?: boolean;
}): { outPath: string; profile: Profile; needsInput: string[] } {
  const repoDir = resolve(args.repo);
  if (!existsSync(repoDir)) throw new Error(`setup: repo path not found: ${repoDir}`);
  if (args.checks !== undefined && !CHECKS.has(args.checks)) {
    throw new Error(`setup: --checks must be github|external|none (got '${args.checks}')`);
  }
  const clean = args.force === true || args.reprobe === true;
  let profile = probeProfile(repoDir, {
    slug: args.slug,
    checksSystem: args.checks as "github" | "external" | "none" | undefined,
  });
  const outPath =
    args.out && args.out.length > 0
      ? resolve(args.out)
      : join(configDir(), profile.slug, "profile.json");
  if (existsSync(outPath) && !clean) {
    // Idempotent re-probe: enrich without clobbering operator-resolved runtime context.
    const existing = loadProfile(outPath);
    profile = {
      ...profile,
      runtimeContext: mergeRuntimeContext(existing.runtimeContext, profile.runtimeContext),
    };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`);
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
}

/** Non-fatal note about creds a later `styre run` will need (setup itself touches no creds). */
function credNote(profile: Profile): string | null {
  const missing: string[] = [];
  if (profile.checksSystem === "github" && !process.env.GITHUB_TOKEN)
    missing.push("GITHUB_TOKEN (PR/push + checks)");
  if (!process.env.LINEAR_API_KEY) missing.push("LINEAR_API_KEY (ticket ingest + projection)");
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY (headless agent auth)");
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
  run({ args }) {
    const { outPath, profile, needsInput } = runSetup({
      repo: args.repo,
      out: args.out,
      checks: args.checks,
      slug: args.slug,
      force: args.force,
      reprobe: args.reprobe,
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
