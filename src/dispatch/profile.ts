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

export const CommandValueSchema = z.union([
  z.string().min(1),
  z.object({ unavailable: z.literal(true) }).strict(),
]);
export type CommandValue = z.infer<typeof CommandValueSchema>;

export const ComponentSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  commands: z.record(z.string(), CommandValueSchema).default({}),
  testFilePattern: z.string().optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

/** The project-profile: canonical stack truth the daemon reads (build-operations §5).
 *  schemaVersion 2 introduces the components[] model (polyglot-monorepo support). */
export const ProfileSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  slug: z.string(),
  targetRepo: z.string(),
  defaultBranch: z.string().default("main"),
  // Stable random analytics id for this project (sent to PostHog as project_id). Never encodes the
  // slug/name. Generated at `styre setup`; absent in legacy profiles (lazily added on next run).
  analyticsId: z.string().optional(),
  checksSystem: z.enum(["github", "external", "none"]).default("none"),
  components: z.array(ComponentSchema).default([]),
  repoCommands: z.record(z.string(), z.string()).default({}),
  promptVars: z.record(z.string(), z.string()).default({}),
  runtimeContext: RuntimeContextSchema,
});

export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  if (raw && typeof raw === "object" && "commands" in raw) {
    throw new Error(
      "profile: legacy flat `commands` field (schemaVersion 1) is no longer supported. " +
        "Re-run `styre setup` to regenerate a components[] profile (schemaVersion 2).",
    );
  }
  return ProfileSchema.parse(raw);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}
