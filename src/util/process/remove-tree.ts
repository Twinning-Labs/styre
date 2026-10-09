import { chmodSync, lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Removes `root` and everything below it, never following a symbolic link at or below it. A folder
 * of this user's that its owner may not write or search (a read-only tree, such as Go's module
 * cache) gets that permission first, so it can be emptied.
 *
 * Without a deadline it is the native recursive removal, falling back to the walk below only when
 * that fails. With one, it walks and stops when the deadline has passed, leaving the rest: it
 * returns false then, true once `root` is gone. Throws on any other failure.
 */
export function removeTree(
  root: string,
  opts: { deadline?: number; now?: () => number } = {},
): boolean {
  if (opts.deadline === undefined) {
    try {
      rmSync(root, { recursive: true, force: true });
      return true;
    } catch {
      // A read-only folder below, most likely: the walk can fix that.
    }
  }
  const now = opts.now ?? Date.now;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const me = process.geteuid?.();
  const remove = (path: string): boolean => {
    if (now() > deadline) return false;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw e;
    }
    if (!st.isDirectory()) {
      unlinkSync(path);
      return true;
    }
    if ((st.mode & 0o700) !== 0o700 && (me === undefined || st.uid === me)) {
      chmodSync(path, (st.mode & 0o7777) | 0o700);
    }
    for (const name of readdirSync(path)) if (!remove(join(path, name))) return false;
    rmdirSync(path);
    return true;
  };
  return remove(root);
}
