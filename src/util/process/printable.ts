/**
 * Text a process can set, such as its command line, reaches the operator's terminal, the run
 * database and the telemetry stream (ENG-485 final review C M1). Its control characters are
 * replaced with `?` first: C0 (including tab and newline), DEL, and C1. A leftover can then neither
 * write terminal escapes (OSC 52 can set the clipboard) nor start a new line that forges a
 * `styre:` line of its own.
 */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/** A path or argument as one shell word (quoted only when it must be), so a command Styre prints for
 *  the operator to paste does what it says even with a space or a quote in it. */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}
