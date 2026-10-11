import { isStopping } from "../util/process/door.ts";
import { EXIT, StyreError } from "./errors.ts";

/** The one place operator text is shaped: `styre <cmd>: <headline>`, indented detail, recovery.
 *  A headline that already names its subsystem (`migrate: ...`, from src/db/migrate.ts) keeps that
 *  name under another command (`styre run: migrate: ...`) and is not repeated under its own
 *  (`styre migrate: ...`, never `styre migrate: migrate: ...`). */
export function formatMessage(
  cmd: string,
  headline: string,
  detail?: string,
  recovery?: string,
): string {
  const own = `${cmd}: `;
  const said = headline.startsWith(own) ? headline.slice(own.length) : headline;
  const lines = [`styre ${cmd}: ${said}`];
  if (detail) for (const l of detail.split("\n")) lines.push(`  ${l}`);
  if (recovery) lines.push(recovery);
  return lines.join("\n");
}

export function renderError(cmd: string, e: StyreError): string {
  return formatMessage(cmd, e.headline, e.detail, e.recovery);
}

const ISSUES_URL = "https://github.com/Twinning-Labs/styre/issues";

export function renderInternal(cmd: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = process.env.DEBUG && err instanceof Error && err.stack ? err.stack : msg;
  return formatMessage(cmd, `internal error — please report to ${ISSUES_URL}`, detail);
}

/** The error boundary. Wrap each subcommand's body so citty's runMain never sees a throw (its
 *  catch is the only place it double-prints + exits 1). Renders once, sets the exit code, returns.
 *  While a stop is in progress any error is the interruption itself, whatever its type (a refused
 *  write raises SQLite's "readonly database", not RunInterrupted): it says nothing and leaves the
 *  exit code alone, because the stop handler owns the exit (ENG-485 section 7.5, m1). */
export async function guard(cmd: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (isStopping()) return;
    if (err instanceof StyreError) {
      process.stderr.write(`${renderError(cmd, err)}\n`);
      process.exitCode = err.code;
    } else {
      process.stderr.write(`${renderInternal(cmd, err)}\n`);
      process.exitCode = EXIT.INTERNAL;
    }
  }
}
