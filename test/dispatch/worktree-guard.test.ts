import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingChanges, revertWorktree, worktreeHead } from "../../src/dispatch/worktree.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const g = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, "app.py"), "print(1)\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return dir;
}

test("pendingChanges lists tracked modifications AND untracked additions", () => {
  const dir = tmpRepo();
  writeFileSync(join(dir, "README.md"), "changed\n"); // tracked mod
  writeFileSync(join(dir, "docs.md"), "new\n"); // untracked add
  const pending = pendingChanges(dir).sort();
  expect(pending).toEqual(["README.md", "docs.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pendingChanges includes a deleted file and both sides of a rename", () => {
  const dir = tmpRepo();
  execFileSync("git", ["-C", dir, "mv", "app.py", "core.py"]); // rename → app.py (old) + core.py (new)
  const pending = pendingChanges(dir);
  expect(pending).toContain("app.py");
  expect(pending).toContain("core.py");
  rmSync(dir, { recursive: true, force: true });
});

test("revertWorktree restores HEAD (tracked + untracked discarded)", () => {
  const dir = tmpRepo();
  const before = worktreeHead(dir);
  writeFileSync(join(dir, "app.py"), "print(2)\n"); // tracked mod
  writeFileSync(join(dir, "evil.py"), "bad\n"); // untracked add
  revertWorktree(dir);
  expect(pendingChanges(dir)).toEqual([]);
  expect(worktreeHead(dir)).toBe(before);
  rmSync(dir, { recursive: true, force: true });
});
