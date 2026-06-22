import type { ForgePort } from "../forge.ts";

/** In-memory recording ForgePort for tests (the fakeIssueTracker analogue). */
export function fakeForge(): ForgePort & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async push(opts: { branch: string; sha: string }) {
      calls.push({ method: "push", args: [opts] });
    },
    async ensurePr(opts: { branch: string; base: string; title: string; body: string }) {
      calls.push({ method: "ensurePr", args: [opts] });
      return { ref: `fake-pr-${calls.length}`, url: `https://fake/pr/${calls.length}` };
    },
    async addPrComment(prRef: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addPrComment", args: [prRef, body, idempotencyKey] });
      return `fake-pr-comment-${calls.length}`;
    },
  };
}
