// ENG-485: the stop, sweep, leftover and recovery messages in docs/architecture/runtime-parameters.md
// cannot drift from the code. Both directions:
//   1. every `styre: …` line documented between the `messages:begin` and `messages:end` markers is a
//      message in src/ (same text, with each `<placeholder>` standing where the code interpolates);
//   2. every `styre: …` message that the stop handler, the sweep, the leftover check, recovery and
//      the exit check can print (the files in COVERED) is documented there.
// Messages are read from the source with the TypeScript compiler API: string literals and template
// literals whose text starts with "styre: ". A trailing newline is not part of the message.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");
const DOC = join(ROOT, "docs/architecture/runtime-parameters.md");
/** Files whose every `styre: …` message must be documented. */
const COVERED = [
  "src/util/process/signals.ts",
  "src/util/process/sweep.ts",
  "src/util/process/leftovers.ts",
  "src/util/process/interruption.ts",
  "src/util/process/door.ts",
  "src/util/process/stop.ts",
  "src/util/process/records.ts",
  "src/util/process/proc-table.ts",
  "src/cli/exit-check.ts",
];
/** Where a placeholder stands in a normalized message. */
const HOLE = "\u0000";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

/** Every `styre: …` message in one source file, each interpolation replaced by HOLE. */
function sourceMessages(text: string, name = "x.ts"): string[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    let msg: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) msg = n.text;
    else if (ts.isTemplateExpression(n)) {
      msg = n.head.text + n.templateSpans.map((s) => HOLE + s.literal.text).join("");
    }
    if (msg?.startsWith("styre: ")) out.push(msg.replace(/\n$/, ""));
    // Do not descend into a template's spans for a second, partial match: a span's own literals
    // are pieces of the same message.
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
    else for (const s of n.templateSpans) ts.forEachChild(s.expression, visit);
  };
  visit(sf);
  return out;
}

/** Every documented message line between the markers, each `<placeholder>` replaced by HOLE. */
function docMessages(text: string): string[] {
  const begin = text.indexOf("<!-- messages:begin -->");
  const end = text.indexOf("<!-- messages:end -->");
  if (begin < 0 || end < begin) throw new Error("the messages markers are missing");
  const out: string[] = [];
  let inFence = false;
  for (const line of text.slice(begin, end).split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence && line.startsWith("styre: ")) out.push(line.replace(/<[^<>]+>/g, HOLE));
  }
  return out;
}

const show = (m: string): string => m.replaceAll(HOLE, "<…>");

test("every message documented in runtime-parameters.md is a message in src/", () => {
  const inSource = new Set(
    files(join(ROOT, "src")).flatMap((f) => sourceMessages(readFileSync(f, "utf8"), f)),
  );
  const documented = docMessages(readFileSync(DOC, "utf8"));
  expect(documented.length).toBeGreaterThan(30);
  const missing = documented.filter((m) => !inSource.has(m)).map(show);
  expect(missing).toEqual([]);
});

test("every message the stop handler, the sweep, leftovers and recovery print is documented", () => {
  const documented = new Set(docMessages(readFileSync(DOC, "utf8")));
  const undocumented: string[] = [];
  let seen = 0;
  for (const rel of COVERED) {
    for (const m of sourceMessages(readFileSync(join(ROOT, rel), "utf8"), rel)) {
      seen++;
      if (!documented.has(m)) undocumented.push(`${relative(ROOT, join(ROOT, rel))}: ${show(m)}`);
    }
  }
  expect(seen).toBeGreaterThan(25);
  expect(undocumented).toEqual([]);
});

test("the readers see what they must: interpolations, ternaries of whole messages, placeholders", () => {
  const src = [
    "const a = `styre: stopped the agent (pid ${pid}) and ${n} of its commands.\\n`;",
    'const b = x ? "styre: stopping — plain…\\n" : `styre: received (${sig}) — cleaning up…\\n`;',
    'const c = `styre: could not stop the orphaned ${k === "agent" ? "agent" : "command"} (pid ${p})`;',
    'const d = "not a styre message";',
  ].join("\n");
  expect(sourceMessages(src).map(show)).toEqual([
    "styre: stopped the agent (pid <…>) and <…> of its commands.",
    "styre: stopping — plain…",
    "styre: received (<…>) — cleaning up…",
    "styre: could not stop the orphaned <…> (pid <…>)",
  ]);
  const doc = [
    "styre: outside the markers",
    "<!-- messages:begin -->",
    "```",
    "styre: stopped the agent (pid <pid>) and <n> of its commands.",
    "```",
    "styre: prose, not in a fence",
    "<!-- messages:end -->",
  ].join("\n");
  expect(docMessages(doc).map(show)).toEqual([
    "styre: stopped the agent (pid <…>) and <…> of its commands.",
  ]);
});
