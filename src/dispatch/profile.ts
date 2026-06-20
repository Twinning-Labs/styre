import { readFileSync } from "node:fs";
import { z } from "zod";

/** The project-profile: canonical stack truth the daemon reads (build-operations §5).
 *  M3a defines the minimal fields render-prompt + dispatch need; the full versioned
 *  artifact contract is M7. Validated via zod (§3a / SC-3). */
export const ProfileSchema = z.object({
  slug: z.string(),
  targetRepo: z.string(),
  defaultBranch: z.string().default("main"),
  checksSystem: z.enum(["github", "external", "none"]).default("none"),
  commands: z.record(z.string(), z.string()).default({}),
  promptVars: z.record(z.string(), z.string()).default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  return ProfileSchema.parse(raw);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}
