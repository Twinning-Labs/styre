/** Operator-facing CLI errors with a baked-in process exit code. The error boundary (output.ts
 *  `guard`) renders these once (headline + detail + recovery) and exits with `code`. Anything that
 *  is NOT a StyreError reaching the boundary is treated as an internal bug (EXIT.INTERNAL). */

/** The exit-code space, shared across all four subcommands (sysexits-aligned). */
export const EXIT = {
  OK: 0,
  OPERATIONAL: 1, // blocked / no-progress: ran fine, dead-end a human should look at
  USAGE: 64, // EX_USAGE: CLI misuse
  RESUME_REFUSED: 65, // EX_DATAERR: resume refused, HEAD moved
  TOOLCHAIN_MISSING: 69, // EX_UNAVAILABLE: a required program is not installed
  INTERNAL: 70, // EX_SOFTWARE: unexpected crash / internal invariant
  TEMPFAIL: 75, // parked (out of budget) and escalated (handed to a human) — both resumable-later
  CONFIG: 78, // EX_CONFIG: bad config/profile value, unknown adapter, unresolved profile
} as const;

export class StyreError extends Error {
  readonly code: number;
  readonly headline: string;
  readonly detail?: string;
  readonly recovery?: string;
  constructor(args: { code: number; headline: string; detail?: string; recovery?: string }) {
    super(args.headline);
    this.name = "StyreError";
    this.code = args.code;
    this.headline = args.headline;
    this.detail = args.detail;
    this.recovery = args.recovery;
  }
}

export function usageError(headline: string, recovery?: string): StyreError {
  return new StyreError({ code: EXIT.USAGE, headline, recovery });
}

export function configError(a: {
  file: string;
  field?: string;
  detail?: string;
  recovery?: string;
}): StyreError {
  const headline = a.field
    ? `invalid config — ${a.field} (${a.file})`
    : `invalid config — ${a.file}`;
  return new StyreError({
    code: EXIT.CONFIG,
    headline,
    detail: a.detail,
    recovery: a.recovery ?? "Fix the value and re-run.",
  });
}

export function toolchainError(detail: string): StyreError {
  return new StyreError({
    code: EXIT.TOOLCHAIN_MISSING,
    headline: "cannot start — required commands are not runnable on this machine",
    detail,
    recovery: "Install the missing tool(s) and re-run.",
  });
}
