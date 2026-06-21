/** Deterministic, sprawl-only track sizing (M5b-2). full-track tickets get the upfront plan
 *  review (design:review, S1c); fast-track skips straight to implement. "Sprawl" = the size of
 *  the validated work-breakdown. Complexity-aware sizing (a cold grader behind a config flag) is
 *  the M5b-3 follow-up. The threshold is provisional and tunable. */
export const FULL_TRACK_MIN_UNITS = 2;

export function sizeTrack(units: readonly unknown[]): "fast" | "full" {
  return units.length >= FULL_TRACK_MIN_UNITS ? "full" : "fast";
}
