// scripts/changelog-section.ts
/** Return the body of the `## [version]` section of a changelog (heading stripped),
 *  or null if absent. Used on a heal re-run to reuse the already-committed release
 *  notes for the GitHub Release body instead of regenerating them non-deterministically. */
export function extractSection(changelog: string, version: string): string | null {
  const v = version.replace(/^v/, "");
  const re = new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\][^\n]*\n`, "m");
  const m = changelog.match(re);
  if (!m || m.index === undefined) return null;
  const afterHeading = m.index + m[0].length;
  const nextIdx = changelog.indexOf("\n## [", afterHeading);
  const end = nextIdx === -1 ? changelog.length : nextIdx + 1;
  return changelog.slice(afterHeading, end).trim();
}

if (import.meta.main) {
  const [version, changelogFile] = process.argv.slice(2);
  if (!version || !changelogFile) {
    process.stderr.write("usage: changelog-section.ts <version> <changelogFile>\n");
    process.exit(2);
  }
  const changelog = await Bun.file(changelogFile).text();
  const section = extractSection(changelog, version);
  if (section === null || section === "") {
    process.stderr.write(`no section for ${version} in ${changelogFile}\n`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
