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

/** The configured agent CLI is missing or below its supported version (ENG-326). Distinct from
 *  toolchainError because an out-of-range binary IS runnable — the fix is to upgrade, not install.
 *  Both variants exit 69 (non-retry), so a missing/old CLI never reaches the transient-retry path. */
export function agentCliError(
  e:
    | { reason: "missing"; command: string }
    | { reason: "unsupported-version"; command: string; found: string; required: string },
): StyreError {
  if (e.reason === "missing") {
    return new StyreError({
      code: EXIT.TOOLCHAIN_MISSING,
      headline: `'${e.command}' is not installed or not on PATH`,
      detail: `Styre dispatches every agent run by shelling out to the '${e.command}' CLI.`,
      recovery: `Install the '${e.command}' CLI, or set agent.command in your profile, then re-run.`,
    });
  }
  return new StyreError({
    code: EXIT.TOOLCHAIN_MISSING,
    headline: `'${e.command}' ${e.found} is below the supported minimum ${e.required}`,
    detail: `Styre's '${e.command}' adapter is pinned to CLI flags that require ${e.required} or newer.`,
    recovery: `Upgrade the '${e.command}' CLI to >= ${e.required} and re-run.`,
  });
}

/** Coarse operator-error kind derived from the shared exit-code scheme, emitted on `cli_error`
 *  so analytics can distinguish usage vs config vs toolchain vs internal — which `error_class`
 *  can't (every StyreError shares one class). Unknown codes collapse to "other". */
export function errorKindForExit(code: number): string {
  switch (code) {
    case EXIT.USAGE:
      return "usage";
    case EXIT.CONFIG:
      return "config";
    case EXIT.TOOLCHAIN_MISSING:
      return "toolchain";
    case EXIT.RESUME_REFUSED:
      return "resume_refused";
    case EXIT.OPERATIONAL:
      return "operational";
    case EXIT.TEMPFAIL:
      return "tempfail";
    case EXIT.INTERNAL:
      return "internal";
    default:
      return "other";
  }
}
