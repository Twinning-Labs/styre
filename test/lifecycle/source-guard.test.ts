// ENG-485 section 5.1. Only the door (src/util/process/door.ts) and the process table fallback
// (proc-table.ts) may start a process, and `launchDiagnostic` may be named only by the stop
// machinery. The check parses imports and calls with the TypeScript compiler API, so text inside a
// string (the generated script in src/testing/karma.ts) is not a false hit.
//
// SCOPE (controller ruling R17). This guard catches ACCIDENTAL direct process starts and unbounded
// blocking calls in our own, trusted source. It is not a sandbox against code written to evade it.
// It claims only the checks below, and the stated limits are real limits.
//
// What it checks outside the allowed files (an allow list, not a deny list of spellings):
//   - the identifier `Bun` may appear only as `Bun.<member>` for the members src uses today
//     (BUN_MEMBERS); a bare, aliased, passed, destructured or computed `Bun` is an offence, and so is
//     any `.Bun` member or `["Bun"]` access, and any use of `globalThis` other than `globalThis.prompt`;
//   - imports of "bun" are type only or named members from BUN_NAMED_IMPORTS; "bun:" modules other
//     than bun:sqlite and bun:test (bun:ffi) are refused;
//   - child_process, node:module (createRequire), the identifier `createRequire`, and
//     `getBuiltinModule` (any use except a call with a string literal naming a module that is not
//     child_process or module) are refused;
//   - `require` may only be called directly with one string literal, `import()` takes only a string
//     literal, and `import.meta.require` (property access spelling), a direct call of `eval`,
//     `Function(...)`, `new Function(...)` and `process.binding / dlopen / mainModule` (the literal
//     `process.<name>` spelling) are refused;
//   - `launchDiagnostic` may not appear anywhere (identifier or any string) outside its callers, and
//     the door module may not be imported as a namespace or default, or re-exported with `export *`,
//     or loaded dynamically, outside them;
//   - `runBlocking` may only be CALLED (directly, through `ns.runBlocking`, `ns["runBlocking"]`, or
//     the local name of `import { runBlocking as x }`) or named in an import: passing, aliasing,
//     `.call`, `.apply` and re-exporting it are refused. Every call has an options object literal,
//     without a spread, whose `timeoutMs` is a numeric literal, a top level `const` numeric literal
//     in the same file, or an exported numeric `const` of an allow listed module, in (0, 120 000],
//     alone or in the branches of a conditional. A constant whose name is declared more than once in
//     the file (shadowed by a parameter, a local, a destructured name) is not trusted. A call whose
//     options carry a `cleanup` key (any spelling of the key) runs while the door is closed, so it is
//     allowed only inside the functions CLEANUP_SITES lists (spec section 7.3 step 1);
//   - `deferCleanup`, `runDeferredCleanups` and `beginStopping` may be named (as an identifier or a
//     string) only at the sites HELD_SITES lists: the door may be closed only by the stop handler.
//
// STATED LIMITS. These forms are NOT refused, and nothing here claims they are:
//   - indirect eval: `const e = eval; e(...)`, `(0, eval)(...)`;
//   - the Function constructor reached through an instance: `(() => {}).constructor(...)`;
//   - `import.meta["require"]` (element access), and `process.binding` / `process.dlopen` /
//     `process.mainModule` reached through an alias or an element access (`const p = process; ...`,
//     `process["binding"]`);
//   - a runtime built name: `d["launch" + "Diagnostic"]` on a value that came through an indirection
//     the scan does not follow, or `Reflect.get(obj, name)` where `obj` is not `Bun` or the door;
//   - a native addon, or a worker that loads one;
//   - code outside src/ (tests, scripts) and code generated to disk and run later (the string in
//     src/testing/karma.ts is such a script and is reviewed by hand);
//   - a call to a function that wraps runBlocking in another module is checked in that module only.
// The runtime half of the guarantee is the door's own tests. The scan only closes the plain forms.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
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
/** Where code may name the door's held cleanup functions (M5), and the door's stop switch (A M2),
 *  outside the door itself: file, then the functions within it. `deferCleanup` holds code that the
 *  stop handler runs while the door is closed; `runDeferredCleanups` runs it; `beginStopping`
 *  closes the door. Widening this list is a visible change. */
const HELD_SITES: Record<string, Record<string, string[]>> = {
  deferCleanup: { "src/dispatch/baseline-rerun.ts": ["deferWorktreeRemoval"] },
  runDeferredCleanups: { "src/util/process/signals.ts": ["handleStopSignal"] },
  beginStopping: { "src/util/process/signals.ts": ["handleStopSignal"] },
};
/** The functions that may make a blocking call marked `cleanup` (spec section 7.3 step 1: "The
 *  source guard lists the permitted cleanup calls"; final review A M1): such a call runs while the
 *  door is closed. File, then the functions within it. Widening this list is a visible change. */
const CLEANUP_SITES: Record<string, string[]> = {
  "src/dispatch/baseline-rerun.ts": ["registered", "removeTempWorktree"],
};

/** The names of the functions that enclose `n`, innermost first. */
function enclosingFunctions(n: ts.Node): string[] {
  const names: string[] = [];
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name)
      names.push(p.name.getText());
    else if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name)
    )
      names.push(p.parent.name.text);
  }
  return names;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(p) && !p.endsWith(".d.ts") ? [p] : [];
  });
}

/** Members of the `Bun` global that src may use today. Widening this list is a visible change. */
const BUN_MEMBERS = new Set(["TOML", "YAML", "Glob", "which", "sleep", "file", "Subprocess"]);
/** Named imports from the "bun" module that do not start a process. */
const BUN_NAMED_IMPORTS = new Set(["TOML", "YAML", "Glob", "which", "sleep", "file"]);
/** "bun:" modules src may import; bun:ffi (a way to call into libc) is not one of them. */
const BUN_SCHEME_OK = new Set(["bun:sqlite", "bun:test"]);
/** Builtin modules that may never be loaded through process.getBuiltinModule. */
const BLOCKED_BUILTINS = new Set(["child_process", "node:child_process", "module", "node:module"]);
const GLOBALTHIS_MEMBERS = new Set(["prompt"]);
const isDoorSpec = (s: string): boolean => /(^|\/)door(\.[cm]?[jt]s)?$/.test(s);
const lit = (n: ts.Node | undefined): string | undefined =>
  n !== undefined && ts.isStringLiteralLike(n) ? n.text : undefined;

/** Every way a source file can start a process or name `launchDiagnostic` where it may not. */
function offences(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const spawnOk = SPAWN_ALLOWED.has(rel);
  const diagOk = DIAG_ALLOWED.has(rel);
  const flag = (n: ts.Node, what: string): void => {
    out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  };

  /** A module specifier reached by import, export from, import equals, import() or require(). */
  const checkSpecifier = (n: ts.Node, spec: string, how: "static" | "dynamic"): void => {
    if (!spawnOk) {
      if (CHILD.has(spec)) flag(n, "loads child_process");
      if (spec === "module" || spec === "node:module") flag(n, `loads ${spec} (createRequire)`);
      if (spec.startsWith("bun:") && !BUN_SCHEME_OK.has(spec)) flag(n, `loads ${spec}`);
      if (spec === "bun" && how === "dynamic") flag(n, 'loads "bun" dynamically');
    }
    if (!diagOk && how === "dynamic" && isDoorSpec(spec)) flag(n, "loads the door dynamically");
  };

  const visit = (n: ts.Node): void => {
    // ---- modules --------------------------------------------------------------------------------
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = lit(n.moduleSpecifier);
      if (spec !== undefined) {
        checkSpecifier(n, spec, "static");
        if (
          !spawnOk &&
          ts.isImportDeclaration(n) &&
          spec === "bun" &&
          !n.importClause?.isTypeOnly
        ) {
          const nb = n.importClause?.namedBindings;
          if (n.importClause?.name) flag(n, 'default import of "bun"');
          if (nb && ts.isNamespaceImport(nb)) flag(n, 'namespace import of "bun"');
          if (nb && ts.isNamedImports(nb))
            for (const el of nb.elements)
              if (!el.isTypeOnly && !BUN_NAMED_IMPORTS.has((el.propertyName ?? el.name).text))
                flag(el, `imports ${(el.propertyName ?? el.name).text} from bun`);
        }
        if (!spawnOk && ts.isExportDeclaration(n) && spec === "bun" && !n.isTypeOnly)
          flag(n, 'exports from "bun"');
        if (!diagOk && isDoorSpec(spec)) {
          if (
            ts.isImportDeclaration(n) &&
            (n.importClause?.name ||
              (n.importClause?.namedBindings &&
                ts.isNamespaceImport(n.importClause.namedBindings))) &&
            !n.importClause.isTypeOnly
          )
            flag(n, "imports the door as a namespace or default");
          if (ts.isExportDeclaration(n) && !n.exportClause) flag(n, "re-exports the whole door");
          if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamespaceExport(n.exportClause))
            flag(n, "re-exports the whole door");
        }
      }
    }
    if (ts.isExternalModuleReference(n)) {
      const spec = lit(n.expression);
      if (spec !== undefined) checkSpecifier(n, spec, "dynamic");
      else flag(n, "import equals with a computed module");
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = lit(n.arguments[0]);
        if (spec === undefined) {
          if (!spawnOk) flag(n, "import() with an argument that is not a string literal");
        } else checkSpecifier(n, spec, "dynamic");
      }
      if (ts.isIdentifier(callee) && callee.text === "require") {
        const spec = n.arguments.length === 1 ? lit(n.arguments[0]) : undefined;
        if (spec === undefined) {
          if (!spawnOk) flag(n, "require() without a single string literal");
        } else checkSpecifier(n, spec, "dynamic");
      }
      if (
        !spawnOk &&
        ts.isIdentifier(callee) &&
        (callee.text === "eval" || callee.text === "Function")
      )
        flag(n, `calls ${callee.text}`);
    }
    if (
      !spawnOk &&
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "Function"
    )
      flag(n, "constructs a Function");

    // ---- identifiers ----------------------------------------------------------------------------
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      if (!spawnOk) {
        if (n.text === "createRequire") flag(n, "names createRequire");
        if (n.text === "require") {
          const calledDirectly = ts.isCallExpression(parent) && parent.expression === n;
          const memberName = ts.isPropertyAccessExpression(parent) && parent.name === n;
          const keyName = ts.isPropertyAssignment(parent) && parent.name === n;
          if (!calledDirectly && !memberName && !keyName)
            flag(n, "uses require other than as a direct call");
        }
        if (n.text === "Bun") {
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === n
              ? parent.name.text
              : ts.isElementAccessExpression(parent) && parent.expression === n
                ? lit(parent.argumentExpression)
                : ts.isQualifiedName(parent) && parent.left === n
                  ? parent.right.text
                  : undefined;
          const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === n;
          if (isMemberName) flag(n, "reaches Bun through a member (.Bun)");
          else if (member === undefined || !BUN_MEMBERS.has(member))
            flag(
              n,
              member === undefined ? "uses Bun other than as Bun.<member>" : `uses Bun.${member}`,
            );
        }
        if (n.text === "globalThis") {
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === n
              ? parent.name.text
              : ts.isElementAccessExpression(parent) && parent.expression === n
                ? lit(parent.argumentExpression)
                : undefined;
          if (member === undefined || !GLOBALTHIS_MEMBERS.has(member))
            flag(n, `uses globalThis${member === undefined ? "" : `.${member}`}`);
        }
        if (
          (n.text === "global" || n.text === "self" || n.text === "window") &&
          ((ts.isPropertyAccessExpression(parent) &&
            parent.expression === n &&
            parent.name.text === "Bun") ||
            (ts.isElementAccessExpression(parent) &&
              parent.expression === n &&
              lit(parent.argumentExpression) !== "prompt"))
        )
          flag(n, `reaches Bun through ${n.text}`);
        if (n.text === "binding" || n.text === "dlopen" || n.text === "mainModule") {
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.name === n &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === "process"
          )
            flag(n, `uses process.${n.text}`);
        }
      }
      if (!diagOk && n.text === "launchDiagnostic") flag(n, "names launchDiagnostic");
    }
    // process.getBuiltinModule("node:child_process") is a require that needs no import. Only a call
    // `x.getBuiltinModule("<string literal>")` for a module that is not blocked is accepted.
    if (!spawnOk) {
      const isName =
        (ts.isIdentifier(n) && n.text === "getBuiltinModule") ||
        (ts.isStringLiteralLike(n) && n.text === "getBuiltinModule");
      if (isName) {
        const access = ts.isIdentifier(n) ? n.parent : undefined;
        const call =
          access && ts.isPropertyAccessExpression(access) && access.name === n
            ? access.parent
            : undefined;
        const arg =
          call && ts.isCallExpression(call) && call.expression === access
            ? lit(call.arguments[0])
            : undefined;
        if (arg === undefined || BLOCKED_BUILTINS.has(arg))
          flag(n, "uses getBuiltinModule beyond an allowed literal");
      }
    }
    if (!spawnOk && ts.isElementAccessExpression(n) && lit(n.argumentExpression) === "Bun")
      flag(n, 'reaches Bun through ["Bun"]');
    if (
      !spawnOk &&
      ts.isMetaProperty(n) &&
      ts.isPropertyAccessExpression(n.parent) &&
      n.parent.name.text === "require"
    )
      flag(n, "uses import.meta.require");
    if (
      !spawnOk &&
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "require" &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "module"
    )
      flag(n, "uses module.require");
    // The held cleanup functions: named only in the door, or at a listed site (an import there,
    // not renamed, or inside a listed function), as an identifier or as a string.
    if (
      rel !== "src/util/process/door.ts" &&
      (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) &&
      Object.hasOwn(HELD_SITES, n.text)
    ) {
      const sites = (HELD_SITES[n.text] as Record<string, string[]>)[rel] ?? [];
      const plainImport =
        ts.isImportSpecifier(n.parent) && n.parent.propertyName === undefined && sites.length > 0;
      const inSite = enclosingFunctions(n).some((f) => sites.includes(f));
      if (!plainImport && !inSite) flag(n, `names ${n.text} off its listed sites`);
    }
    // A string that is exactly the name, in any position: computed key, string keyed destructuring,
    // `export { x as "launchDiagnostic" }`, an import specifier written as a string.
    if (!diagOk && ts.isStringLiteralLike(n) && n.text === "launchDiagnostic")
      flag(n, "names launchDiagnostic as a string");
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

const NEG = "src/dispatch/anything.ts";

test.each([
  // direct forms
  ["Bun.spawnSync", "export const x = () => Bun.spawnSync(['true']);"],
  ["Bun.spawn", "export const x = () => Bun.spawn(['true']);"],
  ["Bun.$ shell", "export const x = () => Bun.$`true`;"],
  ["an alias of Bun.spawnSync", "const s = Bun.spawnSync; s(['true']);"],
  ["Bun element access", "Bun['spawnSync'](['true']);"],
  ["destructuring from Bun", "const { spawnSync } = Bun; spawnSync(['true']);"],
  // a bare Bun
  ["a bare alias of Bun", "const B = Bun; B.spawnSync(['true']);"],
  ["Bun passed as an argument", "run(Bun);"],
  ["Reflect.get on Bun", "Reflect.get(Bun, 'spawnSync')(['true']);"],
  ["Reflect.get on Bun with a built name", "Reflect.get(Bun, 'spawn' + 'Sync')(['true']);"],
  ["Bun in a computed element access", "Bun['spawn' + 'Sync'](['true']);"],
  ["typeof Bun", "type T = typeof Bun;"],
  // through the global object
  ["globalThis.Bun.spawn", "globalThis.Bun.spawn(['true']);"],
  [
    "a destructure from globalThis.Bun",
    "const { spawnSync } = globalThis.Bun; spawnSync(['true']);",
  ],
  ["a cast globalThis element access", "(globalThis as any)['Bun'].spawnSync(['true']);"],
  ["globalThis with a computed key", "(globalThis as any)['Bu' + 'n'].spawnSync(['true']);"],
  ["a bare globalThis", "const g = globalThis; g.Bun.spawnSync(['true']);"],
  ["a .Bun member of another object", "const g = other; g.Bun.spawnSync(['true']);"],
  ["global.Bun", "global.Bun.spawnSync(['true']);"],
  ["self.Bun", "self.Bun.spawnSync(['true']);"],
  ["an element access with 'Bun' on anything", "thing['Bun'].spawnSync(['true']);"],
  // the "bun" module
  ["a named import from bun", "import { spawn } from 'bun'; spawn(['true']);"],
  ["a renamed import from bun", "import { $ as sh } from 'bun'; sh`true`;"],
  ["a namespace import of bun", "import * as bun from 'bun'; bun.spawnSync(['true']);"],
  ["a default import of bun", "import b from 'bun'; b.spawnSync(['true']);"],
  ["a dynamic import of bun", "const b = await import('bun'); b.spawnSync(['true']);"],
  ["a re-export from bun", "export { spawnSync } from 'bun';"],
  ["bun:ffi", "import { dlopen } from 'bun:ffi';"],
  ["a bun:ffi require", "const f = require('bun:ffi');"],
  // child_process, however loaded
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
  ["a built dynamic import", "const cp = await import('node:' + 'child_process');"],
  ["a variable dynamic import", "const m = 'node:child_process'; await import(m);"],
  ["a template dynamic import", "await import(`node:${'child_process'}`);"],
  [
    "createRequire from node:module",
    "import { createRequire } from 'node:module'; createRequire(import.meta.url)('node:child_process');",
  ],
  ["createRequire from module", "import { createRequire } from 'module';"],
  [
    "a module namespace createRequire",
    "import * as m from 'node:module'; m.createRequire(import.meta.url);",
  ],
  [
    "createRequire with no import",
    "declare const createRequire: any; createRequire(import.meta.url)('child_process');",
  ],
  ["an aliased require", "const r = require; r('child_process');"],
  ["require with a built name", "require('child_' + 'process');"],
  ["require with a variable", "const n = 'child_process'; require(n);"],
  ["require.main", "require.main;"],
  ["module.require", "module.require('child_process');"],
  ["import.meta.require", "import.meta.require('child_process');"],
  ["eval", "eval('Bun.spawnSync(1)');"],
  ["the Function constructor", "new Function('return Bun')().spawnSync(['true']);"],
  ["Function called", "Function('return Bun')().spawnSync(['true']);"],
  ["process.binding", "process.binding('spawn_sync');"],
  [
    "process.getBuiltinModule child_process",
    "process.getBuiltinModule('node:child_process').spawnSync(['true']);",
  ],
  ["process.getBuiltinModule bare name", "process.getBuiltinModule('child_process');"],
  [
    "process.getBuiltinModule node:module",
    "process.getBuiltinModule('node:module').createRequire(import.meta.url);",
  ],
  ["process.getBuiltinModule built name", "process.getBuiltinModule('node:' + 'child_process');"],
  [
    "process.getBuiltinModule aliased",
    "const g = process.getBuiltinModule; g('node:child_process');",
  ],
  [
    "process.getBuiltinModule by element access",
    "process['getBuiltinModule']('node:child_process');",
  ],
])("the guard rejects %s", (_name, source) => {
  expect(offences(NEG, source).length).toBeGreaterThanOrEqual(1);
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
  [
    "a string keyed destructure",
    "import * as door from './door.ts'; const { 'launchDiagnostic': ld } = door;",
  ],
  ["a computed string key", "declare const door: any; const { ['launchDiagnostic']: ld } = door;"],
  ["a string import name", "import { 'launchDiagnostic' as ld } from './door.ts';"],
  ["a string export name", "const x = 1; export { x as 'launchDiagnostic' };"],
  ["a namespace import of the door", "import * as door from './door.ts'; export const f = door;"],
  ["a default style import of the door", "import door from './door.ts'; export const f = door;"],
  ["a whole door re-export", "export * from './door.ts';"],
  ["a namespace door re-export", "export * as door from './door.ts';"],
  [
    "a dynamic import of the door",
    "const d = await import('./door.ts'); d.runBlocking([], { timeoutMs: 1 });",
  ],
])(
  "the guard rejects launchDiagnostic or the whole door reached from run code: %s",
  (_name, source) => {
    expect(offences(NEG, source).length).toBeGreaterThanOrEqual(1);
    // stop.ts and records.ts belong to the process folder but are not on the list.
    expect(offences("src/util/process/stop.ts", source).length).toBeGreaterThanOrEqual(1);
  },
);

test.each([
  [
    "a call",
    "import { launchDiagnostic } from './door.ts'; launchDiagnostic(['ps'], { timeoutMs: 1 });",
  ],
  [
    "a namespace member",
    "import * as d from './door.ts'; d.launchDiagnostic(['ps'], { timeoutMs: 1 });",
  ],
  ["a string key", "import * as d from './door.ts'; const { 'launchDiagnostic': ld } = d;"],
])("the stop machinery may use launchDiagnostic: %s", (_name, source) => {
  for (const f of ["signals", "sweep", "leftovers"])
    expect(offences(`src/util/process/${f}.ts`, source)).toEqual([]);
});

test("what src is allowed to do is not a hit", () => {
  const fine = [
    "import type { Database } from 'bun:sqlite'; import { Database as D } from 'bun:sqlite';",
    "import type { Subprocess } from 'bun';",
    "import { type Subprocess, file } from 'bun'; file('a');",
    "const t = Bun.TOML.parse('a=1'); const y = Bun.YAML.parse('a: 1'); new Bun.Glob('*').match('a');",
    "Bun.which('git'); Bun.sleep(1); Bun.file('a'); Bun['file']('a');",
    "let p: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;",
    "const ok = globalThis.prompt('q'); globalThis['prompt']('q');",
    "const { runCommand } = await import('../util/run-command.ts'); type T = import('../x.ts').Y;",
    "const j = { require: 1 }; j.require; const e = j?.require?.['x'];",
    "import { runBlocking } from '../util/process/door.ts'; runBlocking(['git'], { timeoutMs: 1 });",
    "import { RunInterrupted, type BlockingResult } from '../util/process/door.ts';",
    "import * as fs from 'node:fs'; import { createHash } from 'node:crypto';",
    "const fs = process.getBuiltinModule('node:fs');",
    "import { runBlocking as rb } from '../util/process/door.ts'; rb(['git'], { timeoutMs: 30_000 });",
  ];
  for (const src of fine) expect(offences(NEG, src), src).toEqual([]);
});

test("text inside a string, a comment or a template is not a hit (the generated script in src/testing/karma.ts)", () => {
  const karma = readFileSync(join(ROOT, "src/testing/karma.ts"), "utf8");
  expect(karma).toContain("require('child_process')"); // the fixture this test is about
  expect(offences("src/testing/karma.ts", karma)).toEqual([]);
  expect(
    offences(
      "src/x.ts",
      "// Bun.spawnSync is not called here\n/** Bun launchDiagnostic createRequire */\nexport const s = \"Bun.spawn(['x']) launchDiagnostic child_process\";\nexport const t = `import cp from 'node:child_process'; const B = Bun`;",
    ),
  ).toEqual([]);
});

test("the allowed files may spawn and may name launchDiagnostic", () => {
  const src =
    "Bun.spawn(['x']); Bun.spawnSync(['x']); const B = Bun; require('node:child_process');";
  expect(offences("src/util/process/door.ts", src)).toEqual([]);
  expect(offences("src/util/process/proc-table.ts", src)).toEqual([]);
});

// --- held cleanups: only the door, the handler and the listed removal site (M5) ------------------
// `deferCleanup` holds code that runs inside the stop handler while the door is closed, and
// `runDeferredCleanups` runs it. Each may be named only at its listed sites.

test("the held cleanup sites are pinned", () => {
  expect(HELD_SITES).toEqual({
    deferCleanup: { "src/dispatch/baseline-rerun.ts": ["deferWorktreeRemoval"] },
    runDeferredCleanups: { "src/util/process/signals.ts": ["handleStopSignal"] },
    beginStopping: { "src/util/process/signals.ts": ["handleStopSignal"] },
  });
});

test.each([
  [
    "deferCleanup in another module",
    NEG,
    "import { deferCleanup } from '../util/process/door.ts'; deferCleanup({ run() {}, manual: '' });",
  ],
  [
    "deferCleanup in the replay harness",
    "src/dispatch/replay-harness.ts",
    "import { deferCleanup } from '../util/process/door.ts'; export function r() { deferCleanup({ run() {}, manual: '' }); }",
  ],
  [
    "deferCleanup in the listed file, outside the listed function",
    "src/dispatch/baseline-rerun.ts",
    "import { deferCleanup } from '../util/process/door.ts'; export function runAtBaseline() { deferCleanup({ run() {}, manual: '' }); }",
  ],
  [
    "deferCleanup at the top level of the listed file",
    "src/dispatch/baseline-rerun.ts",
    "import { deferCleanup } from '../util/process/door.ts'; deferCleanup({ run() {}, manual: '' });",
  ],
  [
    "an aliased import of deferCleanup",
    NEG,
    "import { deferCleanup as d } from '../util/process/door.ts'; d({ run() {}, manual: '' });",
  ],
  [
    "runDeferredCleanups in run code",
    NEG,
    "import { runDeferredCleanups } from '../util/process/door.ts'; runDeferredCleanups(() => 1);",
  ],
  [
    "runDeferredCleanups in the removal site",
    "src/dispatch/baseline-rerun.ts",
    "import { runDeferredCleanups } from '../util/process/door.ts'; export function deferWorktreeRemoval() { runDeferredCleanups(() => 1); }",
  ],
  [
    "runDeferredCleanups in signals.ts outside the handler",
    "src/util/process/signals.ts",
    "import { runDeferredCleanups } from './door.ts'; export function other() { runDeferredCleanups(() => 1); }",
  ],
  ["a string key", NEG, "declare const d: any; d['runDeferredCleanups'](() => 1);"],
])("the guard rejects a held cleanup named off its listed sites: %s", (_name, file, source) => {
  expect(
    offences(file, source).some((o) => /names (deferCleanup|runDeferredCleanups)/.test(o)),
  ).toBe(true);
});

test("the listed held cleanup sites are not hits", () => {
  expect(
    offences(
      "src/dispatch/baseline-rerun.ts",
      "import { deferCleanup, runBlocking } from '../util/process/door.ts';\nexport function deferWorktreeRemoval(r: string, w: string) { return deferCleanup({ run() {}, manual: w }); }",
    ),
  ).toEqual([]);
  expect(
    offences(
      "src/util/process/signals.ts",
      "import { runDeferredCleanups } from './door.ts';\nexport async function handleStopSignal() { for (const w of runDeferredCleanups(() => 1)) void w; }",
    ),
  ).toEqual([]);
  expect(
    offences(
      "src/util/process/door.ts",
      "export function deferCleanup() {} export function runDeferredCleanups() {} deferCleanup(); runDeferredCleanups();",
    ),
  ).toEqual([]);
});

// --- every blocking call states its timeout (spec section 5.1: "a required timeout") ---------------

/** The longest bound any call site may use: network git and tree writing (Task 7). */
const MAX_TIMEOUT_MS = 120_000;
/** Modules whose exported numeric constants may be imported as a timeout. */
const TIMEOUT_MODULES = new Set(["src/util/process/door.ts"]);

const numberOf = (e: ts.Expression): number | undefined =>
  ts.isNumericLiteral(e) ? Number(e.text.replaceAll("_", "")) : undefined;

/** Top level `const NAME = <number literal>` of a source file; `exported` limits it to exports. */
function topLevelConsts(sf: ts.SourceFile, exported: boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const isExport = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (exported && !isExport) continue;
    if (!(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of st.declarationList.declarations) {
      const v = d.initializer && numberOf(d.initializer);
      if (ts.isIdentifier(d.name) && v !== undefined) out.set(d.name.text, v);
    }
  }
  return out;
}

/** Problems with the `timeoutMs` of each `runBlocking(...)` call in `text`, however it is reached
 *  (`runBlocking(`, `ns.runBlocking(`, `ns["runBlocking"](`). A timeout is accepted only as a numeric
 *  literal, a same file top level `const` numeric literal, or an exported numeric constant imported
 *  from TIMEOUT_MODULES, in (0, MAX_TIMEOUT_MS], alone or in the branches of a conditional. Anything
 *  else, including arithmetic, a parameter or a spread, is a problem. */
function timeoutProblems(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const known = new Map(topLevelConsts(sf, false));
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = posix.normalize(posix.join(posix.dirname(rel), st.moduleSpecifier.text));
    const nb = st.importClause?.namedBindings;
    if (!TIMEOUT_MODULES.has(target) || !nb || !ts.isNamedImports(nb)) continue;
    const exported = topLevelConsts(
      ts.createSourceFile(
        target,
        readFileSync(join(ROOT, target), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      ),
      true,
    );
    for (const el of nb.elements) {
      const v = exported.get((el.propertyName ?? el.name).text);
      if (v !== undefined) known.set(el.name.text, v);
    }
  }
  // How many times each name is declared anywhere in the file (variables, parameters, destructured
  // names, functions, classes, imports, catch variables). A constant is trusted only when its name
  // has exactly one declaration, so no inner scope can shadow it with a different value.
  const declared = new Map<string, number>();
  const declare = (name: ts.BindingName | ts.Identifier | undefined): void => {
    if (!name) return;
    if (ts.isIdentifier(name)) declared.set(name.text, (declared.get(name.text) ?? 0) + 1);
    else for (const el of name.elements) if (ts.isBindingElement(el)) declare(el.name);
  };
  // Local names that stand for runBlocking: `runBlocking` itself and any `import { runBlocking as x }`.
  const rbNames = new Set(["runBlocking"]);
  const scan = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) declare(n.name);
    else if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) declare(n.name);
    else if (ts.isImportSpecifier(n) || ts.isNamespaceImport(n)) declare(n.name);
    else if (ts.isImportClause(n)) declare(n.name);
    else if (ts.isCatchClause(n) && n.variableDeclaration) declare(n.variableDeclaration.name);
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === "runBlocking")
      rbNames.add(n.name.text);
    ts.forEachChild(n, scan);
  };
  scan(sf);
  for (const name of [...known.keys()]) if ((declared.get(name) ?? 0) !== 1) known.delete(name);
  const values = (e: ts.Expression): number[] | undefined => {
    if (ts.isParenthesizedExpression(e)) return values(e.expression);
    const n = numberOf(e);
    if (n !== undefined) return [n];
    if (ts.isIdentifier(e)) return known.has(e.text) ? [known.get(e.text) as number] : undefined;
    if (ts.isConditionalExpression(e)) {
      const a = values(e.whenTrue);
      const b = values(e.whenFalse);
      return a && b ? [...a, ...b] : undefined;
    }
    return undefined;
  };
  const isRunBlocking = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && rbNames.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "runBlocking") ||
    (ts.isElementAccessExpression(callee) && lit(callee.argumentExpression) === "runBlocking");
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && isRunBlocking(n.expression)) {
      const at = `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
      const opts = n.arguments[1];
      if (!opts || !ts.isObjectLiteralExpression(opts)) {
        out.push(`${at}: runBlocking without an options object literal`);
      } else {
        if (opts.properties.some((p) => ts.isSpreadAssignment(p)))
          out.push(`${at}: runBlocking options with a spread`);
        // A call marked `cleanup` runs while the door is closed: only at the listed sites.
        const keyOf = (p: ts.ObjectLiteralElementLike): string | undefined => {
          const k = p.name;
          if (k === undefined) return undefined;
          if (ts.isIdentifier(k) || ts.isStringLiteralLike(k)) return k.text;
          if (ts.isComputedPropertyName(k)) return lit(k.expression);
          return undefined;
        };
        if (opts.properties.some((p) => keyOf(p) === "cleanup")) {
          const sites = CLEANUP_SITES[rel] ?? [];
          if (!enclosingFunctions(n).some((f) => sites.includes(f)))
            out.push(`${at}: runBlocking marked cleanup off its listed sites`);
        }
        const prop = opts.properties.find(
          (p) => p.name !== undefined && p.name.getText(sf) === "timeoutMs",
        );
        const expr = !prop
          ? undefined
          : ts.isPropertyAssignment(prop)
            ? prop.initializer
            : ts.isShorthandPropertyAssignment(prop)
              ? prop.name
              : undefined;
        const vs = expr && values(expr);
        if (!expr) out.push(`${at}: runBlocking without an explicit timeoutMs`);
        else if (!vs)
          out.push(`${at}: timeoutMs is not a literal or a known constant: ${expr.getText(sf)}`);
        else if (vs.some((v) => !(v > 0 && v <= MAX_TIMEOUT_MS)))
          out.push(`${at}: timeoutMs ${vs.join(" or ")} is outside (0, ${MAX_TIMEOUT_MS}]`);
      }
    }
    // runBlocking may only be CALLED here (or named in an import). Passing it, aliasing it, `.call`,
    // `.apply`, or re-exporting it would put a call beyond this check.
    const mentions =
      (ts.isIdentifier(n) && rbNames.has(n.text)) ||
      (ts.isStringLiteralLike(n) &&
        ts.isElementAccessExpression(n.parent) &&
        n.text === "runBlocking");
    if (mentions) {
      const ref =
        ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
          ? n.parent
          : ts.isStringLiteralLike(n) && ts.isElementAccessExpression(n.parent)
            ? n.parent
            : n;
      const called = ts.isCallExpression(ref.parent) && ref.parent.expression === ref;
      const imported = ts.isImportSpecifier(ref.parent);
      if (!called && !imported)
        out.push(
          `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: runBlocking is not called directly`,
        );
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

test.each([
  ["no options", "runBlocking(['git']);"],
  ["no timeout", "runBlocking(['git'], { cwd });"],
  ["a zero timeout", "runBlocking(['git'], { timeoutMs: 0 });"],
  ["an unbounded literal", "runBlocking(['git'], { timeoutMs: 3_600_000 });"],
  ["arithmetic", "runBlocking(['git'], { timeoutMs: 60 * 60_000 });"],
  ["arithmetic on a constant", "const A = 1000; runBlocking(['git'], { timeoutMs: A * 60 });"],
  [
    "an unbounded same file constant",
    "const SLOW = 999_999;\nrunBlocking(['git'], { timeoutMs: SLOW });",
  ],
  ["a parameter", "function f(timeoutMs: number) { runBlocking(['git'], { timeoutMs }); }"],
  [
    "a property of an argument",
    "function f(o: any) { runBlocking(['git'], { timeoutMs: o.ms }); }",
  ],
  [
    "a defaulted expression",
    "function f(o: any) { runBlocking(['git'], { timeoutMs: o.ms ?? 30_000 }); }",
  ],
  ["a let variable", "let t = 1000; runBlocking(['git'], { timeoutMs: t });"],
  [
    "a conditional with a bad branch",
    "const A = 5; runBlocking(['git'], { timeoutMs: c ? A : x });",
  ],
  ["a spread of options", "runBlocking(['git'], { timeoutMs: 1000, ...more });"],
  ["an options variable", "const o = { timeoutMs: 1000 }; runBlocking(['git'], o);"],
  [
    "a namespace call",
    "import * as door from '../util/process/door.ts'; door.runBlocking(['git'], { cwd });",
  ],
  ["a namespace call with arithmetic", "door.runBlocking(['git'], { timeoutMs: 60 * 60_000 });"],
  ["an element access call", "door['runBlocking'](['git'], { cwd });"],
  [
    "an aliased import with arithmetic",
    "import { runBlocking as rb } from '../util/process/door.ts'; rb(['git'], { timeoutMs: 60 * 60_000 });",
  ],
  [
    "an aliased import without a timeout",
    "import { runBlocking as rb } from '../util/process/door.ts'; rb(['git'], { cwd });",
  ],
  [
    "an aliased import via a parameter",
    "import { runBlocking as rb } from '../util/process/door.ts'; function f(t: number) { rb(['git'], { timeoutMs: t }); }",
  ],
  [
    "a variable alias of runBlocking",
    "const r = runBlocking; r(['git'], { timeoutMs: 60 * 60_000 });",
  ],
  ["a variable alias of a namespace member", "const r = door.runBlocking; r(['git']);"],
  ["runBlocking.call", "runBlocking.call(null, ['git'], { timeoutMs: 60 * 60_000 });"],
  ["runBlocking.apply", "runBlocking.apply(null, [['git'], { timeoutMs: 60 * 60_000 }]);"],
  ["runBlocking passed as an argument", "run(runBlocking);"],
  [
    "an aliased runBlocking passed as an argument",
    "import { runBlocking as rb } from '../util/process/door.ts'; run(rb);",
  ],
  ["a re-export of runBlocking", "export { runBlocking } from '../util/process/door.ts';"],
  [
    "a renamed re-export of runBlocking",
    "import { runBlocking } from '../util/process/door.ts'; export { runBlocking as rb };",
  ],
  [
    "a shadowing local constant",
    "const T = 1000;\nfunction f() { const T = 99_999_999; runBlocking(['git'], { timeoutMs: T }); }",
  ],
  [
    "a shadowing parameter",
    "const T = 1000;\nfunction f(T: number) { runBlocking(['git'], { timeoutMs: T }); }",
  ],
  [
    "a shadowing destructured name",
    "const T = 1000;\nfunction f(o: any) { const { T } = o; runBlocking(['git'], { timeoutMs: T }); }",
  ],
  [
    "a shorthand shadowed by a parameter",
    "const timeoutMs = 1000;\nfunction f(timeoutMs: number) { runBlocking(['git'], { timeoutMs }); }",
  ],
  [
    "an imported constant from a module not on the list",
    "import { MS } from './consts.ts'; runBlocking(['git'], { timeoutMs: MS });",
  ],
  [
    "an imported name that door does not export",
    "import { NOPE } from '../util/process/door.ts'; runBlocking(['git'], { timeoutMs: NOPE });",
  ],
])("the timeout check rejects %s", (_name, source) => {
  expect(timeoutProblems("src/dispatch/x.ts", source).length).toBeGreaterThanOrEqual(1);
});

test.each([
  ["a literal", "runBlocking(['git'], { timeoutMs: 30_000 });"],
  ["the largest bound", "runBlocking(['git'], { timeoutMs: 120_000 });"],
  ["a same file constant", "const OK = 120_000;\nrunBlocking(['git'], { cwd, timeoutMs: OK });"],
  [
    "a shorthand of a same file constant",
    "const timeoutMs = 5_000;\nrunBlocking(['git'], { timeoutMs });",
  ],
  [
    "a conditional between bounded constants",
    "const A = 30_000; const B = 120_000;\nrunBlocking(['git'], { timeoutMs: c ? A : B });",
  ],
  [
    "an aliased import with a literal",
    "import { runBlocking as rb } from '../util/process/door.ts'; rb(['git'], { timeoutMs: 5_000 });",
  ],
  [
    "a constant used where nothing shadows it",
    "const T = 1000;\nfunction f() { const U = 5; runBlocking(['git'], { timeoutMs: T }); }",
  ],
  ["a namespace call with a literal", "door.runBlocking(['git'], { timeoutMs: 5_000 });"],
  [
    "an imported constant from an allowed module",
    "import { GRACE_MS } from '../util/process/door.ts'; runBlocking(['git'], { timeoutMs: GRACE_MS });",
  ],
])("the timeout check accepts %s", (_name, source) => {
  expect(timeoutProblems("src/dispatch/x.ts", source)).toEqual([]);
});

// --- blocking calls marked `cleanup` run while the door is closed (spec section 7.3 step 1) ------
// "The source guard lists the permitted cleanup calls" (final review A M1). A call marked cleanup
// runs during a stop, so a stray one (a `git reset` marked that way) could move HEAD mid stop.

test("the permitted cleanup calls are pinned", () => {
  expect(CLEANUP_SITES).toEqual({
    "src/dispatch/baseline-rerun.ts": ["registered", "removeTempWorktree"],
  });
});

test("the cleanup calls in src are all at their listed sites", () => {
  const problems = files(join(ROOT, "src")).flatMap((p) => {
    const rel = relative(ROOT, p);
    return rel === "src/util/process/door.ts"
      ? []
      : timeoutProblems(rel, readFileSync(p, "utf8")).filter((x) => x.includes("cleanup"));
  });
  expect(problems).toEqual([]);
});

test.each([
  ["in another module", NEG, "runBlocking(['true'], { timeoutMs: 1, cleanup: true });"],
  [
    "in the listed file, outside the listed functions",
    "src/dispatch/baseline-rerun.ts",
    "export function runAtBaseline() { runBlocking(['git', 'reset'], { timeoutMs: 1, cleanup: true }); }",
  ],
  [
    "at the top level of the listed file",
    "src/dispatch/baseline-rerun.ts",
    "runBlocking(['git'], { timeoutMs: 1, cleanup: true });",
  ],
  ["as a string key", NEG, "runBlocking(['true'], { timeoutMs: 1, 'cleanup': true });"],
  ["as a computed key", NEG, "runBlocking(['true'], { timeoutMs: 1, ['cleanup']: true });"],
  [
    "as a shorthand",
    NEG,
    "const cleanup = true; runBlocking(['true'], { timeoutMs: 1, cleanup });",
  ],
  [
    "through an aliased import",
    NEG,
    "import { runBlocking as rb } from '../util/process/door.ts'; rb(['true'], { timeoutMs: 1, cleanup: true });",
  ],
])("the guard rejects a blocking call marked cleanup %s", (_name, file, source) => {
  expect(
    timeoutProblems(file, source).some((p) => /marked cleanup off its listed sites/.test(p)),
  ).toBe(true);
});

test("a cleanup call at a listed site is not a hit", () => {
  expect(
    timeoutProblems(
      "src/dispatch/baseline-rerun.ts",
      "function removeTempWorktree(r: string, wt: string) { runBlocking(['git', 'worktree', 'remove', wt], { cwd: r, timeoutMs: 120_000, cleanup: true }); }\nfunction registered(r: string) { runBlocking(['git', 'worktree', 'list'], { cwd: r, timeoutMs: 30_000, cleanup: true }); }",
    ),
  ).toEqual([]);
});

// --- beginStopping closes the door: only the stop handler may call it (final review A M2) --------

test("beginStopping is pinned to the stop handler", () => {
  expect(HELD_SITES.beginStopping).toEqual({ "src/util/process/signals.ts": ["handleStopSignal"] });
});

test.each([
  ["in run code", NEG, "import { beginStopping } from '../util/process/door.ts'; beginStopping();"],
  [
    "in signals.ts outside the handler",
    "src/util/process/signals.ts",
    "import { beginStopping } from './door.ts'; export function other() { beginStopping(); }",
  ],
  [
    "through a namespace",
    NEG,
    "import * as door from '../util/process/door.ts'; door.beginStopping();",
  ],
  ["as a string key", NEG, "declare const d: any; d['beginStopping']();"],
  [
    "through an aliased import",
    NEG,
    "import { beginStopping as b } from '../util/process/door.ts'; b();",
  ],
])("the guard rejects beginStopping %s", (_name, file, source) => {
  expect(offences(file, source).some((o) => /names beginStopping/.test(o))).toBe(true);
});

test("the stop handler's own beginStopping is not a hit", () => {
  expect(
    offences(
      "src/util/process/signals.ts",
      "import { beginStopping } from './door.ts';\nexport async function handleStopSignal() { beginStopping(); }",
    ),
  ).toEqual([]);
});

// --- no API that runs the event loop from inside a callback (operator decision 2026-10-09) -------
// Bun's exit watch on macOS is a one-shot kqueue NOTE_EXIT. When a callback runs the event loop
// again synchronously, the inner tick overwrites the batch of ready events and the outer loop never
// delivers the rest: a child's exit is then lost for good, `proc.exited` never resolves, and a
// finished agent dispatch or a passing verify command is reported as a timeout after its full
// bound (oven-sh/bun#33261, still open; exited-delay-investigation.md in the ENG-485 SDD folder).
// src/ has no such call today. This rule keeps it that way, in every src file, the door and the
// process table included: the known loop-running callers from #33261's audit are refused. ENG-489
// tracks the runtime fallback (a bounded probe of the launch when `exited` stays pending).
//
// Refused: anything from "bun:test" (the `.resolves`/`.rejects` matchers, async `toThrow`, async
// `expect.extend`), and the `.resolves`/`.rejects` member names themselves; `Bun.jest` (another
// way to reach `expect`); `HTMLRewriter` (`transform` with async handlers); `Bun.build` (plugin
// `setup()`), `Bun.plugin` and `Bun.serve` (bake plugins); `Bun.Transpiler` (`transformSync` with
// async macros); an import marked `type: "macro"`; and IPC: an `ipc` or `serialization` option (the
// advanced serialization decoder), `process.send`, `process.channel`, and `process.on("message")`.
// A namespace or default import of "bun", or an import of those names from it, is refused too, since
// it reaches the same members.
//
// STATED LIMITS: the same as the rules above (an alias reached through an indirection the scan does
// not follow, a built name, a dependency's own code). A dependency that runs the loop is not seen.
const LOOP_BUN_MEMBERS = new Set(["build", "plugin", "serve", "Transpiler", "jest"]);

/** Every use of a known event loop runner in `text` (all src files: no file is exempt). */
function loopOffences(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const flag = (n: ts.Node, what: string): void => {
    out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  };
  const spec = (n: ts.Node, s: string): void => {
    if (s === "bun:test") flag(n, "loads bun:test (its async matchers run the event loop)");
  };
  /** The member name of `Bun.<x>` or `Bun["x"]` when `n` is that access's `Bun`. */
  const memberOf = (n: ts.Node): string | undefined => {
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === n) return p.name.text;
    if (ts.isElementAccessExpression(p) && p.expression === n) return lit(p.argumentExpression);
    return undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const s = lit(n.moduleSpecifier);
      if (s !== undefined) spec(n, s);
      if (ts.isImportDeclaration(n) && s === "bun" && !n.importClause?.isTypeOnly) {
        const nb = n.importClause?.namedBindings;
        if (n.importClause?.name) flag(n, 'default import of "bun" (reaches Bun.build and others)');
        if (nb && ts.isNamespaceImport(nb))
          flag(n, 'namespace import of "bun" (reaches Bun.build and others)');
        if (nb && ts.isNamedImports(nb))
          for (const el of nb.elements)
            if (!el.isTypeOnly && LOOP_BUN_MEMBERS.has((el.propertyName ?? el.name).text))
              flag(el, `imports ${(el.propertyName ?? el.name).text} from bun`);
      }
      const attrs = ts.isImportDeclaration(n) ? n.attributes : undefined;
      for (const a of attrs?.elements ?? [])
        if (a.name.text === "type" && lit(a.value) === "macro") flag(n, "imports a macro");
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isLoader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      const s = isLoader ? lit(n.arguments[0]) : undefined;
      if (s !== undefined) spec(n, s);
      // process.on("message") / process.once("message"): the IPC channel.
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "process" &&
        ["on", "once", "addListener", "prependListener"].includes(callee.name.text) &&
        lit(n.arguments[0]) === "message"
      )
        flag(n, `listens for process ${callee.name.text}("message") (IPC)`);
    }
    if (ts.isIdentifier(n)) {
      if (n.text === "HTMLRewriter") flag(n, "uses HTMLRewriter");
      if (n.text === "Bun") {
        const m = memberOf(n);
        if (m !== undefined && LOOP_BUN_MEMBERS.has(m)) flag(n, `uses Bun.${m}`);
      }
      if (
        (n.text === "resolves" || n.text === "rejects") &&
        ts.isPropertyAccessExpression(n.parent) &&
        n.parent.name === n
      )
        flag(n, `uses the .${n.text} matcher`);
      if (
        (n.text === "send" || n.text === "channel") &&
        ts.isPropertyAccessExpression(n.parent) &&
        n.parent.name === n &&
        ts.isIdentifier(n.parent.expression) &&
        n.parent.expression.text === "process"
      )
        flag(n, `uses process.${n.text} (IPC)`);
    }
    if (
      ts.isElementAccessExpression(n) &&
      ["resolves", "rejects"].includes(lit(n.argumentExpression) ?? "")
    )
      flag(n, `uses the .${lit(n.argumentExpression)} matcher`);
    // An `ipc` or `serialization` key in any object literal: a spawn option that opens IPC.
    if (
      (ts.isPropertyAssignment(n) ||
        ts.isShorthandPropertyAssignment(n) ||
        ts.isMethodDeclaration(n)) &&
      ts.isObjectLiteralExpression(n.parent)
    ) {
      const k = n.name;
      const key =
        ts.isIdentifier(k) || ts.isStringLiteralLike(k)
          ? k.text
          : ts.isComputedPropertyName(k)
            ? lit(k.expression)
            : undefined;
      if (key === "ipc" || key === "serialization") flag(n, `passes an ${key} option (IPC)`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("no src file uses an API that runs the event loop from a callback (oven-sh/bun#33261, ENG-489)", () => {
  const problems = files(join(ROOT, "src")).flatMap((p) =>
    loopOffences(relative(ROOT, p), readFileSync(p, "utf8")),
  );
  expect(problems).toEqual([]);
});

test.each([
  ["bun:test imported", "import { expect } from 'bun:test';"],
  ["bun:test imported for types and values", "import { expect, type Mock } from 'bun:test';"],
  ["bun:test required", "const { expect } = require('bun:test');"],
  ["bun:test loaded dynamically", "const t = await import('bun:test');"],
  ["a .resolves matcher", "declare const expect: any; await expect(p).resolves.toBe(1);"],
  ["a .rejects matcher", "declare const expect: any; await expect(p).rejects.toThrow();"],
  ["a .resolves element access", "declare const e: any; e['resolves'];"],
  ["Bun.jest", "const { expect } = Bun.jest(import.meta.path);"],
  ["HTMLRewriter", "new HTMLRewriter().on('a', { async element() {} }).transform(r);"],
  ["globalThis.HTMLRewriter", "new globalThis.HTMLRewriter();"],
  ["Bun.build", "await Bun.build({ entrypoints: ['a.ts'], plugins: [] });"],
  ["Bun.build by element access", "await Bun['build']({ entrypoints: ['a.ts'] });"],
  ["Bun.plugin", "Bun.plugin({ name: 'x', setup() {} });"],
  ["Bun.serve", "Bun.serve({ fetch() { return new Response(''); } });"],
  ["Bun.Transpiler", "new Bun.Transpiler({ loader: 'ts' }).transformSync('a');"],
  ["a named import of build from bun", "import { build } from 'bun';"],
  ["a named import of Transpiler from bun", "import { Transpiler as T } from 'bun';"],
  ["a namespace import of bun", "import * as bun from 'bun';"],
  ["a default import of bun", "import bun from 'bun';"],
  ["a macro import", "import { m } from './m.ts' with { type: 'macro' };"],
  ["a macro import with a string key", "import { m } from './m.ts' with { 'type': 'macro' };"],
  ["an ipc option", "spawn(['x'], { ipc(message) {} });"],
  ["an ipc shorthand", "const ipc = () => {}; spawn(['x'], { ipc });"],
  ["a serialization option", "spawn(['x'], { serialization: 'advanced' });"],
  ["process.send", "process.send?.({ a: 1 });"],
  ["process.channel", "process.channel?.ref();"],
  ["process.on('message')", "process.on('message', () => {});"],
  ["process.once('message')", "process.once('message', () => {});"],
])("the event loop guard rejects %s", (_name, source) => {
  // Every src file is held to it, the door and the process table included.
  for (const rel of [NEG, "src/util/process/door.ts", "src/util/process/proc-table.ts"])
    expect(loopOffences(rel, source).length).toBeGreaterThanOrEqual(1);
});

test("what src does today is not an event loop hit", () => {
  const fine = [
    "import type { Subprocess } from 'bun';",
    "import { file, type Subprocess } from 'bun'; file('a');",
    "Bun.spawn(['x'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }); Bun.spawnSync(['x']);",
    "Bun.sleep(1); Bun.which('git'); new Bun.Glob('*'); Bun.TOML.parse('');",
    "process.on('SIGINT', () => {}); process.once('exit', () => {}); process.exitCode = 1;",
    "const p = new Promise((resolve, reject) => resolve(1)); p.then(() => 1, () => 2);",
    "import { m } from './m.ts' with { type: 'json' };",
    "const o = { build: 1, serve: 2 }; o.build; o.serve;",
    "// HTMLRewriter, Bun.build and bun:test in a comment\nexport const s = 'HTMLRewriter bun:test .resolves';",
  ];
  for (const src of fine) expect(loopOffences(NEG, src), src).toEqual([]);
});
