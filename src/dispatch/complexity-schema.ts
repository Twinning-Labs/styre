import { z } from "zod";

/** The cold complexity grader's structured output (M5b-3). Per-dimension 0–10 scores plus a
 *  holistic `overall`. The daemon — not the agent — turns `overall` into a track via combineTrack;
 *  this is a routing heuristic input, never a ship-gate verdict. */
export const ComplexityGradeSchema = z.object({
  dimensions: z.object({
    coupling: z.number().min(0).max(10),
    blast_radius: z.number().min(0).max(10),
    difficulty: z.number().min(0).max(10),
  }),
  overall: z.number().min(0).max(10),
  // Advisory free-text; never load-bearing for the daemon's combineTrack decision. Tolerated
  // absent so a terse grader (no rationale key) is still a valid grade, not a transport failure.
  rationale: z.string().nullable().optional(),
});

export type ComplexityGrade = z.infer<typeof ComplexityGradeSchema>;
