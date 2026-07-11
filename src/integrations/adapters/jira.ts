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
import type { IssueState, IssueTrackerPort, SetStateResult } from "../issue-tracker.ts";
import type { IngestedTicket, TypeLabel } from "../ticket-source.ts";
import { adfToMarkdown } from "./jira-adf.ts";

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

/**
 * The JIRA adapter. Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN (or opts overrides); a missing
 * value is a setup/GOAL-INSTALL failure. Register as `{ jira: () => jiraIssueTracker(runtimeConfig.jira) }`.
 */
export function jiraIssueTracker(
  opts?: JiraAdapterConfig & { baseUrl?: string; email?: string; token?: string },
): IssueTrackerPort {
  const baseUrl = opts?.baseUrl ?? process.env.JIRA_BASE_URL;
  const email = opts?.email ?? process.env.JIRA_EMAIL;
  const token = opts?.token ?? process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new Error(
      "jiraIssueTracker: missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN — this is a setup/GOAL-INSTALL touchpoint.",
    );
  }
  const site = baseUrl.replace(/\/$/, "");
  const api = `${site}/rest/api/3`;
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<unknown> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && !retried) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? "1") || 1, 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return request(method, path, body, true);
    }
    if (!res.ok) throw mapJiraError(res.status, await res.text());
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    async fetchTicket(ref: string): Promise<IngestedTicket> {
      const issue = (await request(
        "GET",
        `/issue/${ref}?fields=summary,description,issuetype`,
      )) as {
        id: string;
        key: string;
        fields: { summary: string; description: unknown; issuetype?: { name?: string } };
      };
      const md = adfToMarkdown(issue.fields.description);
      return {
        ident: issue.key,
        title: issue.fields.summary,
        description: md === "" ? null : md,
        typeLabel: jiraTypeLabel(issue.fields.issuetype?.name ?? "", opts?.bugTypeNames),
        externalId: issue.id,
        url: `${site}/browse/${issue.key}`,
      };
    },

    async setState(ref: string, state: IssueState): Promise<SetStateResult> {
      const target = resolveStatusTarget(state, opts);
      // Probe current status: already there → applied (idempotent, crash-safe — CL-3).
      const cur = (await request("GET", `/issue/${ref}?fields=status`)) as {
        fields?: { status?: { name?: string } };
      };
      if (cur.fields?.status?.name?.toLowerCase() === target.status.toLowerCase()) {
        return { applied: true };
      }

      const tr = (await request("GET", `/issue/${ref}/transitions?expand=transitions.fields`)) as {
        transitions?: JiraTransition[];
      };
      const pick = pickTransition(tr.transitions ?? [], target);
      if (pick.kind !== "found") {
        // Soft-fail: no reachable transition / unsatisfiable required field. Board left unchanged;
        // the projector records a structured projection_skipped telemetry note.
        return {
          applied: false,
          reason: `${pick.kind}: no usable transition to "${target.status}"`,
        };
      }
      const payload: { transition: { id: string }; fields?: { resolution: { name: string } } } = {
        transition: { id: pick.id },
      };
      if (pick.setResolution && target.resolution) {
        payload.fields = { resolution: { name: target.resolution } };
      }
      try {
        await request("POST", `/issue/${ref}/transitions`, payload);
        return { applied: true };
      } catch (err) {
        const st = (err as { status?: number }).status;
        if (st === 400 || st === 422) {
          // Screen/field rejection = workflow mismatch → soft-fail (not a transport failure).
          return {
            applied: false,
            reason: `transition to "${target.status}" rejected (HTTP ${st})`,
          };
        }
        throw err; // transport (5xx/401/network) → outbox retries
      }
    },

    async setLabels(ref: string, change: { add: string[]; remove: string[] }): Promise<void> {
      if (change.add.length === 0 && change.remove.length === 0) return;
      await request("PUT", `/issue/${ref}`, labelUpdateOps(change));
    },

    async addComment(ref: string, body: string, idempotencyKey: string): Promise<string | null> {
      // Probe existing comments for the marker (dedup); paginate to `total`.
      const bodies: unknown[] = [];
      let startAt = 0;
      for (;;) {
        const page = (await request(
          "GET",
          `/issue/${ref}/comment?startAt=${startAt}&maxResults=100`,
        )) as { comments?: { body: unknown }[]; total?: number };
        const batch = page.comments ?? [];
        for (const c of batch) bodies.push(c.body);
        startAt += batch.length;
        if (batch.length === 0 || startAt >= (page.total ?? 0)) break;
      }
      if (commentHasMarker(bodies, idempotencyKey)) return null;
      const created = (await request("POST", `/issue/${ref}/comment`, {
        body: adfComment(body, idempotencyKey),
      })) as { id?: string };
      return created.id ?? null;
    },
  };
}
