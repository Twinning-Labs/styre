import type { TelemetryEvent } from "./events.ts";

/** A telemetry sink. The OSS contract is NDJSON to stdout (stdoutSink); libraries default to
 *  noopSink (never write to stdout unless told); tests inject a capturing sink. */
export type TelemetrySink = (event: TelemetryEvent) => void;

/** The OSS↔plane wire form: one JSON object per line on stdout. */
export const stdoutSink: TelemetrySink = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

/** The library default — emit nothing. */
export const noopSink: TelemetrySink = () => {};
