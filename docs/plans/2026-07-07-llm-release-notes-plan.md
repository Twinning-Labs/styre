# LLM-authored release notes & changelog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the git-cliff commit-subject prose in the GitHub Release body and `CHANGELOG.md` with Claude-authored, user-facing release notes, keeping git-cliff for the version bump and as a never-fail fallback.

**Architecture:** Two small Bun/TypeScript scripts — `scripts/release-notes.ts` (gathers the release's commits + diffstat, calls the Anthropic Messages API, prints markdown) and `scripts/prepend-changelog.ts` (pure: splices the new section onto `CHANGELOG.md`). The release workflow calls them, falling back to the existing `git cliff` commands if the LLM step fails. No change to version computation or release ordering.

**Tech Stack:** Bun runtime, TypeScript, `bun test`, GitHub Actions, git-cliff (unchanged), Anthropic Messages API via `fetch`.

## Global Constraints

- **Runtime is Bun.** Scripts follow the existing pattern: exported pure functions + an `if (import.meta.main)` CLI wrapper (see `scripts/render-formula.ts`). Tests use `bun:test` under `test/release/`.
- **Model:** `claude-sonnet-5` (operator chose Sonnet; this is the current Sonnet id). Overridable via env `RELEASE_NOTES_MODEL` (default `claude-sonnet-5`).
- **Do NOT send `temperature`, `top_p`, or `top_k`** — Sonnet 5 returns HTTP 400 on any of them. Omit `thinking` (adaptive is the Sonnet 5 default); the response is parsed by extracting `type === "text"` content blocks, which is correct whether or not thinking blocks are present.
- **Messages API call:** `POST https://api.anthropic.com/v1/messages`, headers `x-api-key: $ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`, `content-type: application/json`; body `{ model, max_tokens: 2048, system, messages: [{ role: "user", content }] }`. Non-streaming (output is small).
- **The notes generator must never block a release.** On any failure (missing key, non-2xx, empty output, git error) the script prints nothing to stdout, writes a diagnostic to stderr, and exits non-zero so the workflow falls back to `git cliff`.
- **`CHANGELOG.md` becomes append-managed** — the workflow prepends via `prepend-changelog.ts` and must never run `git cliff -o CHANGELOG.md` again (it would wipe prior LLM prose).
- **Group headings kept:** `### Features` (from `feat`), `### Bug Fixes` (from `fix`), `### Performance` (from `perf`); internal-only groups omitted. Claude produces the grouped section; the version heading is added by `prepend-changelog.ts` / the workflow, not by Claude.
- Spec: `docs/brainstorms/2026-07-07-llm-release-notes-design.md`.

---

### Task 1: `prepend-changelog.ts` (pure changelog splice)

**Files:**
- Create: `scripts/prepend-changelog.ts`
- Test: `test/release/prepend-changelog.test.ts`

**Interfaces:**
- Produces: `export function prependChangelog(existing: string, version: string, date: string, notes: string): string` — returns the merged changelog. `version` may carry a leading `v` (stripped). Idempotent: replaces an existing same-version section instead of duplicating it. CLI wrapper: `prepend-changelog.ts <version> <date> <notesFile> <changelogFile>` reads the two files (treating a missing changelog as empty) and writes the result back to `<changelogFile>`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/release/prepend-changelog.test.ts
import { expect, test } from "bun:test";
import { prependChangelog } from "../../scripts/prepend-changelog.ts";

const HEADER = "# Changelog\n\nAll notable changes to this project are documented here.\n";
const NOTES = "### Features\n- **Codex provider:** pick Codex as an agent provider.\n";

test("prepends a new section directly under the header, above existing sections", () => {
  const existing = `${HEADER}\n## [0.4.0] - 2026-07-06\n\n### Features\n- Old thing\n`;
  const out = prependChangelog(existing, "v0.5.0", "2026-07-07", NOTES);
  expect(out.startsWith(HEADER)).toBe(true);
  // new section is above the old one
  expect(out.indexOf("## [0.5.0] - 2026-07-07")).toBeLessThan(out.indexOf("## [0.4.0]"));
  expect(out).toContain("### Features\n- **Codex provider:**");
  expect(out).toContain("## [0.4.0] - 2026-07-06"); // old section preserved
});

test("strips a leading v from the version heading", () => {
  const out = prependChangelog(HEADER, "v0.5.0", "2026-07-07", NOTES);
  expect(out).toContain("## [0.5.0] - 2026-07-07");
  expect(out).not.toContain("## [v0.5.0]");
});

test("creates a default header when the changelog is empty", () => {
  const out = prependChangelog("", "0.5.0", "2026-07-07", NOTES);
  expect(out.startsWith("# Changelog")).toBe(true);
  expect(out).toContain("## [0.5.0] - 2026-07-07");
});

test("is idempotent: a second call for the same version replaces, not duplicates", () => {
  const once = prependChangelog(HEADER, "0.5.0", "2026-07-07", NOTES);
  const twice = prependChangelog(once, "0.5.0", "2026-07-07", "### Bug Fixes\n- Fixed X\n");
  expect(twice.match(/## \[0\.5\.0\]/g)?.length).toBe(1);
  expect(twice).toContain("### Bug Fixes\n- Fixed X");
  expect(twice).not.toContain("Codex provider"); // old body for this version replaced
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/release/prepend-changelog.test.ts`
Expected: FAIL — `prependChangelog` is not exported / module not found.

- [ ] **Step 3: Write the implementation**

```ts
// scripts/prepend-changelog.ts
const DEFAULT_HEADER =
  "# Changelog\n\nAll notable changes to this project are documented here.\n";

/** Splice a new `## [version] - date` section onto a changelog, directly under the header
 *  and above all prior version sections. Idempotent: an existing section for the same
 *  version is replaced (not duplicated), so re-runs heal rather than accrete. */
export function prependChangelog(
  existing: string,
  version: string,
  date: string,
  notes: string,
): string {
  const v = version.replace(/^v/, "");
  const section = `## [${v}] - ${date}\n\n${notes.trim()}\n`;

  const base = existing.trim() === "" ? DEFAULT_HEADER : existing;

  // If a section for this version already exists, replace it in place (up to the next
  // "## [" heading or EOF) — keeps re-runs idempotent.
  const sameVersion = new RegExp(`^## \\[${v.replace(/\\./g, "\\.")}\\][^\n]*\\n`, "m");
  const m = base.match(sameVersion);
  if (m && m.index !== undefined) {
    const start = m.index;
    const nextIdx = base.indexOf("\n## [", start + 1);
    const end = nextIdx === -1 ? base.length : nextIdx + 1;
    return `${base.slice(0, start)}${section}${base.slice(end)}`;
  }

  // Otherwise split at the first version section and insert above it.
  const firstIdx = base.indexOf("## [");
  if (firstIdx === -1) {
    const withNl = base.endsWith("\n") ? base : `${base}\n`;
    return `${withNl}\n${section}`;
  }
  const header = base.slice(0, firstIdx);
  const rest = base.slice(firstIdx);
  return `${header}${section}\n${rest}`;
}

if (import.meta.main) {
  const [version, date, notesFile, changelogFile] = process.argv.slice(2);
  if (!version || !date || !notesFile || !changelogFile) {
    process.stderr.write(
      "usage: prepend-changelog.ts <version> <date> <notesFile> <changelogFile>\n",
    );
    process.exit(2);
  }
  const notes = await Bun.file(notesFile).text();
  const existingFile = Bun.file(changelogFile);
  const existing = (await existingFile.exists()) ? await existingFile.text() : "";
  await Bun.write(changelogFile, prependChangelog(existing, version, date, notes));
  process.stdout.write(`updated ${changelogFile} with ${version} section\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/release/prepend-changelog.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/prepend-changelog.ts test/release/prepend-changelog.test.ts
git commit -m "feat(release): pure prepend-changelog splice"
```

---

### Task 2: `release-notes.ts` pure helpers

**Files:**
- Create: `scripts/release-notes.ts` (pure helpers only in this task; CLI + network added in Task 3)
- Test: `test/release/release-notes.test.ts`

**Interfaces:**
- Produces:
  - `export interface Commit { hash: string; subject: string; body: string }`
  - `export function parseGitLog(raw: string): Commit[]` — parses `git log --pretty=format:'%H%x1f%s%x1f%b%x1e'` output (field sep `\x1f`, record sep `\x1e`).
  - `export function isReleaseChore(subject: string): boolean` — matches `^chore\(release\)`.
  - `export function buildMessages(version: string, commits: Commit[], diffstat: string): { system: string; user: string }`.
  - `export function extractText(responseBody: unknown): string` — concatenates the `text` content blocks of a Messages API response; throws if none.

- [ ] **Step 1: Write the failing tests**

```ts
// test/release/release-notes.test.ts
import { expect, test } from "bun:test";
import {
  parseGitLog,
  isReleaseChore,
  buildMessages,
  extractText,
} from "../../scripts/release-notes.ts";

const RAW =
  "abc123\x1ffeat(run): in-place execution\x1fAdds --in-place flag.\x1e" +
  "def456\x1fchore(release): v0.4.0\x1f\x1e" +
  "ghi789\x1ffix(setup): reuse env\x1fFixes rebuild.\x1e";

test("parseGitLog splits records and fields", () => {
  const commits = parseGitLog(RAW);
  expect(commits).toHaveLength(3);
  expect(commits[0]).toEqual({
    hash: "abc123",
    subject: "feat(run): in-place execution",
    body: "Adds --in-place flag.",
  });
  expect(commits[1].subject).toBe("chore(release): v0.4.0");
});

test("parseGitLog tolerates empty output", () => {
  expect(parseGitLog("")).toEqual([]);
  expect(parseGitLog("\n")).toEqual([]);
});

test("isReleaseChore matches only release chores", () => {
  expect(isReleaseChore("chore(release): v0.4.0")).toBe(true);
  expect(isReleaseChore("feat(run): x")).toBe(false);
  expect(isReleaseChore("chore(deps): bump")).toBe(false);
});

test("buildMessages includes version, commit prose and diffstat, and grouping rules", () => {
  const { system, user } = buildMessages(
    "v0.5.0",
    [{ hash: "a", subject: "feat(run): x", body: "Body here." }],
    " src/run.ts | 10 +++\n 1 file changed",
  );
  expect(system).toContain("release notes");
  expect(system).toContain("### Features");
  expect(system).toContain("### Bug Fixes");
  expect(user).toContain("0.5.0");
  expect(user).toContain("feat(run): x");
  expect(user).toContain("Body here.");
  expect(user).toContain("1 file changed");
});

test("extractText concatenates text blocks and ignores thinking blocks", () => {
  const body = {
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "### Features\n- Thing one" },
      { type: "text", text: "\n### Bug Fixes\n- Thing two" },
    ],
  };
  expect(extractText(body)).toBe("### Features\n- Thing one\n### Bug Fixes\n- Thing two");
});

test("extractText throws when there is no text block", () => {
  expect(() => extractText({ content: [{ type: "thinking", thinking: "" }] })).toThrow();
  expect(() => extractText({})).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/release/release-notes.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Write the implementation (pure helpers)**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/release/release-notes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/release-notes.ts test/release/release-notes.test.ts
git commit -m "feat(release): release-notes pure helpers (git-log parse, prompt, extract)"
```

---

### Task 3: `release-notes.ts` network layer + CLI

**Files:**
- Modify: `scripts/release-notes.ts` (append `callAnthropic` + the `import.meta.main` CLI)

**Interfaces:**
- Consumes: `buildMessages`, `extractText`, `parseGitLog`, `isReleaseChore` from Task 2.
- Produces: `export async function callAnthropic(system: string, user: string): Promise<string>` — POSTs to the Messages API and returns `extractText(json)`; throws on missing key or non-2xx. CLI: `release-notes.ts <version> <sinceRef> <headRef>` prints the notes markdown to stdout, or exits non-zero (printing nothing to stdout) on any failure.

- [ ] **Step 1: Add the network + CLI code**

Append to `scripts/release-notes.ts`:

```ts
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
```

- [ ] **Step 2: Re-run the Task 2 unit tests (still green — pure helpers unchanged)**

Run: `bun test test/release/release-notes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 3: Typecheck + lint the new scripts**

Run: `bun run typecheck && bun run lint`
Expected: PASS (no errors in the two new files).

- [ ] **Step 4: Manual smoke against a real range (requires `ANTHROPIC_API_KEY`)**

Run:
```bash
ANTHROPIC_API_KEY=$KEY bun run scripts/release-notes.ts v0.5.0 v0.4.0 HEAD
```
Expected: prints grouped `### Features` / `### Bug Fixes` markdown, user-facing, no `feat(...)` prefixes or PR numbers. Then confirm the fallback path:
```bash
env -u ANTHROPIC_API_KEY bun run scripts/release-notes.ts v0.5.0 v0.4.0 HEAD; echo "exit=$?"
```
Expected: nothing on stdout, a `release-notes: ... ANTHROPIC_API_KEY is not set` line on stderr, `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-notes.ts
git commit -m "feat(release): release-notes Messages API call + CLI (fallback-safe)"
```

---

### Task 4: Wire the scripts into the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/release-notes.ts` and `scripts/prepend-changelog.ts` CLIs from Tasks 1–3.

- [ ] **Step 1: Add the `release_notes` dispatch input**

Under `on.workflow_dispatch.inputs` (after `expected_version`), add:

```yaml
      release_notes:
        description: "Optional: paste hand-written release notes to use verbatim (skips the LLM)."
        type: string
        default: ""
```

- [ ] **Step 2: Replace the dry-run notes preview in the `compute` job**

In the "Dry-run preview" step (`compute` job), add an env block and swap the release-notes line to use the script with a git-cliff fallback. Replace:

```yaml
      - name: Dry-run preview (version + release notes + full committed changelog)
        if: inputs.dry_run && steps.ver.outputs.should_release == 'true'
        run: |
          echo "next version = ${{ steps.ver.outputs.version }}"
          echo "===== GitHub Release body (this version only) ====="
          git cliff --unreleased --tag "${{ steps.ver.outputs.version }}" --strip all -o -
          echo "===== Full committed CHANGELOG.md ====="
          git cliff --tag "${{ steps.ver.outputs.version }}" -o -
```

with:

```yaml
      - name: Dry-run preview (version + release notes + full committed changelog)
        if: inputs.dry_run && steps.ver.outputs.should_release == 'true'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          V: ${{ steps.ver.outputs.version }}
          SHA0: ${{ steps.pin.outputs.sha0 }}
        run: |
          echo "next version = $V"
          SINCE="$(git describe --tags --abbrev=0 "$SHA0")"
          echo "===== GitHub Release body (this version only — Claude-authored) ====="
          if ! bun run scripts/release-notes.ts "$V" "$SINCE" "$SHA0"; then
            echo "::warning::LLM notes failed; showing git-cliff fallback"
            git cliff --unreleased --tag "$V" --strip all -o -
          fi
```

Note: `bun` is available because the preview needs it — add a `setup-bun` step + `bun install --frozen-lockfile` to the `compute` job **before** this step (mirror the `publish` job's two steps), since `compute` currently has no Bun.

- [ ] **Step 3: Add Bun to the `compute` job**

In the `compute` job `steps`, immediately after the `actions/checkout` step and before "Install git-cliff", insert:

```yaml
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6  # v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
```

- [ ] **Step 4: Replace the two render steps in the `publish` job**

Replace:

```yaml
      - name: Render full changelog file (committed to the repo)
        env:
          V: ${{ needs.compute.outputs.version }}
        run: git cliff --tag "$V" -o CHANGELOG.md
      - name: Render release notes (THIS version only — for the GitHub Release body)
        env:
          V: ${{ needs.compute.outputs.version }}
        run: git cliff --unreleased --tag "$V" --strip all -o RELEASE_NOTES.md
```

with (note the order flips — notes are rendered first, then spliced into the changelog):

```yaml
      - name: Render release notes (THIS version only — Claude-authored, cliff fallback)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          V: ${{ needs.compute.outputs.version }}
          SHA0: ${{ needs.compute.outputs.sha0 }}
          RELEASE_NOTES: ${{ inputs.release_notes }}
        run: |
          if [ -n "$RELEASE_NOTES" ]; then
            printf '%s\n' "$RELEASE_NOTES" > RELEASE_NOTES.md
          else
            SINCE="$(git describe --tags --abbrev=0 "$SHA0")"
            if ! bun run scripts/release-notes.ts "$V" "$SINCE" "$SHA0" > RELEASE_NOTES.md; then
              echo "::warning::LLM notes failed; falling back to git-cliff"
              git cliff --unreleased --tag "$V" --strip all -o RELEASE_NOTES.md
            fi
          fi
      - name: Splice this version's notes onto CHANGELOG.md (append-managed)
        env:
          V: ${{ needs.compute.outputs.version }}
        run: |
          bun run scripts/prepend-changelog.ts "$V" "$(date -u +%Y-%m-%d)" RELEASE_NOTES.md CHANGELOG.md
```

Everything downstream (the "Stamp + commit" step already runs `git add package.json CHANGELOG.md`, tags, creates the Release with `--notes-file RELEASE_NOTES.md`, bumps the tap) is unchanged.

- [ ] **Step 5: Confirm the secret reference + validate the workflow**

Confirm `ANTHROPIC_API_KEY` is referenced only via `secrets.ANTHROPIC_API_KEY` (compute preview + publish render steps). Validate YAML parses:

Run: `bun x --yes js-yaml .github/workflows/release.yml >/dev/null && echo OK` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`)
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): wire Claude release notes + changelog into the release workflow"
```

---

## Post-implementation (operator-required)

- **`ANTHROPIC_API_KEY` repo secret** must be added to `Twinning-Labs/styre` (Settings → Secrets → Actions) before the next real release. Until then the workflow degrades to git-cliff notes via the fallback (release never blocks). Flag this in the PR body — it is the one manual step the plan cannot perform.
- **Independent adversarial review** of the change (code-grounded persona panel) after implementation, per operator convention, before the branch is considered done.

## Self-review

- **Spec coverage:** LLM-authored notes (Tasks 2–3) ✓; kept type groupings (system prompt, Task 2) ✓; GitHub Release body = this version (Task 4 render step) ✓; CHANGELOG prepend/append-managed (Task 1 + Task 4 splice step) ✓; git-cliff fallback (Tasks 3–4) ✓; dry-run preview shows real notes (Task 4 Step 2) ✓; manual `release_notes` override input (Task 4 Steps 1, 4) ✓; `ANTHROPIC_API_KEY` secret (Task 4 + post-impl) ✓; Sonnet + no sampling params (Global Constraints, Task 3) ✓; version bump & release ordering untouched (no task changes cliff `--bumped-version` or the commit/tag/push flow) ✓.
- **Placeholder scan:** none — every step has concrete code or exact commands.
- **Type consistency:** `Commit`, `parseGitLog`, `isReleaseChore`, `buildMessages`, `extractText`, `callAnthropic`, `prependChangelog` names/signatures are used identically across tasks and the workflow CLI invocations (`release-notes.ts <version> <sinceRef> <headRef>`, `prepend-changelog.ts <version> <date> <notesFile> <changelogFile>`).
