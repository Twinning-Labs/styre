import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseConfigOrThrow } from "../config/parse-config.ts";

export const PresenceEnum = z.enum(["present", "absent", "unknown"]);
export const TopologyTypeEnum = z.enum([
  "web-service",
  "web-n-tier",
  "desktop",
  "mobile-ios",
  "mobile-android",
  "browser-extension",
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
  "pypi",
  "conda",
  "npm",
  "cargo",
  "gem",
  "composer",
  "maven",
  "go-module",
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

/** A repo-relative dir string is safe iff non-empty, not absolute, and has no `..`/`.`/empty
 *  segment (after trim). Deliberately a tiny inline predicate — a subset of setup/manifests.ts's
 *  `isSafePath` — rather than importing from setup/, which would reverse the dispatch→setup
 *  layering. This is the RUN-path parse-boundary backstop: `profile.json` is hand-editable and
 *  its `dir` field drives verify command cwd (WO-9 Task 2), so a malicious/malformed `dir` (e.g.
 *  `../..`) must be rejected at `parseProfile`, not just at detection time. */
const isSafeDir = (d: string): boolean => {
  const t = d.trim();
  if (t === "" || t.startsWith("/")) return false; // reject empty / absolute
  return !t.split("/").some((seg) => {
    const s = seg.trim();
    return s === ".." || s === "." || s === "";
  });
};

/** A single detected stack component. schemaVersion 3 adds per-component `extensions[]` for
 *  file-identity routing and the optional `prepare` install command (EXECUTED by the
 *  runner-owned provision step before the first verify), plus the optional `dir` field
 *  (module root, relative to repo root — WO-9). */
/** Frameworks `checks:dispatch` knows how to invoke. Mirrors `CheckFramework` in
 *  `src/dispatch/check-selector.ts`; kept as a zod enum here so a profile carrying an
 *  unknown framework is rejected at load rather than degrading to a coarse `error` at
 *  check time (ENG-399). */
export const CheckFrameworkEnum = z.enum([
  "pytest",
  "jest",
  "vitest",
  "go",
  "cargo",
  "junit-maven",
  "junit-gradle",
  "rspec",
  "minitest",
  "phpunit",
]);

/**
 * A component's RUNTIME IDENTITY — the operational discriminator, not a description.
 *
 * schemaVersion 4 closes this set (ENG-399). It used to be `z.string().min(1)` while every
 * consumer switched on a fixed list, and `prompts/setup-discover.md` asked the discovery agent
 * for "a precise free-text stack label". Those are irreconcilable: on
 * darkreader__darkreader-7241 the agent answered `browser-extension` — an accurate description,
 * a legal `TopologyTypeEnum` member, and an invalid discriminator. `frameworkFor` fell to its
 * `default` and returned null WITHOUT reading the test command, `isComponentReady` returned
 * false, and the run escalated at design having written no code.
 *
 * Description now lives in `label`. This field is scan-authoritative — see `mergeComponents`.
 */
export const ComponentKindEnum = z.enum([
  "node",
  "sveltekit",
  "python",
  "go",
  "rust",
  "jvm-maven",
  "jvm-gradle",
  "ruby",
  "php",
]);
export type ComponentKind = z.infer<typeof ComponentKindEnum>;
/** The runtime identities styre can actually route. Exported so an error can NAME them rather
 *  than leaving the operator to guess what a valid value is. */
export const KNOWN_COMPONENT_KINDS: ReadonlySet<string> = new Set(ComponentKindEnum.options);

/**
 * How to actually RUN this component's tests, qualified at setup time (ENG-399).
 *
 * A framework name alone does not establish that styre can execute a check. `binaryFor("jest")`
 * returns the bare binary, dropping the configured launcher and its `--config`; darkreader has
 * no root jest config and a three-project `tests/jest.config.js`, so the bare invocation loads
 * none of the ts-jest/jsdom/tsconfig setup the check needs. The launcher is therefore recorded
 * WITH its configuration, and selector arguments are appended to it.
 */
export const TestActionSchema = z.object({
  /** Validated framework — a lookup for `frameworkFor`, not a regex guess over a command. */
  framework: CheckFrameworkEnum,
  /** Argv prefix that runs the suite WITH its configuration. Selector args are appended, so a
   *  script wrapper must already carry the `--` separator (e.g. `npm run test:ci --`). */
  launcher: z.string().min(1),
});
export type TestAction = z.infer<typeof TestActionSchema>;

/**
 * What a detected component IS TO THIS REPO (ENG-425) — as distinct from `kind` (how to run it)
 * and `label` (how to describe it).
 *
 * The deterministic scan anchors EXISTENCE and must keep doing so: `mergeComponents` drops any
 * component the agent invents. But that rule had no inverse, and a scan that creates a component
 * for every nested `setup.py` creates them for fixtures too. On pytest-dev__pytest-5631 the
 * scan found `extra/setup-py.test/setup.py`, gave it `prepare: pip install -e .`, and the
 * discovery agent — which correctly recognised it, writing "legacy stub package (py.test name
 * reservation, sdist-only, no real tests)" into `label` — had no field in which to say "do not
 * provision this". The install failed and took the whole run with it at tick 1.
 *
 * `role` is that field. The agent still cannot invent a component; it can only classify one the
 * scan already found, which keeps the existence rule intact while letting a judgment the agent
 * was already making become structural instead of decorative.
 *
 * ABSENT means primary. A profile written before this field existed reads as all-primary — i.e.
 * exactly the old behaviour — so there is no schema bump and no migration. The field is
 * `optional()` rather than `default("primary")` deliberately: a default would make `role`
 * required on the inferred type and force a literal into ~14 files of hand-built test fixtures,
 * burying a behavioural change in mechanical churn. The cost of `optional()` is that every
 * consumer must know absent means primary — so NO consumer is allowed to know. `isPrimary` below
 * is the single place that decides, and `test/dispatch/component-role-invariant.test.ts` fails
 * the build if anything else reads `.role` to make that call.
 */
export const ComponentRoleEnum = z.enum(["primary", "fixture", "example", "vendored"]);
export type ComponentRole = z.infer<typeof ComponentRoleEnum>;

/** THE ONLY place "does this component take part in the run?" is decided. Absent = primary:
 *  a scan that saw a manifest and nothing else has expressed no opinion, and no opinion means
 *  the component counts. */
export function isPrimary(c: { role?: ComponentRole }): boolean {
  return (c.role ?? "primary") === "primary";
}

export const ComponentSchema = z.object({
  name: z.string().min(1),
  kind: ComponentKindEnum,
  /** What this component is to the repo — see `ComponentRoleEnum`. Anything but `primary` is
   *  excluded from the run (provision/build/test/check) and REPORTED, never silently dropped.
   *  Absent = primary; read it through `isPrimary`, never directly. */
  role: ComponentRoleEnum.optional(),
  /** Free-text stack description (e.g. "browser-extension", "cli tool"). Agent-authorable and
   *  carried into prompts; NEVER switched on. Purely descriptive by construction. */
  label: z.string().optional(),
  /** Qualified test invocation. Absent → `frameworkFor` falls back to inferring from `kind` +
   *  the `test` command, which is the pre-ENG-399 behaviour and still correct when it resolves. */
  testAction: TestActionSchema.optional(),
  paths: z.array(z.string().min(1)).min(1),
  commands: z.record(z.string(), CommandValueSchema).default({}),
  testFilePattern: z.string().optional(),
  extensions: z.array(z.string()).default([]),
  /** Install command EXECUTED by the runner-owned `provision` step (src/dispatch/provision.ts)
   *  before the first verify — makes the detected verify command runnable against the worktree
   *  source. Optional; absent → provision skips this component. `isCommandSafe`-validated at
   *  setup (detect-components.ts). (Was WO-12 detect-only "never run".) */
  prepare: z.string().optional(),
  /** Module root directory, relative to repo root; absent means root (WO-9 non-root modules). */
  dir: z.string().refine(isSafeDir, "unsafe dir (absolute or traversal)").optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

/** The project-profile: canonical stack truth the daemon reads (build-operations §5).
 *  schemaVersion 3 adds per-component `extensions[]` for file-identity routing. */
export const ProfileSchema = z.object({
  schemaVersion: z.literal(4).default(4),
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

export function parseProfile(raw: unknown, file = "profile.json"): Profile {
  if (raw && typeof raw === "object" && "commands" in raw) {
    throw new Error(
      "profile: legacy flat `commands` field (schemaVersion 1) is no longer supported. " +
        "Re-run `styre setup` to regenerate a components[] profile (schemaVersion 3).",
    );
  }
  if (raw && typeof raw === "object" && (raw as { schemaVersion?: unknown }).schemaVersion === 2) {
    throw new Error(
      "profile: schemaVersion 2 profile does not carry per-component extensions[] required for " +
        "file-identity routing. Re-run `styre setup` to regenerate a schemaVersion-4 profile.",
    );
  }
  if (raw && typeof raw === "object" && (raw as { schemaVersion?: unknown }).schemaVersion === 3) {
    // Deliberately NOT migrated (ENG-399). A v3 `kind` is free text and may hold a value no
    // consumer switches on — coercing it would silently reinstate the defect this bump closes.
    throw new Error(
      "profile: schemaVersion 3 carries a free-text component `kind`, which is no longer a valid " +
        "runtime identity (a value outside the known set silently disables framework detection " +
        "and provision readiness). Re-run `styre setup` to regenerate a schemaVersion-4 profile.",
    );
  }
  return parseConfigOrThrow(ProfileSchema, raw, file);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")), path);
}
