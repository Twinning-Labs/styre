// ENG-485: the `styre: …` messages in docs/architecture/runtime-parameters.md cannot drift from the
// code. It reads every TypeScript file under src/ with the TypeScript compiler API.
//
// A message is a string or template literal whose text starts with "styre: ". Each `${…}` is a hole,
// and a trailing newline is not part of the message. The doc's messages are the fenced `styre: `
// lines between `<!-- messages:begin -->` and `<!-- messages:end -->`; each `<name>` is a hole.
// A doc line and a source message match when their texts match hole for hole, and each hole named
// `<pid>` in the doc stands where the code interpolates a pid (an expression `pid` or `….pid`), and
// no other hole does. A hole that picks between two string literals (`k ? "agent" : "command"`) must
// be named with both, in order (`<agent or command>`), so rewording either is seen.
//
// The tests:
//   1. every documented line matches a message in src/;
//   2. every message in src/ is documented, apart from EXCEPTIONS, which must each still exist in
//      src/ and not be documented;
//   3. no message is built from parts the reader cannot see whole: a `styre:` literal that is an
//      operand of `+`, a literal that is only the prefix (or has no word after it, as a helper's
//      `styre: ${m}` does), or a template that starts with a constant whose value starts with
//      "styre", whether the constant is in the same file or imported from another file under src/
//      (by name, renamed, or through a namespace). Each is reported loudly, never read in part;
//   4. the readers themselves.
// Stated limits: a message assembled at run time in a way none of these forms shows is not seen: an
// array join, a format function whose literal pieces are not `styre:` literals, a constant re-exported
// through another module, or text a helper returns into a hole (only a hole that is itself a choice
// between two literals is compared word for word).
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");
const DOC = join(ROOT, "docs/architecture/runtime-parameters.md");
/** Messages in src/ that are deliberately not in runtime-parameters.md's ENG-485 list: they are not
 *  about stopping, interruption or cleanup. Keyed by file, with the message as the test reads it
 *  (holes shown as `<…>`). Widening this list is a visible change. */
const EXCEPTIONS: { file: string; message: string }[] = [
  { file: "src/config/discover.ts", message: "styre: malformed config at <…>: <…>" },
];
/** Where a placeholder stands in a normalized message. */
const HOLE = "\u0000";
const show = (m: string): string => m.replaceAll(HOLE, "<…>");

interface Msg {
  text: string; // with holes
  holes: Hole[];
  where: string;
}
/** What one hole stands for: a pid, and, for a choice between two literals (`k ? "a" : "b"`), the
 *  choice as the doc names it (`a or b`). */
interface Hole {
  pid: boolean;
  choices: string | null;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.[cm]?tsx?$/.test(p) && !p.endsWith(".d.ts") ? [p] : [];
  });
}

const isPidExpr = (e: ts.Expression): boolean =>
  (ts.isIdentifier(e) && e.text === "pid") ||
  (ts.isPropertyAccessExpression(e) && e.name.text === "pid");
/** `a or b` for a hole that picks between two string literals, else null. */
function choicesOf(e: ts.Expression): string | null {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (!ts.isConditionalExpression(x)) return null;
  const t = x.whenTrue;
  const f = x.whenFalse;
  return ts.isStringLiteralLike(t) && ts.isStringLiteralLike(f) ? `${t.text} or ${f.text}` : null;
}
const holeOf = (e: ts.Expression): Hole => ({ pid: isPidExpr(e), choices: choicesOf(e) });

/** A file's string constants, by name (any `const NAME = "…"` in it). */
function stringConstants(sf: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const collect = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isStringLiteralLike(n.initializer)
    )
      constants.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  return constants;
}
/** Looks up `name` in the module `spec`, imported by the file `from` (both as written). */
type Importer = (from: string, spec: string, name: string) => string | undefined;

/** The messages in one source file, and the ways it builds one from parts (offences). */
function readSource(
  text: string,
  rel = "x.ts",
  imported: Importer = () => undefined,
): { messages: Msg[]; offences: string[] } {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const messages: Msg[] = [];
  const offences: string[] = [];
  const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  // String constants of this file, and names it imports, to see through `${PREFIX} …`.
  const constants = stringConstants(sf);
  const named = new Map<string, { spec: string; name: string }>(); // local name -> import
  const namespaces = new Map<string, string>(); // `import * as ns` -> spec
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b))
      for (const el of b.elements)
        named.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
    else if (b && ts.isNamespaceImport(b)) namespaces.set(b.name.text, spec);
  }
  const constantIn = (e: ts.Expression): { name: string; value: string | undefined } | null => {
    if (ts.isIdentifier(e)) {
      const imp = named.get(e.text);
      return {
        name: e.text,
        value: constants.get(e.text) ?? (imp ? imported(rel, imp.spec, imp.name) : undefined),
      };
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const spec = namespaces.get(e.expression.text);
      if (spec) return { name: e.getText(sf), value: imported(rel, spec, e.name.text) };
    }
    return null;
  };
  const isPlusOperand = (n: ts.Node): boolean => {
    let p = n.parent;
    while (p && ts.isParenthesizedExpression(p)) p = p.parent;
    return (
      p !== undefined &&
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        p.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    );
  };
  const visit = (n: ts.Node): void => {
    let text: string | null = null;
    let holes: Hole[] = [];
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) {
      text = n.head.text + n.templateSpans.map((s) => HOLE + s.literal.text).join("");
      holes = n.templateSpans.map((s) => holeOf(s.expression));
      const first = n.templateSpans[0]?.expression;
      const v = n.head.text === "" && first ? constantIn(first) : null;
      if (v?.value?.startsWith("styre"))
        offences.push(`${at(n)}: a message built from the constant ${v.name}`);
    }
    if (text?.startsWith("styre:")) {
      if (isPlusOperand(n)) offences.push(`${at(n)}: a message built with +: ${show(text)}`);
      else if (!text.startsWith("styre: ") || !/[A-Za-z]/.test(text.slice(7).replaceAll(HOLE, "")))
        offences.push(`${at(n)}: a message prefix or helper, not a whole message: ${show(text)}`);
      else messages.push({ text: text.replace(/\n$/, ""), holes, where: at(n) });
    }
    // A template's own literals are pieces of the same message; look only inside its expressions.
    if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) visit(s.expression);
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return { messages, offences };
}

/** The documented lines between the markers. */
function readDoc(text: string): Msg[] {
  const begin = text.indexOf("<!-- messages:begin -->");
  const end = text.indexOf("<!-- messages:end -->");
  if (begin < 0 || end < begin) throw new Error("the messages markers are missing");
  const out: Msg[] = [];
  let inFence = false;
  for (const line of text.slice(begin, end).split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence || !line.startsWith("styre: ")) continue;
    const names = [...line.matchAll(/<([^<>]+)>/g)].map((m) => m[1]);
    out.push({
      text: line.replace(/<[^<>]+>/g, HOLE),
      holes: names.map((n) => ({ pid: n === "pid", choices: n.includes(" or ") ? n : null })),
      where: line,
    });
  }
  return out;
}

const same = (a: Msg, b: Msg): boolean =>
  a.text === b.text &&
  a.holes.length === b.holes.length &&
  a.holes.every((x, i) => x.pid === b.holes[i].pid && x.choices === b.holes[i].choices);

function scanSrc(): { messages: Msg[]; offences: string[] } {
  const messages: Msg[] = [];
  const offences: string[] = [];
  const all = files(join(ROOT, "src"));
  const texts = new Map(all.map((f) => [relative(ROOT, f), readFileSync(f, "utf8")]));
  const consts = new Map<string, Map<string, string>>();
  const imported: Importer = (from, spec, name) => {
    if (!spec.startsWith(".")) return undefined;
    const target = relative(ROOT, join(ROOT, dirname(from), spec));
    for (const t of [target, `${target}.ts`]) {
      const text = texts.get(t);
      if (text === undefined) continue;
      if (!consts.has(t))
        consts.set(t, stringConstants(ts.createSourceFile(t, text, ts.ScriptTarget.Latest, true)));
      return consts.get(t)?.get(name);
    }
    return undefined;
  };
  for (const [rel, text] of texts) {
    const r = readSource(text, rel, imported);
    messages.push(...r.messages);
    offences.push(...r.offences);
  }
  return { messages, offences };
}
const isException = (m: Msg): boolean =>
  EXCEPTIONS.some((e) => m.where.startsWith(`${e.file}:`) && show(m.text) === e.message);

test("every message documented in runtime-parameters.md is a message in src/", () => {
  const { messages } = scanSrc();
  const documented = readDoc(readFileSync(DOC, "utf8"));
  expect(documented.length).toBeGreaterThan(30);
  const missing = documented.filter((d) => !messages.some((m) => same(d, m))).map((d) => d.where);
  expect(missing).toEqual([]);
});

test("every message in src/ is documented, apart from the listed exceptions", () => {
  const { messages } = scanSrc();
  const documented = readDoc(readFileSync(DOC, "utf8"));
  expect(messages.length).toBeGreaterThan(30);
  const undocumented = messages
    .filter((m) => !isException(m) && !documented.some((d) => same(d, m)))
    .map((m) => `${m.where}: ${show(m.text)}`);
  expect(undocumented).toEqual([]);
});

test("each exception still exists in src/ and is not documented", () => {
  const { messages } = scanSrc();
  const docText = readFileSync(DOC, "utf8");
  for (const e of EXCEPTIONS) {
    const found = messages.filter(
      (m) => m.where.startsWith(`${e.file}:`) && show(m.text) === e.message,
    );
    expect({ exception: e, found: found.length }).toEqual({ exception: e, found: 1 });
    expect(readDoc(docText).some((d) => show(d.text) === e.message)).toBe(false);
  }
});

test("no message in src/ is built from parts the reader cannot see whole", () => {
  expect(scanSrc().offences).toEqual([]);
});

test("the readers see what they must, and refuse messages built from parts", () => {
  const src = [
    "const a = `styre: stopped the agent (pid ${pid}) and ${n} of its commands.\\n`;",
    'const b = x ? "styre: stopping — plain…\\n" : `styre: received (${sig}) — cleaning up…\\n`;',
    'const c = `styre: could not stop the orphaned ${k === "agent" ? "agent" : "command"} (pid ${r.pid})`;',
    'const d = "not a styre message";',
  ].join("\n");
  const r = readSource(src);
  expect(r.offences).toEqual([]);
  const h = (pid: boolean, choices: string | null = null): Hole => ({ pid, choices });
  expect(r.messages.map((m) => [show(m.text), m.holes])).toEqual([
    ["styre: stopped the agent (pid <…>) and <…> of its commands.", [h(true), h(false)]],
    ["styre: stopping — plain…", []],
    ["styre: received (<…>) — cleaning up…", [h(false)]],
    ["styre: could not stop the orphaned <…> (pid <…>)", [h(false, "agent or command"), h(true)]],
  ]);
  // A prefix constant imported from another file, by name or through a namespace.
  const imports: Importer = (_from, spec, name) =>
    spec === "./p.ts" && name === "P" ? "styre" : undefined;
  for (const bad of [
    'import { P } from "./p.ts"; const m = `${P}: stopped the agent`;',
    'import { P as Q } from "./p.ts"; const m = `${Q}: stopped the agent`;',
    'import * as ns from "./p.ts"; const m = `${ns.P}: stopped the agent`;',
  ]) {
    expect({ bad, offences: readSource(bad, "x.ts", imports).offences.length > 0 }).toEqual({
      bad,
      offences: true,
    });
  }
  // Built from parts: each is an offence, and none is read as a message.
  for (const bad of [
    'const PFX = "styre:"; const m = `${PFX} stopped the agent`;',
    'const PFX = "styre"; const m = `${PFX}: stopped the agent`;',
    'const m = `styre: could not stop ${x}` + "; try again later\\n";',
    'const m = "styre: " + why;',
    "const say = (m: string) => `styre: ${m}\\n`;",
    'let m = "x"; m += "styre: appended";',
  ]) {
    const got = readSource(bad);
    expect({ bad, offences: got.offences.length > 0 }).toEqual({ bad, offences: true });
  }
  const doc = [
    "styre: outside the markers",
    "<!-- messages:begin -->",
    "```",
    "styre: stopped the agent (pid <pid>) and <n> of its commands.",
    "```",
    "styre: prose, not in a fence",
    "<!-- messages:end -->",
  ].join("\n");
  const d = readDoc(doc);
  expect(d.map((m) => [show(m.text), m.holes])).toEqual([
    ["styre: stopped the agent (pid <…>) and <…> of its commands.", [h(true), h(false)]],
  ]);
  // A choice hole must be named with both literals, in order.
  const choice = readDoc(
    "<!-- messages:begin -->\n```\nstyre: could not stop the orphaned <agent or command> (pid <pid>)\n```\n<!-- messages:end -->",
  )[0];
  expect(same(choice, r.messages[3])).toBe(true);
  const reworded = readSource(
    'const c = `styre: could not stop the orphaned ${k === "agent" ? "agent" : "process"} (pid ${r.pid})`;',
  ).messages[0];
  expect(same(choice, reworded)).toBe(false);
  // Swapped placeholder names do not match the source.
  const swapped = readDoc(doc.replace("(pid <pid>) and <n>", "(pid <n>) and <pid>"))[0];
  expect(same(swapped, r.messages[0])).toBe(false);
  expect(same(d[0], r.messages[0])).toBe(true);
});
