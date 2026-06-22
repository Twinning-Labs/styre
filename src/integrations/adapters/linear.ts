/**
 * The official-SDK Linear adapter — the thin vendor edge implementing the neutral
 * `IssueTrackerPort` behind `@linear/sdk`. This is the ONLY file in the repo allowed to import a
 * vendor SDK; the core depends solely on `../issue-tracker.ts` (the AgentRunner/provider precedent).
 *
 * Zero lock-in: every `@linear/sdk` import stays here. Name→id resolution is live per call (the
 * `linear_id_cache` optimization is deferred). The pure mapping helpers below are unit-tested; the
 * SDK-calling paths are not (the fake port covers the core), verified only by typecheck + build.
 *
 * SMOKE TEST (operator-run, no real API in CI — the Claude-adapter precedent): the adapter needs a
 * live workspace + a scratch issue. Run manually:
 *
 *   LINEAR_API_KEY=lin_api_xxx bun run -e '
 *     import { linearIssueTracker } from "./src/integrations/adapters/linear.ts";
 *     const t = linearIssueTracker();
 *     await t.setState("ENG-1", "in_progress");
 *     await t.setLabels("ENG-1", { add: ["styre"], remove: [] });
 *     console.log(await t.addComment("ENG-1", "smoke from styre", "smoke-" + Date.now()));
 *   '
 *
 * Expect: the issue moves to "In Progress", the "styre" label is added (if it exists), and a
 * comment is posted; re-running the same idempotencyKey returns null (no duplicate).
 */
import { LinearClient } from "@linear/sdk";
import type { IssueState, IssueTrackerPort } from "../issue-tracker.ts";

/** Neutral IssueState → Linear workflow-state NAME. Resolved to a team-scoped state id per call. */
const LINEAR_STATE_NAME: Record<IssueState, string> = {
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  blocked: "Blocked",
};

/** The hidden idempotency tag appended to a comment body and probed for on dedup. Pure. */
export function projKeyTag(idempotencyKey: string): string {
  return `<!-- proj-key: ${idempotencyKey} -->`;
}

/** A comment body carrying the hidden idempotency tag. Pure. */
export function taggedBody(body: string, idempotencyKey: string): string {
  return `${body}\n\n${projKeyTag(idempotencyKey)}`;
}

/** Label-safe delta: from current label names + a {add, remove} delta, compute the resulting
 *  label-name set. Adds win over removes only when also present; an add-name not in `available`
 *  is skipped (label creation is deferred to setup); a remove-name not currently present is a
 *  no-op. Preserves every label outside the delta. Pure — the id mapping happens at the call site. */
export function resolveLabelNames(
  current: string[],
  change: { add: string[]; remove: string[] },
  available: ReadonlySet<string>,
): string[] {
  const next = new Set(current);
  for (const name of change.remove) next.delete(name);
  for (const name of change.add) {
    if (available.has(name)) next.add(name);
  }
  return [...next];
}

/**
 * The Linear adapter. Backed by `new LinearClient({ apiKey })` (apiKey from opts or
 * `LINEAR_API_KEY`; a missing key is a setup/GOAL-INSTALL failure). Register as
 * `{ linear: () => linearIssueTracker() }`.
 */
export function linearIssueTracker(opts?: { apiKey?: string }): IssueTrackerPort {
  const apiKey = opts?.apiKey ?? process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "linearIssueTracker: no Linear API key. Set LINEAR_API_KEY (or pass opts.apiKey) — this is a setup/GOAL-INSTALL touchpoint.",
    );
  }
  const client = new LinearClient({ apiKey });

  return {
    async setState(ref: string, state: IssueState): Promise<void> {
      const issue = await client.issue(ref);
      const targetName = LINEAR_STATE_NAME[state];
      // No-op if already there (declarative).
      const currentState = await issue.state;
      if (currentState?.name === targetName) return;
      const team = await issue.team;
      if (!team) throw new Error(`linear.setState: issue ${ref} has no team`);
      const states = await team.states();
      const target = states.nodes.find((s) => s.name === targetName);
      if (!target) {
        throw new Error(
          `linear.setState: team has no workflow state named "${targetName}" (for ${ref})`,
        );
      }
      await client.updateIssue(issue.id, { stateId: target.id });
    },

    async setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void> {
      const issue = await client.issue(ref);
      const team = await issue.team;
      if (!team) throw new Error(`linear.setLabels: issue ${ref} has no team`);
      const currentLabels = await issue.labels();
      const teamLabels = await team.labels();
      // name → id over the team's labels (the set of labels we can resolve to ids).
      const nameToId = new Map<string, string>();
      for (const l of teamLabels.nodes) nameToId.set(l.name, l.id);
      const available = new Set(nameToId.keys());
      const currentNames = currentLabels.nodes.map((l) => l.name);
      const nextNames = resolveLabelNames(currentNames, change, available);
      // Preserve current labels whose name we couldn't resolve via the team (never clobber).
      const currentIdByName = new Map<string, string>();
      for (const l of currentLabels.nodes) currentIdByName.set(l.name, l.id);
      const labelIds = nextNames.map((name) => nameToId.get(name) ?? currentIdByName.get(name));
      await client.updateIssue(issue.id, {
        labelIds: labelIds.filter((id): id is string => id !== undefined),
      });
    },

    async addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null> {
      const issue = await client.issue(ref);
      const tag = projKeyTag(idempotencyKey);
      // Probe existing comments for the idempotency tag.
      const existing = await issue.comments();
      if (existing.nodes.some((c) => c.body.includes(tag))) return null;
      const payload = await client.createComment({
        issueId: issue.id,
        body: taggedBody(body, idempotencyKey),
      });
      return payload.commentId ?? null;
    },
  };
}
