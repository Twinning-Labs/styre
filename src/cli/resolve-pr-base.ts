import type { ProjectorPorts } from "../daemon/projector.ts";
import type { ForgePort } from "../integrations/forge.ts";
import { EXIT, StyreError } from "./errors.ts";

/**
 * The branch a PR will target, confirmed on the forge before any agent work.
 *
 * Setup guesses `defaultBranch` from local refs, which can be stale: the 20 Sept Sphinx run's
 * image carried upstream's `origin/HEAD` → `master` while the seeded repo had only `main`, and
 * every PR request was rejected as `base invalid` after the whole run had been paid for. A branch
 * the profile names and the forge has is kept (an operator may target `develop` deliberately);
 * one the forge lacks falls back to the forge's own default branch.
 */
export async function resolvePrBase(
  forge: ForgePort,
  preferred: string,
): Promise<{ base: string; replaced?: { from: string; to: string } }> {
  if (await forge.branchExists(preferred)) return { base: preferred };
  const fallback = await forge.defaultBranch();
  if (fallback !== preferred && (await forge.branchExists(fallback)))
    return { base: fallback, replaced: { from: preferred, to: fallback } };
  throw new StyreError({
    code: EXIT.CONFIG,
    headline: "cannot start — the forge has no base branch to open a pull request against",
    detail: `The profile names '${preferred}' and the forge's default is '${fallback}'; neither exists on the forge.`,
    recovery: "Push the repository's base branch to the forge, then re-run.",
  });
}

/** Startup step for fresh and resumed runs: point `profile.defaultBranch` (the PR base, and the
 *  project's recorded default branch) at a branch the forge actually has. No forge, no PR. */
export async function confirmPrBase(
  ports: Pick<ProjectorPorts, "forge">,
  profile: { defaultBranch: string },
): Promise<void> {
  if (!ports.forge) return;
  const { base, replaced } = await resolvePrBase(ports.forge, profile.defaultBranch);
  if (replaced)
    process.stderr.write(
      `run: the profile's default branch '${replaced.from}' does not exist on the forge; pull requests will target '${replaced.to}', the forge's default branch.\n`,
    );
  profile.defaultBranch = base;
}
