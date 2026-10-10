import { join, resolve, sep } from "node:path";
import { configError, usageError } from "./errors.ts";

const RULE = {
  ident:
    'An ident names one checkpoint folder: not empty, not "." or "..", and no "/", "\\" or NUL.',
  slug: 'A slug names a folder and may nest with "/": each part between slashes not empty, not "." or "..", and no "\\" or NUL.',
} as const;

/** Why `value` cannot name a checkpoint folder, or null when it can (operator rulings,
 *  2026-10-10). An ident is one folder name. A slug may hold `/` and then nests (conventions.md),
 *  so each part between slashes is one folder name: `team/app` is fine; `team/..`, `/abs`, `a//b`
 *  and `a/./b` are not. */
export function checkpointNameProblem(what: "ident" | "slug", value: string): string | null {
  if (what === "ident" && value.includes("/")) return 'it holds "/"';
  for (const part of what === "slug" ? value.split("/") : [value]) {
    if (part === "") return "it has an empty part";
    if (part === "." || part === "..") return `it has a part "${part}"`;
    if (/[\\\0]/.test(part)) return 'it holds "\\" or NUL';
  }
  return null;
}

/** A name from the command line, derived from the repository, or from the tracker: a usage error
 *  (exit 64). */
export function assertCheckpointName(what: "ident" | "slug", value: string): void {
  const problem = checkpointNameProblem(what, value);
  if (problem !== null) {
    throw usageError(`not a valid ${what}: ${JSON.stringify(value)} (${problem})`, RULE[what]);
  }
}

/** A slug read from a profile file: a config error (exit 78) that names the file. */
export function assertProfileSlug(slug: string, file: string): void {
  const problem = checkpointNameProblem("slug", slug);
  if (problem !== null) {
    throw configError({
      file,
      field: "slug",
      detail: `${JSON.stringify(slug)}: ${problem}. ${RULE.slug}`,
      recovery: "Run styre setup again with --slug <name>, or correct the slug in that file.",
    });
  }
}

/** `<root>/<slug>/<ident>` once both names pass, and, as a second line of defence, only when the
 *  resolved path stays inside `root`. Failing that second check is a Styre defect (a plain Error,
 *  exit 70): the name check above makes it unreachable. */
export function checkpointPath(root: string, slug: string, ident: string): string {
  assertCheckpointName("slug", slug);
  assertCheckpointName("ident", ident);
  const base = resolve(root);
  if (!resolve(base, slug, ident).startsWith(base + sep)) {
    throw new Error(`the checkpoint path of ${JSON.stringify(`${slug}/${ident}`)} leaves ${base}`);
  }
  return join(root, slug, ident);
}
