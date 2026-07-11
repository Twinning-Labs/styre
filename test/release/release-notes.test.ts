// test/release/release-notes.test.ts
import { expect, test } from "bun:test";
import {
  buildMessages,
  extractText,
  isReleaseChore,
  parseGitLog,
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
