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
  const sameVersion = new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\][^\n]*\n`, "m");
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
