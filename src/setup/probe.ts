import { basename, resolve } from "node:path";
import { type Profile, parseProfile } from "../dispatch/profile.ts";
import { parseGitHubRemote } from "../integrations/adapters/github.ts";
import { detectRuntimeContext } from "./detect-runtime.ts";
import { detectChecksSystem, detectCommands } from "./detect.ts";

/** Run git in `cwd`, returning trimmed stdout, or null on any failure (probe-graceful). */
function tryGit(args: string[], cwd: string): string | null {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  return res.success ? res.stdout.toString().trim() : null;
}

/** Slug from the origin remote's repo name, else the dir basename. */
function deriveSlug(repoDir: string): string {
  const url = tryGit(["config", "--get", "remote.origin.url"], repoDir);
  const parsed = url ? parseGitHubRemote(url) : null;
  return parsed?.repo ?? basename(repoDir);
}

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
  return parseProfile({
    slug: overrides?.slug ?? deriveSlug(targetRepo),
    targetRepo,
    defaultBranch: detectDefaultBranch(targetRepo),
    checksSystem: overrides?.checksSystem ?? detectChecksSystem(targetRepo),
    commands: detectCommands(targetRepo),
    runtimeContext: detectRuntimeContext(targetRepo),
  });
}
