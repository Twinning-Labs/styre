import type { ForgePort } from "../forge.ts";

/** In-memory recording ForgePort for tests (the fakeIssueTracker analogue). Stateful: tracks
 *  created PRs per branch so `ensurePr` can reconcile the body on reuse (mirrors the real adapter). */
export function fakeForge(): ForgePort & {
  calls: Array<{ method: string; args: unknown[] }>;
  prs: Map<string, { ref: string; url: string; body: string }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const prs = new Map<string, { ref: string; url: string; body: string }>();
  return {
    calls,
    prs,
    async push(opts: { branch: string; sha: string }) {
      calls.push({ method: "push", args: [opts] });
    },
    async ensurePr(opts: { branch: string; base: string; title: string; body: string }) {
      calls.push({ method: "ensurePr", args: [opts] });
      const existing = prs.get(opts.branch);
      if (existing) {
        if (existing.body !== opts.body) {
          existing.body = opts.body;
          calls.push({ method: "updatePrBody", args: [{ branch: opts.branch, body: opts.body }] });
        }
        return { ref: existing.ref, url: existing.url };
      }
      const n = prs.size + 1;
      const rec = { ref: `fake-pr-${n}`, url: `https://fake/pr/${n}`, body: opts.body };
      prs.set(opts.branch, rec);
      return { ref: rec.ref, url: rec.url };
    },
    async addPrComment(prRef: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addPrComment", args: [prRef, body, idempotencyKey] });
      return `fake-pr-comment-${calls.length}`;
    },
  };
}
