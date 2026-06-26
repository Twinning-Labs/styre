import { VERSION } from "../../version.ts";
import type { TelemetryEvent } from "../events.ts";

type SummaryEvent = Extract<TelemetryEvent, { type: "summary" }>;

/** Dispatch outcomes that mean a unit went red and needed rework. */
const RED_OUTCOMES = ["build-red", "reviewer-blocking", "dispatch-failed"];

function isCi(): boolean {
  const ci = process.env.CI;
  return ci === "true" || ci === "1" || Boolean(process.env.GITHUB_ACTIONS);
}

/** Shared properties on every event. distinct_id is NOT here — it is the capture identity. */
export function superProperties(): Record<string, unknown> {
  return {
    styre_version: VERSION,
    os: process.platform, // 'darwin' | 'linux'
    arch: process.arch, // 'arm64' | 'x64'
    ci: isCi(),
  };
}

export function bucket(n: number): string {
  if (n <= 5) return "1-5";
  if (n <= 20) return "6-20";
  if (n <= 50) return "21-50";
  return "50+";
}

export function durationBucket(ms: number): string {
  const m = ms / 60_000;
  if (m < 5) return "<5m";
  if (m < 15) return "5-15m";
  if (m < 60) return "15-60m";
  return ">60m";
}

/** Map outcome + free-text escalation reasons to a FIXED enum. The raw text never leaves here. */
export function failureBucket(outcome: string, escalationReasons: string[]): string | null {
  if (outcome === "pr-ready" || outcome === "done") return null;
  if (outcome === "parked") return "parked-credits";
  if (outcome === "no-progress") return "no-progress";
  // outcome === "blocked": classify by keyword against the joined reasons (never sent raw).
  const hay = escalationReasons.join(" ").toLowerCase();
  if (/budget|token|limit|exhaust/.test(hay)) return "budget-exhausted";
  if (/plan/.test(hay)) return "plan-defect";
  if (/review|blocking/.test(hay)) return "reviewer-blocking";
  if (/build|test|\bci\b|red/.test(hay)) return "build-red-persistent";
  if (/scope/.test(hay)) return "scope-violation";
  if (/human|gate|approval|merge/.test(hay)) return "human-gate";
  if (/dispatch/.test(hay)) return "dispatch-failed";
  return "unknown";
}

export interface SetupInput {
  projectId: string;
  checksSystem: string;
  componentCount: number;
  componentKinds: string[];
  stackBucket: string;
  topologyType: string;
}
export function setupProperties(p: SetupInput): Record<string, unknown> {
  return {
    project_id: p.projectId,
    checks_system: p.checksSystem,
    component_count: p.componentCount,
    component_kinds: p.componentKinds,
    stack_bucket: p.stackBucket,
    topology_type: p.topologyType,
  };
}

export interface RunStartedInput {
  projectId: string;
  resumed: boolean;
  tracker: string;
  forge: string;
}
export function runStartedProperties(p: RunStartedInput): Record<string, unknown> {
  return {
    project_id: p.projectId,
    resumed: p.resumed,
    tracker: p.tracker,
    forge: p.forge,
  };
}

export function runCompletedProperties(
  summary: SummaryEvent,
  durationMs: number,
  config: { complexityGrading: boolean; onPlanDefect: string },
): Record<string, unknown> {
  const hadRed = RED_OUTCOMES.some((k) => (summary.dispatch_outcomes[k] ?? 0) > 0);
  const success = summary.outcome === "pr-ready";
  return {
    outcome: summary.outcome,
    terminal_stage: summary.stage,
    ticks_bucket: bucket(summary.ticks),
    dispatch_count_bucket: bucket(summary.dispatch_count),
    cycle_count_bucket: bucket(summary.cycle_count),
    duration_bucket: durationBucket(durationMs),
    first_time_ci_pass: success && !hadRed,
    autonomous_fix: success && hadRed && summary.escalation_count === 0,
    failure_bucket: failureBucket(summary.outcome, summary.escalation_reasons),
    complexity_grading: config.complexityGrading,
    on_plan_defect: config.onPlanDefect,
  };
}

export interface CliErrorInput {
  command: string;
  exitCode: number;
  errorClass: string;
}
export function cliErrorProperties(p: CliErrorInput): Record<string, unknown> {
  return {
    command: p.command,
    exit_code: p.exitCode,
    error_class: p.errorClass,
  };
}

/** The complete allow-list of property keys any builder may emit. Used by the guard test and the
 *  runtime assertion in index.ts. Adding a property REQUIRES adding it here. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  // super properties
  "styre_version",
  "os",
  "arch",
  "ci",
  // setup_completed
  "project_id",
  "checks_system",
  "component_count",
  "component_kinds",
  "stack_bucket",
  "topology_type",
  // run_started
  "resumed",
  "tracker",
  "forge",
  // run_completed
  "outcome",
  "terminal_stage",
  "ticks_bucket",
  "dispatch_count_bucket",
  "cycle_count_bucket",
  "duration_bucket",
  "first_time_ci_pass",
  "autonomous_fix",
  "failure_bucket",
  "complexity_grading",
  "on_plan_defect",
  // cli_error
  "exit_code",
  "error_class",
  "command",
]);
