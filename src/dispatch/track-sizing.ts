/** Deterministic, sprawl-only track sizing (M5b-2). full-track tickets get the upfront plan
 *  review (design:review, S1c); fast-track skips straight to implement. "Sprawl" = the size of
 *  the validated work-breakdown. Complexity-aware sizing (a cold grader behind a config flag) is
 *  the M5b-3 follow-up. The threshold is provisional and tunable. */
export const FULL_TRACK_MIN_UNITS = 2;

export function sizeTrack(units: readonly unknown[]): "fast" | "full" {
  return units.length >= FULL_TRACK_MIN_UNITS ? "full" : "fast";
}

/** Combine-rule thresholds (M5b-3). Provisional + tunable (post-cutover learning tunes them). */
export const COMPLEXITY_FULL_THRESHOLD = 5;
export const SPRAWL_FLOOR = 5;

/** Hybrid sizing: complexity leads (a high overall grade → full even for a small plan), with a
 *  deterministic sprawl floor as a backstop against the grader under-rating a large coordination
 *  job. Bidirectional — a low grade keeps a moderately-sprawling plan fast. */
export function combineTrack(unitCount: number, overall: number): "fast" | "full" {
  return overall >= COMPLEXITY_FULL_THRESHOLD || unitCount >= SPRAWL_FLOOR ? "full" : "fast";
}
