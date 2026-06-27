import type { TelemetryEvent } from "../events.ts";
import { type AnalyticsClient, createPosthogClient } from "./client.ts";
import { telemetryEnabled } from "./consent.ts";
import { loadOrCreateState, markNoticeShown } from "./id.ts";
import {
  ALLOWED_KEYS,
  type CliErrorInput,
  type RunStartedInput,
  type SetupInput,
  cliErrorProperties,
  runCompletedProperties,
  runStartedProperties,
  setupProperties,
  superProperties,
} from "./properties.ts";

type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;

const NOTICE =
  "styre collects anonymous usage analytics to improve the project. No code, repo names, " +
  "ticket IDs, or costs are sent. Opt out any time with STYRE_TELEMETRY=0 or DO_NOT_TRACK=1.";

export interface Analytics {
  setupCompleted(p: SetupInput): void;
  runStarted(p: RunStartedInput): void;
  runCompleted(
    summary: SummaryEvent,
    durationMs: number,
    config: { complexityGrading: boolean; onPlanDefect: string },
  ): void;
  cliError(p: CliErrorInput): void;
  shutdown(): Promise<void>;
}

const NOOP: Analytics = {
  setupCompleted() {},
  runStarted() {},
  runCompleted() {},
  cliError() {},
  async shutdown() {},
};

/** Defense-in-depth: drop any key not on the allow-list before it reaches the wire. */
function sanitize(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (ALLOWED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export function createAnalytics(
  config: { telemetry: boolean },
  deps?: { client?: AnalyticsClient },
): Analytics {
  // Disabled path: return NOOP before any I/O.
  if (!telemetryEnabled(config)) return NOOP;

  // Post-consent setup must NEVER throw into the CLI: createAnalytics is called outside run.ts's
  // try/catch, so an id-file persistence failure (read-only FS, ENOTDIR, …) would crash the
  // process and change its exit code. Any error here degrades silently to NOOP.
  let state: ReturnType<typeof loadOrCreateState>;
  let client: AnalyticsClient;
  try {
    state = loadOrCreateState();
    if (!state.noticeShown) {
      process.stderr.write(`${NOTICE}\n`);
      markNoticeShown(state);
    }
    client = deps?.client ?? createPosthogClient();
  } catch {
    return NOOP;
  }

  const send = (event: string, props: Record<string, unknown>) => {
    client.capture(state.distinctId, event, sanitize({ ...superProperties(), ...props }));
  };

  return {
    setupCompleted: (p) => send("setup_completed", setupProperties(p)),
    runStarted: (p) => send("run_started", runStartedProperties(p)),
    runCompleted: (summary, durationMs, cfg) =>
      send("run_completed", runCompletedProperties(summary, durationMs, cfg)),
    cliError: (p) => send("cli_error", cliErrorProperties(p)),
    shutdown: () => client.shutdown(),
  };
}
