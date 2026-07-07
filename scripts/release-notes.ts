// scripts/release-notes.ts
export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/** Parse `git log --pretty=format:'%H%x1f%s%x1f%b%x1e'` output. */
export function parseGitLog(raw: string): Commit[] {
  return raw
    .split(RECORD_SEP)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [hash = "", subject = "", body = ""] = r.split(FIELD_SEP);
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
    });
}

/** The release-stamp commits the projector makes — excluded from notes (mirrors cliff.toml). */
export function isReleaseChore(subject: string): boolean {
  return /^chore\(release\)/.test(subject);
}

const SYSTEM_PROMPT = `You write release notes for the "styre" command-line tool, in the register of the Claude Code changelog: user-facing, plain language, present tense.

Rules:
- Write for someone who uses styre, not someone who wrote the diff.
- No conventional-commit prefixes (no "feat(scope):"), no PR numbers, no commit hashes, no marketing fluff.
- Drop internal-only churn (pure refactors, test-only, CI, chore) unless it is user-visible.
- Group changes under these headings, in this order, omitting any that are empty:
  ### Features        (from feat commits)
  ### Bug Fixes       (from fix commits)
  ### Performance     (from perf commits)
- Each bullet is one self-contained sentence. Use a bold lead-in only when it aids scanning.
- Output ONLY the grouped markdown section body. Do NOT include a top-level "## [version]" heading or a date — those are added downstream.`;

export function buildMessages(
  version: string,
  commits: Commit[],
  diffstat: string,
): { system: string; user: string } {
  const v = version.replace(/^v/, "");
  const changeList = commits
    .map((c) => `- ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, "\n  ")}` : ""}`)
    .join("\n");
  const user = [
    `Write the release notes for styre version ${v}.`,
    "",
    "Merged changes since the last release (commit subject, then its body/PR description):",
    changeList || "(no changes)",
    "",
    "File-level diffstat for scope context:",
    "```",
    diffstat.trim() || "(none)",
    "```",
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
}

/** Concatenate the text content blocks of a Messages API response. Throws if none. */
export function extractText(responseBody: unknown): string {
  const content = (responseBody as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    throw new Error("Anthropic response has no content array");
  }
  const text = content
    .filter((b): b is { type: "text"; text: string } => {
      const t = b as { type?: unknown; text?: unknown };
      return t.type === "text" && typeof t.text === "string";
    })
    .map((b) => b.text)
    .join("");
  if (text.trim() === "") {
    throw new Error("Anthropic response has no text content");
  }
  return text.trim();
}

const API_URL = "https://api.anthropic.com/v1/messages";

export async function callAnthropic(system: string, user: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = process.env.RELEASE_NOTES_MODEL || "claude-sonnet-5";
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    // No temperature/top_p/top_k and no thinking field: Sonnet 5 rejects sampling
    // params (400) and defaults to adaptive thinking; extractText ignores thinking blocks.
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return extractText(await res.json());
}

function git(args: string[]): string {
  const p = Bun.spawnSync(["git", ...args]);
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  }
  return new TextDecoder().decode(p.stdout);
}

if (import.meta.main) {
  const [version, sinceRef, headRef] = process.argv.slice(2);
  if (!version || !sinceRef || !headRef) {
    process.stderr.write("usage: release-notes.ts <version> <sinceRef> <headRef>\n");
    process.exit(2);
  }
  try {
    const raw = git([
      "log",
      `${sinceRef}..${headRef}`,
      "--no-merges",
      "--pretty=format:%H%x1f%s%x1f%b%x1e",
    ]);
    const commits = parseGitLog(raw).filter((c) => !isReleaseChore(c.subject));
    const diffstat = git(["diff", "--stat", `${sinceRef}..${headRef}`]);
    const { system, user } = buildMessages(version, commits, diffstat);
    const notes = await callAnthropic(system, user);
    process.stdout.write(notes.endsWith("\n") ? notes : `${notes}\n`);
  } catch (err) {
    // Print NOTHING to stdout on failure so the workflow's git-cliff fallback runs.
    process.stderr.write(`release-notes: ${String(err)}\n`);
    process.exit(1);
  }
}
