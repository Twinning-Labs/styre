import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { configDir } from "./paths.ts";
import { type RuntimeConfig, RuntimeConfigSchema } from "./runtime-config.ts";
import { type GitRun, deriveSlug, discoverRepoRoot } from "./slug.ts";

/** The repo slug for the cwd, or null when cwd is not a git repo. */
export function slugForCwd(cwd: string = process.cwd(), git?: GitRun): string | null {
  try {
    return deriveSlug(git ? discoverRepoRoot(cwd, git) : discoverRepoRoot(cwd));
  } catch {
    return null;
  }
}

/** The conventional profile path for a slug. */
export function profilePathFor(slug: string, configHome: string = configDir()): string {
  return join(configHome, slug, "profile.json");
}

/** Load the profile from its conventional location; throw a setup-pointing error only when the file
 *  is ABSENT. A present-but-malformed profile propagates its parse/zod error unchanged. */
export function loadProfileByConvention(slug: string, configHome: string = configDir()): Profile {
  const path = profilePathFor(slug, configHome);
  if (!existsSync(path)) {
    throw new Error(`styre run: no profile for '${slug}' at ${path} — run \`styre setup\` first`);
  }
  return loadProfile(path);
}

/** Read+parse a JSON file, {} when absent; a present-but-malformed file throws naming the file. */
function readJsonIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`styre: malformed config at ${path}: ${String(err)}`);
  }
}

/** Resolve the runtime config. Explicit `explicitPath` is hermetic (sole source; today's behavior).
 *  Else shallow-merge (per top-level key) the raw global + per-slug JSON, then parse so defaults
 *  fill gaps. The nested `agent` block is replaced wholesale and must be complete when present. */
export function discoverRuntimeConfig(opts: {
  explicitPath?: string;
  slug?: string;
  configHome?: string;
}): RuntimeConfig {
  if (opts.explicitPath && opts.explicitPath.length > 0) {
    return RuntimeConfigSchema.parse(JSON.parse(readFileSync(opts.explicitPath, "utf8")));
  }
  const home = opts.configHome ?? configDir();
  const global = readJsonIfPresent(join(home, "config.json"));
  const perProject = opts.slug ? readJsonIfPresent(join(home, opts.slug, "config.json")) : {};
  return RuntimeConfigSchema.parse({ ...global, ...perProject });
}
