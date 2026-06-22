/** Vendor-neutral forge (code-host) port (zero lock-in). The core depends only on this interface;
 *  GitHub/GitLab/etc. are config-selected adapters behind it. Mirrors src/integrations/issue-tracker.ts. */
export interface ForgePort {
  /** Push the feature branch to the remote at `sha`. Probe-idempotent: skip if the remote ref is
   *  already at `sha`. Feature branch only; force is with-lease and never on a protected branch. */
  push(opts: { branch: string; sha: string }): Promise<void>;
  /** Ensure a PR exists for `branch` into `base`. Probe-idempotent: reuse an existing PR if present.
   *  Returns the PR ref (number) + url. */
  ensurePr(opts: { branch: string; base: string; title: string; body: string }): Promise<{
    ref: string;
    url: string;
  }>;
  /** Comment on a PR, deduped by idempotencyKey (adapter probes existing comments). Returns the
   *  created comment id/ref, or null if it already existed. */
  addPrComment(prRef: string, body: string, idempotencyKey: string): Promise<string | null>;
}

export type ForgeFactory = () => ForgePort;

export function selectForge(
  config: { forge: string },
  adapters: Record<string, ForgeFactory>,
): ForgePort {
  const factory = adapters[config.forge];
  if (!factory) {
    throw new Error(`selectForge: no adapter registered for '${config.forge}'`);
  }
  return factory();
}
