/**
 * Recognising the ENVIRONMENTAL BLOCKER in a failed check's output (ENG-424, hole 2).
 *
 * `ac_check.red_class` is frozen from the RED-first run and never revisited, so a check the
 * adjudicator called `environmental` stays advisory for the rest of the run
 * (`post-implement-rerun.ts`). That is right while the blocker is still there, and wrong the
 * moment it is not: if the environment recovers and the check then fails on its ASSERTION, the
 * stale label shields a real red and the gate passes on a check that genuinely failed.
 *
 * The obvious fix — re-derive the class from the new output — does not work. `CoarseResult`
 * cannot separate "the test ran and failed" from "the test could not start": django's
 * `python3 -m pytest` printed `No module named pytest` and exited 1, which
 * `interpretRunOutput` buckets as `red`, exactly like a failed assertion. And re-running
 * `classifyPrior` would DISCARD the adjudicator's judgment — on that same output the prior
 * returns `adjudicate-red`, so a naive re-classify would gate the very case the adjudicator
 * correctly called environmental.
 *
 * So this module asks a narrower, answerable question instead: **is the specific blocker that
 * was adjudicated still present?** A named missing module or missing command is a concrete,
 * matchable fact. If it persists, the frozen class still describes reality. If it is gone and
 * the check is still red, the failure is no longer the one that was classified, and the label
 * must stop shielding it.
 *
 * Deliberately conservative in one direction: an output with NO recognised blocker returns
 * `null`, and the caller keeps the frozen class. "We cannot tell" must never be treated as
 * "the adjudicator was wrong".
 */

/** A normalised, comparable identity for one environmental blocker — e.g. `module:pytest`,
 *  `command:jest`. Two outputs blocked by the same thing produce the same key. */
export type BlockerKey = string;

/** Ordered most-specific first. Each pattern's first capture group is the blocked name. */
const BLOCKER_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // Python: `ModuleNotFoundError: No module named 'pytest'`, and the bare interpreter form
  // `/usr/bin/python3: No module named pytest` (django-12325's exact failure).
  { kind: "module", re: /No module named ['"]?([\w.]+)['"]?/ },
  // Node: `Cannot find module 'vitest'`.
  { kind: "module", re: /[Cc]annot find module ['"]?([\w./@-]+)['"]?/ },
  // POSIX shell: `sh: 1: jest: not found` (the darkreader failure ENG-399 fixed).
  { kind: "command", re: /(?:^|\s)([\w.\-/]+): not found/ },
  // bash/zsh: `bash: jest: command not found`.
  { kind: "command", re: /(?:^|\s)([\w.\-/]+): command not found/ },
  // Dynamic linker: `error while loading shared libraries: libxyz.so.1`.
  { kind: "library", re: /error while loading shared libraries: ([\w.+-]+)/ },
];

/**
 * The blocker this output reports, or `null` when it reports none this module recognises.
 *
 * `null` is the "cannot tell" answer, not "there is no blocker" — every caller must treat it
 * as a reason to leave the existing classification alone.
 */
export function environmentalBlocker(rawOutput: string): BlockerKey | null {
  if (!rawOutput) return null;
  for (const { kind, re } of BLOCKER_PATTERNS) {
    const m = rawOutput.match(re);
    if (m?.[1]) return `${kind}:${m[1]}`;
  }
  return null;
}

/**
 * Does the blocker adjudicated at RED-first time still block at post-implement time?
 *
 * `true` keeps the frozen `environmental` class (the check stays advisory); `false` means the
 * adjudicated blocker is gone while the check is still red, so the label no longer describes
 * this failure and must not shield it.
 *
 * Returns `true` — keep the class — whenever the ORIGINAL output named no recognisable
 * blocker. Without a blocker to track we have no evidence the adjudicator's call is stale, and
 * overriding a human-equivalent judgment on no evidence is the worse error.
 */
export function blockerPersists(redFirstOutput: string, postImplementOutput: string): boolean {
  const original = environmentalBlocker(redFirstOutput);
  if (original === null) return true; // cannot tell → defer to the frozen class
  return environmentalBlocker(postImplementOutput) === original;
}
