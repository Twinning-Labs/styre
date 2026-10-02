// ENG-485 section 5.1. Only the door (src/util/process/door.ts) and the process table fallback
// (proc-table.ts) may start a process, and `launchDiagnostic` may be named only by the stop
// machinery. The check parses imports and calls with the TypeScript compiler API, so text inside a
// string (the generated script in src/testing/karma.ts) is not a false hit.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");
const SPAWN_ALLOWED = new Set(["src/util/process/door.ts", "src/util/process/proc-table.ts"]);
const DIAG_ALLOWED = new Set([
  "src/util/process/door.ts",
  "src/util/process/signals.ts",
  "src/util/process/sweep.ts",
  "src/util/process/leftovers.ts",
  "src/util/process/proc-table.ts",
]);
const CHILD = new Set(["child_process", "node:child_process"]);
/** Members of the `Bun` global (or named exports of the `bun` module) that start a process. */
const BUN_STARTERS = new Set(["spawn", "spawnSync", "$"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(p) && !p.endsWith(".d.ts") ? [p] : [];
  });
}

const isChild = (n: ts.Node | undefined): boolean =>
  n !== undefined && ts.isStringLiteralLike(n) && CHILD.has(n.text);

/** Every way a source file can start a process or name `launchDiagnostic` where it may not. */
function offences(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const spawnOk = SPAWN_ALLOWED.has(rel);
  const diagOk = DIAG_ALLOWED.has(rel);
  const at = (n: ts.Node): string =>
    `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const flag = (n: ts.Node, what: string): void => {
    out.push(`${at(n)}: ${what}`);
  };
  const visit = (n: ts.Node): void => {
    if (!spawnOk) {
      // import ... from "node:child_process" / export ... from / import x = require()
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && isChild(n.moduleSpecifier))
        flag(n, "imports child_process");
      if (ts.isExternalModuleReference(n) && isChild(n.expression))
        flag(n, "requires child_process");
      if (ts.isCallExpression(n) && isChild(n.arguments[0])) {
        const callee = n.expression;
        if (
          n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require") ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "require")
        )
          flag(n, "loads child_process");
      }
      // import { spawn, spawnSync, $ } from "bun"
      if (
        ts.isImportDeclaration(n) &&
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === "bun" &&
        n.importClause?.namedBindings &&
        ts.isNamedImports(n.importClause.namedBindings)
      )
        for (const el of n.importClause.namedBindings.elements)
          if (BUN_STARTERS.has((el.propertyName ?? el.name).text))
            flag(el, `imports ${(el.propertyName ?? el.name).text} from bun`);
      // Bun.spawn / Bun.spawnSync / Bun.$ as a call, an alias, or a callback; also globalThis.Bun.*
      if (ts.isPropertyAccessExpression(n) && BUN_STARTERS.has(n.name.text)) {
        const e = n.expression;
        if (
          (ts.isIdentifier(e) && e.text === "Bun") ||
          (ts.isPropertyAccessExpression(e) && e.name.text === "Bun")
        )
          flag(n, `uses Bun.${n.name.text}`);
      }
      if (
        ts.isElementAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "Bun" &&
        ts.isStringLiteralLike(n.argumentExpression) &&
        BUN_STARTERS.has(n.argumentExpression.text)
      )
        flag(n, `uses Bun[${JSON.stringify(n.argumentExpression.text)}]`);
      // const { spawnSync } = Bun
      if (
        ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        n.initializer &&
        ts.isIdentifier(n.initializer) &&
        n.initializer.text === "Bun" &&
        n.name.elements.some((el) => BUN_STARTERS.has((el.propertyName ?? el.name).getText(sf)))
      )
        flag(n, "destructures a process starter from Bun");
    }
    if (!diagOk) {
      if (ts.isIdentifier(n) && n.text === "launchDiagnostic") flag(n, "names launchDiagnostic");
      if (
        ts.isElementAccessExpression(n) &&
        ts.isStringLiteralLike(n.argumentExpression) &&
        n.argumentExpression.text === "launchDiagnostic"
      )
        flag(n, "names launchDiagnostic");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const scan = (): string[] =>
  files(join(ROOT, "src")).flatMap((p) => offences(relative(ROOT, p), readFileSync(p, "utf8")));

test("only the door and the process table start processes; only the stop machinery runs diagnostics", () => {
  expect(scan()).toEqual([]);
});

test("the door and the process table are the only files that start processes", () => {
  // Pin the allow list itself: widening it must be a visible change to this file.
  expect([...SPAWN_ALLOWED].sort()).toEqual([
    "src/util/process/door.ts",
    "src/util/process/proc-table.ts",
  ]);
  expect(offences("src/util/process/door.ts", "Bun.spawn(['x']); Bun.spawnSync(['x'])")).toEqual(
    [],
  );
});

test.each([
  ["Bun.spawnSync", "export const x = () => Bun.spawnSync(['true']);"],
  ["Bun.spawn", "export const x = () => Bun.spawn(['true']);"],
  ["Bun.$ shell", "export const x = () => Bun.$`true`;"],
  ["an alias of Bun.spawnSync", "const s = Bun.spawnSync; s(['true']);"],
  ["globalThis.Bun.spawn", "globalThis.Bun.spawn(['true']);"],
  ["Bun element access", "Bun['spawnSync'](['true']);"],
  ["destructuring from Bun", "const { spawnSync } = Bun; spawnSync(['true']);"],
  ["a named import from bun", "import { spawn } from 'bun'; spawn(['true']);"],
  ["a renamed import from bun", "import { $ as sh } from 'bun'; sh`true`;"],
  [
    "a child_process import",
    "import { execFileSync } from 'node:child_process'; execFileSync('true');",
  ],
  ["a bare child_process import", "import cp from 'child_process'; cp.spawn('true');"],
  ["a child_process namespace import", "import * as cp from 'node:child_process';"],
  ["a child_process re-export", "export { spawn } from 'node:child_process';"],
  ["a child_process require", "const cp = require('node:child_process');"],
  ["a child_process import require", "import cp = require('child_process');"],
  ["a dynamic child_process import", "const cp = await import('node:child_process');"],
])("the guard rejects %s", (_name, source) => {
  expect(offences("src/dispatch/anything.ts", source).length).toBeGreaterThanOrEqual(1);
});

test.each([
  [
    "a call",
    "import { launchDiagnostic } from './door.ts'; launchDiagnostic(['ps'], { timeoutMs: 1 });",
  ],
  [
    "a namespace member",
    "import * as d from './door.ts'; d.launchDiagnostic(['ps'], { timeoutMs: 1 });",
  ],
  [
    "a string element access",
    "import * as d from './door.ts'; d['launchDiagnostic'](['ps'], { timeoutMs: 1 });",
  ],
  [
    "an alias import",
    "import { launchDiagnostic as ld } from './door.ts'; ld(['ps'], { timeoutMs: 1 });",
  ],
  ["a re-export", "export { launchDiagnostic } from './door.ts';"],
])("the guard rejects launchDiagnostic named from run code: %s", (_name, source) => {
  expect(offences("src/dispatch/anything.ts", source).length).toBeGreaterThanOrEqual(1);
  // stop.ts and records.ts belong to the process folder but are not on the list.
  expect(offences("src/util/process/stop.ts", source).length).toBeGreaterThanOrEqual(1);
  expect(offences("src/util/process/signals.ts", source)).toEqual([]);
  expect(offences("src/util/process/sweep.ts", source)).toEqual([]);
  expect(offences("src/util/process/leftovers.ts", source)).toEqual([]);
});

test("text inside a string or a comment is not a hit (the generated script in src/testing/karma.ts)", () => {
  const karma = readFileSync(join(ROOT, "src/testing/karma.ts"), "utf8");
  expect(karma).toContain("require('child_process')"); // the fixture this test is about
  expect(offences("src/testing/karma.ts", karma)).toEqual([]);
  expect(
    offences(
      "src/x.ts",
      "// Bun.spawnSync is not called here\n/* launchDiagnostic */\nexport const s = \"Bun.spawn(['x']) launchDiagnostic child_process\";\nexport const t = `import cp from 'node:child_process'`;",
    ),
  ).toEqual([]);
});

test("a Bun-like member that is not a process starter is not a hit", () => {
  expect(
    offences("src/x.ts", "Bun.write('a', 'b'); Bun.file('a'); Bun.sleep(1); other.spawn(1);"),
  ).toEqual([]);
});

// --- every blocking call states its timeout (spec section 5.1: "a required timeout") ---------------

/** The longest bound any call site may use: network git and tree writing (Task 7). */
const MAX_TIMEOUT_MS = 120_000;

/** Problems with the `timeoutMs` of each `runBlocking(...)` call in `text`: absent, not a positive
 *  bounded number, or (when it names a constant of the same file) a constant that is not one. A
 *  parameter that a helper passes through is accepted: the helper's callers are checked by tsc. */
function timeoutProblems(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, number>();
  for (const st of sf.statements)
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && ts.isNumericLiteral(d.initializer))
          consts.set(d.name.text, Number(d.initializer.text.replaceAll("_", "")));
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "runBlocking"
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const opts = n.arguments[1];
      const prop =
        opts && ts.isObjectLiteralExpression(opts)
          ? opts.properties.find((p) => p.name !== undefined && p.name.getText(sf) === "timeoutMs")
          : undefined;
      if (!prop) out.push(`${rel}:${line}: runBlocking without an explicit timeoutMs`);
      else {
        const v = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
        const num =
          v && ts.isNumericLiteral(v)
            ? Number(v.text.replaceAll("_", ""))
            : v && ts.isIdentifier(v)
              ? consts.get(v.text)
              : undefined;
        if (num !== undefined && !(num > 0 && num <= MAX_TIMEOUT_MS))
          out.push(`${rel}:${line}: timeoutMs ${num} is outside (0, ${MAX_TIMEOUT_MS}]`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("every runBlocking call outside the door states a bounded timeout", () => {
  const problems = files(join(ROOT, "src")).flatMap((p) => {
    const rel = relative(ROOT, p);
    return rel === "src/util/process/door.ts" ? [] : timeoutProblems(rel, readFileSync(p, "utf8"));
  });
  expect(problems).toEqual([]);
});

test("the timeout check can fail: a missing, zero, or unbounded timeout is reported", () => {
  const t = (src: string) => timeoutProblems("src/x.ts", src);
  expect(t("runBlocking(['git'], { cwd });")).toHaveLength(1);
  expect(t("runBlocking(['git']);")).toHaveLength(1);
  expect(t("runBlocking(['git'], { timeoutMs: 0 });")).toHaveLength(1);
  expect(t("runBlocking(['git'], { timeoutMs: 3_600_000 });")).toHaveLength(1);
  expect(t("const SLOW = 999_999;\nrunBlocking(['git'], { timeoutMs: SLOW });")).toHaveLength(1);
  expect(t("runBlocking(['git'], { timeoutMs: 30_000 });")).toEqual([]);
  expect(t("const OK = 120_000;\nrunBlocking(['git'], { cwd, timeoutMs: OK });")).toEqual([]);
  expect(t("function f(timeoutMs: number) { runBlocking(['git'], { timeoutMs }); }")).toEqual([]);
});
