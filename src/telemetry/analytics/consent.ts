/** Resolve whether OSS analytics is on. Off if ANY opt-out source says off. Honors the
 *  DO_NOT_TRACK standard (any value other than ""/"0"/"false") and STYRE_TELEMETRY=0. */
export function telemetryEnabled(config: { telemetry: boolean }): boolean {
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt !== undefined && dnt !== "" && dnt !== "0" && dnt !== "false") return false;
  const styre = process.env.STYRE_TELEMETRY;
  if (styre === "0" || styre === "false") return false;
  return config.telemetry !== false;
}
