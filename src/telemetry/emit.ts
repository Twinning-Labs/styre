import { type TelemetryEvent, TelemetryEventSchema } from "./events.ts";

/** A telemetry sink. The OSS contract is NDJSON to stdout (stdoutSink); libraries default to
 *  noopSink (never write to stdout unless told); tests inject a capturing sink. */
export type TelemetrySink = (event: TelemetryEvent) => void;

/** The OSS↔plane wire form: one JSON object per line on stdout. Validation is non-fatal —
 *  telemetry is best-effort/lossy (§5.3), so a schema-drift bug must never throw here and flip
 *  an otherwise-successful run into a crash. On a validation failure we still emit the row and
 *  write a diagnostic to stderr (human channel; stdout stays pure NDJSON). */
export const stdoutSink: TelemetrySink = (event) => {
  const check = TelemetryEventSchema.safeParse(event);
  if (!check.success) {
    const detail = check.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    process.stderr.write(`telemetry: emitted event failed schema validation: ${detail}\n`);
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

/** The library default — emit nothing. */
export const noopSink: TelemetrySink = () => {};
