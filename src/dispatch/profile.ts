import { readFileSync } from "node:fs";
import { z } from "zod";

export const PresenceEnum = z.enum(["present", "absent", "unknown"]);
export const TopologyTypeEnum = z.enum([
  "web-service",
  "web-n-tier",
  "desktop",
  "mobile-ios",
  "mobile-android",
  "cli",
  "library",
  "hybrid",
  "unknown",
]);
export const ReleaseMechanismEnum = z.enum([
  "semantic-release",
  "app-store",
  "installer",
  "signed-binary",
  "none",
  "unknown",
]);

const _TriStateBase = z.object({
  presence: PresenceEnum.default("unknown"),
  detail: z.string().default(""),
});
export const TriStateSchema = _TriStateBase.default(_TriStateBase.parse({}));

const _DataStateBase = z.object({
  presence: PresenceEnum.default("unknown"),
  detail: z.string().default(""),
  migrationTool: z.string().optional(), // free-text (DS-5): no enum
});
export const DataStateSchema = _DataStateBase.default(_DataStateBase.parse({}));

const _TopologyBase = z.object({
  type: TopologyTypeEnum.default("unknown"),
  detail: z.string().default(""),
});

const _ReleasePackagingBase = z.object({
  mechanism: ReleaseMechanismEnum.default("unknown"),
  detail: z.string().default(""),
});

const _RuntimeContextBase = z.object({
  topology: _TopologyBase.default(_TopologyBase.parse({})),
  data: DataStateSchema,
  caching: TriStateSchema,
  observability: TriStateSchema,
  configSecrets: TriStateSchema,
  documentation: TriStateSchema,
  releasePackaging: _ReleasePackagingBase.default(_ReleasePackagingBase.parse({})),
});
export const RuntimeContextSchema = _RuntimeContextBase.default(_RuntimeContextBase.parse({}));

export type RuntimeContext = z.infer<typeof RuntimeContextSchema>;

/** The project-profile: canonical stack truth the daemon reads (build-operations §5).
 *  M3a defines the minimal fields render-prompt + dispatch need; the full versioned
 *  artifact contract is M7. Validated via zod (§3a / SC-3). */
export const ProfileSchema = z.object({
  schemaVersion: z.number().int().default(1),
  slug: z.string(),
  targetRepo: z.string(),
  defaultBranch: z.string().default("main"),
  checksSystem: z.enum(["github", "external", "none"]).default("none"),
  commands: z.record(z.string(), z.string()).default({}),
  promptVars: z.record(z.string(), z.string()).default({}),
  testFilePattern: z.string().optional(),
  runtimeContext: RuntimeContextSchema,
});

export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  return ProfileSchema.parse(raw);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}
