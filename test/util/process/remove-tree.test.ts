// removeTree: removes a folder and everything below it, never following a symbolic link at or below
// it, and making a read-only tree of this user's writable first. Both of its ways are checked: the
// native removal with the walk it falls back to, and the walk alone (with a deadline).
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { removeTree } from "../../../src/util/process/remove-tree.ts";
import { makeTempDir } from "../../helpers/temp.ts";

const readOnly: string[] = [];
afterEach(() => {
  // So the run can remove what a failing test left.
  for (const d of readOnly.splice(0)) if (existsSync(d)) chmodSync(d, 0o700);
});

/** A read-only tree (so the native removal fails and the walk runs) that holds links to `outside`,
 *  a read-only folder with a file in it. */
function treeWithLinks(): { tree: string; outside: string } {
  const base = makeTempDir("styre-remove-tree-");
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious"), "keep");
  const tree = join(base, "tree");
  const ro = join(tree, "mod", "pkg@v1");
  mkdirSync(ro, { recursive: true });
  writeFileSync(join(ro, "a.go"), "x");
  symlinkSync(outside, join(ro, "link-to-outside"));
  symlinkSync(outside, join(tree, "top-link"));
  for (const d of [ro, join(tree, "mod"), outside]) {
    chmodSync(d, 0o555);
    readOnly.push(d);
  }
  return { tree, outside };
}

for (const way of ["native, then the walk", "the walk, with a deadline"] as const) {
  test(`${way}: a read-only tree goes, and a folder it links to is neither entered nor changed`, () => {
    const { tree, outside } = treeWithLinks();
    const deadline = way === "the walk, with a deadline" ? Date.now() + 60_000 : undefined;
    expect(removeTree(tree, { deadline })).toBe(true);
    expect(existsSync(tree)).toBe(false);
    expect(readdirSync(outside)).toEqual(["precious"]);
    expect(statSync(outside).mode & 0o777).toBe(0o555);
  });
}
