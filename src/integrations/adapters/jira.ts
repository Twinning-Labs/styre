/**
 * The hand-rolled JIRA Cloud adapter — the thin vendor edge implementing the neutral
 * `IssueTrackerPort` over the JIRA REST API v3 (Basic auth, `fetch`; NO SDK — jira.js is
 * single-maintainer 3P and does no ADF conversion). Only file in the repo that talks to JIRA.
 *
 * Per the adapter convention (linear.ts / github.ts): the DECISION logic lives in the pure helpers
 * below (unit-tested); the HTTP-calling methods in the factory are thin shells, covered by the fake
 * port + this smoke test, not unit tests.
 *
 * SMOKE TEST (operator-run, no real API in CI): a Cloud site + a scratch issue, then:
 *
 *   JIRA_BASE_URL=https://you.atlassian.net JIRA_EMAIL=you@x.com JIRA_API_TOKEN=xxx bun run -e '
 *     import { jiraIssueTracker } from "./src/integrations/adapters/jira.ts";
 *     const t = jiraIssueTracker();
 *     console.log(await t.fetchTicket("PROJ-1"));
 *     console.log(await t.setState("PROJ-1", "in_progress"));
 *     await t.setLabels("PROJ-1", { add: ["styre"], remove: [] });
 *     console.log(await t.addComment("PROJ-1", "smoke from styre", "smoke-" + Date.now()));
 *   '
 *
 * Expect: the ticket prints; setState returns {applied:true} (or {applied:false, reason} if the
 * workflow has no path); the "styre" label is added; a comment posts and a repeat key returns null.
 */
// NOTE: import ONLY what the helpers below use (this repo's tsc has noUnusedLocals + biome
// noUnusedImports — an unused import fails typecheck/lint). IssueTrackerPort, SetStateResult,
// IngestedTicket, and adfToMarkdown are added in Task 4 on the same edit that adds the factory.
import type { IssueState } from "../issue-tracker.ts";
import type { TypeLabel } from "../ticket-source.ts";

export interface JiraStatusTarget {
  status: string;
  resolution?: string;
}

export interface JiraAdapterConfig {
  /** neutral IssueState -> target JIRA status (+ optional resolution). */
  statusMap?: Record<string, JiraStatusTarget>;
  /** issue-type names treated as Bug (default ["Bug"]). */
  bugTypeNames?: string[];
}

/** Default neutral IssueState -> {status, resolution?}. Overridable via config.statusMap.
 *  NOTE: `resolution` is matched by NAME against the site's configured resolutions ("Done",
 *  "Won't Do" are the current Jira Cloud defaults but instances vary — e.g. "Won't Fix" or
 *  localized names). A name that doesn't exist yields a 400 on the transition, which setState
 *  soft-fails (board unchanged + a projection_skipped note) rather than crashing — override via
 *  config.statusMap if your site differs. */
const DEFAULT_STATUS_MAP: Record<IssueState, JiraStatusTarget> = {
  in_progress: { status: "In Progress" },
  in_review: { status: "In Review" },
  done: { status: "Done", resolution: "Done" },
  canceled: { status: "Done", resolution: "Won't Do" },
  blocked: { status: "In Progress" },
};

export function resolveStatusTarget(state: IssueState, cfg?: JiraAdapterConfig): JiraStatusTarget {
  return cfg?.statusMap?.[state] ?? DEFAULT_STATUS_MAP[state];
}

/** Bug -> Bug (fix/), everything else -> Feature (feat/). Case-insensitive; bugTypeNames override. */
export function jiraTypeLabel(issueTypeName: string, bugTypeNames?: string[]): TypeLabel {
  const bugs = (bugTypeNames ?? ["Bug"]).map((s) => s.toLowerCase());
  return bugs.includes(issueTypeName.toLowerCase()) ? "Bug" : "Feature";
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
  // `hasDefaultValue`: JIRA auto-fills the field on the transition, so a required field with a
  // default needs NO client value (transitions.fields carries this alongside `required`).
  fields?: Record<string, { required: boolean; hasDefaultValue?: boolean }>;
}

export type TransitionPick =
  | { kind: "found"; id: string; setResolution: boolean }
  | { kind: "none" }
  | { kind: "unsatisfiable" };

/** Given the issue's available transitions and the desired {status, resolution?}, choose the
 *  transition to POST. `none` = no transition reaches the target status; `unsatisfiable` = matched
 *  but a required screen field we can neither supply nor rely on JIRA to default (we can only supply
 *  `resolution`, and only when configured). `setResolution` = send resolution (configured AND the
 *  screen offers the field). */
export function pickTransition(
  transitions: JiraTransition[],
  target: JiraStatusTarget,
): TransitionPick {
  const match = transitions.find((t) => t.to?.name?.toLowerCase() === target.status.toLowerCase());
  if (!match) return { kind: "none" };
  const fields = match.fields ?? {};
  // A field JIRA will auto-fill (hasDefaultValue) needs no client value even if `required`.
  const required = Object.entries(fields)
    .filter(([, f]) => f.required && !f.hasDefaultValue)
    .map(([k]) => k);
  const canSupply = new Set<string>();
  if (target.resolution) canSupply.add("resolution");
  if (required.some((k) => !canSupply.has(k))) return { kind: "unsatisfiable" };
  return {
    kind: "found",
    id: match.id,
    setResolution: !!target.resolution && "resolution" in fields,
  };
}

/** Atomic JIRA label edit ops (no read-merge; never clobbers labels outside the delta). */
export function labelUpdateOps(change: {
  add: string[];
  remove: string[];
}): { update: { labels: ({ add: string } | { remove: string })[] } } {
  return {
    update: {
      labels: [
        ...change.add.map((l) => ({ add: l })),
        ...change.remove.map((l) => ({ remove: l })),
      ],
    },
  };
}

/** Visible dedup marker embedded in a comment (ADF has no hidden-comment node). Pure. */
export function projKeyMarker(idempotencyKey: string): string {
  return `[proj-key:${idempotencyKey}]`;
}

/** Minimal ADF comment doc: the body paragraph + a marker paragraph for dedup. */
export function adfComment(body: string, idempotencyKey: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: body }] },
      { type: "paragraph", content: [{ type: "text", text: projKeyMarker(idempotencyKey) }] },
    ],
  };
}

/** Probe serialized comment bodies (ADF JSON) for the idempotency marker. */
export function commentHasMarker(commentBodies: unknown[], idempotencyKey: string): boolean {
  const marker = projKeyMarker(idempotencyKey);
  return commentBodies.some((b) => JSON.stringify(b ?? "").includes(marker));
}

/** Map a non-2xx JIRA response to a typed Error carrying `.status`. Parses JIRA's
 *  `{errorMessages, errors}` body; 401 -> a clear expired/invalid-token message. */
export function mapJiraError(status: number, bodyText: string): Error & { status: number } {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})];
    if (parts.length) detail = parts.join("; ");
  } catch {
    /* non-JSON body; keep raw text */
  }
  const msg =
    status === 401
      ? `jira: 401 unauthorized — JIRA_API_TOKEN invalid or expired (regenerate it). ${detail}`
      : `jira: HTTP ${status} — ${detail}`;
  const e = new Error(msg.trim()) as Error & { status: number };
  e.status = status;
  return e;
}

// --- factory (jiraIssueTracker) added in Task 4 ---
