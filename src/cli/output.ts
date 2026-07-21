import { EXIT, StyreError } from "./errors.ts";

/** The one place operator text is shaped: `styre <cmd>: <headline>`, indented detail, recovery. */
export function formatMessage(
  cmd: string,
  headline: string,
  detail?: string,
  recovery?: string,
): string {
  const lines = [`styre ${cmd}: ${headline}`];
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
 *  catch is the only place it double-prints + exits 1). Renders once, sets the exit code, returns. */
export async function guard(cmd: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (err instanceof StyreError) {
      process.stderr.write(`${renderError(cmd, err)}\n`);
      process.exitCode = err.code;
    } else {
      process.stderr.write(`${renderInternal(cmd, err)}\n`);
      process.exitCode = EXIT.INTERNAL;
    }
  }
}
