import { resolve } from "node:path";
import { deriveSlug, tryGit } from "../config/slug.ts";
import { type Profile, parseProfile } from "../dispatch/profile.ts";
import { detectComponents } from "./detect-components.ts";
import { detectRuntimeContext } from "./detect-runtime.ts";
import { detectChecksSystem } from "./detect.ts";

/** Default branch from origin/HEAD, else the current branch, else "main". */
function detectDefaultBranch(repoDir: string): string {
  const originHead = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoDir);
  if (originHead) return originHead.replace(/^origin\//, "");
  const current = tryGit(["symbolic-ref", "--short", "HEAD"], repoDir);
  return current ?? "main";
}

/** Probe a repo into a validated Profile. Overrides win over detection. Pure of side effects
 *  except reading the repo (files + git). */
export function probeProfile(
  repoDir: string,
  overrides?: { slug?: string; checksSystem?: "github" | "external" | "none" },
): Profile {
  const targetRepo = resolve(repoDir);
  const { components, repoCommands } = detectComponents(targetRepo);
  return parseProfile({
    slug: overrides?.slug ?? deriveSlug(targetRepo),
    targetRepo,
    defaultBranch: detectDefaultBranch(targetRepo),
    checksSystem: overrides?.checksSystem ?? detectChecksSystem(targetRepo),
    components,
    repoCommands,
    runtimeContext: detectRuntimeContext(targetRepo),
  });
}
