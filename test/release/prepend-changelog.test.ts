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

test("strips a leading '## [..]' heading from notes (git-cliff fallback) — no double heading", () => {
  // git cliff --unreleased --strip all still emits a per-release heading.
  const cliffNotes = "## [0.5.0] - 2026-07-07\n\n### Features\n- New thing\n";
  const out = prependChangelog(HEADER, "0.5.0", "2026-07-07", cliffNotes);
  expect(out.match(/## \[0\.5\.0\]/g)?.length).toBe(1); // exactly one heading, not two
  expect(out).toContain("### Features\n- New thing");
});

test("replace-path keeps a blank line before the following section", () => {
  const existing = `${HEADER}## [0.5.0] - 2026-07-07\n\n- old\n\n## [0.4.0] - 2026-07-06\n\n- older\n`;
  const out = prependChangelog(existing, "0.5.0", "2026-07-07", "### Bug Fixes\n- Fixed X\n");
  // the replaced section's last line is separated from the next heading by a blank line
  expect(out).toContain("- Fixed X\n\n## [0.4.0]");
});
