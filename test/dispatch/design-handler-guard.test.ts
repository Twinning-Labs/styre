import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// spec §3 (E8): design handlers read upstream rows only through the named accessors in
// src/daemon/design-reads.ts, which check the current step at run time. This guard keeps the
// design handler blocks in handlers.ts from calling the upstream repositories directly, or naming
// their tables in raw SQL. It reads only the block text: a helper called from a block, a namespace
// import or a query built elsewhere is not seen; the run time accessor check and the recording
// proxy test cover those reads.
const SOURCE = readFileSync(join(import.meta.dir, "../../src/dispatch/handlers.ts"), "utf8");
const GUARDED = ["work-unit", "review-finding", "review-round", "ticket"];
/** Upstream tables a design block must not query as raw SQL either (the accessor reads them). */
const GUARDED_TABLES = ["work_unit", "review_finding"];

function importedNames(source: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/db\/repos\/([a-z-]+)\.ts"/g;
  for (const m of source.matchAll(re)) {
    if (!GUARDED.includes(m[2])) continue;
    for (const part of m[1].split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.replace(/^type\s+/, "")
        .trim();
      if (local && !/^[A-Z]/.test(local)) names.push(local); // values, not types
    }
  }
  return names;
}

/** The text of each `registry.register("<key>", ...)` call for the design table's steps. */
function designBlocks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /registry\.register\(\s*"(provision|design:[a-z]+)"/g;
  for (const m of source.matchAll(re)) {
    let depth = 0;
    let i = source.indexOf("(", m.index);
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    out.set(m[1], source.slice(start, i + 1));
  }
  return out;
}

test("design handlers do not call the upstream repositories directly", () => {
  const names = importedNames(SOURCE);
  expect(names.length).toBeGreaterThan(0);
  const blocks = designBlocks(SOURCE);
  expect([...blocks.keys()].sort()).toEqual(
    ["design:dispatch", "design:extract", "design:review", "design:size", "provision"].sort(),
  );
  const offences: string[] = [];
  for (const [key, text] of blocks) {
    for (const name of names) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(text)) offences.push(`${key} calls ${name}`);
    }
    // \b on both sides: `work_unit_seq` (a sidecar field design:review reads) is not the table.
    for (const table of GUARDED_TABLES) {
      if (new RegExp(`\\b${table}\\b`).test(text)) offences.push(`${key} names table ${table}`);
    }
  }
  expect(offences).toEqual([]);
});
