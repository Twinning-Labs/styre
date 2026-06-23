# Profile Runtime Context (CDOT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Styre's project profile carry probed runtime context (topology, data/migrations, caching, observability, config/secrets, documentation, release/packaging) and force the design stage to address it via a profile-consistency gate.

**Architecture:** Extend the zod `ProfileSchema` with a versioned `runtimeContext` block (hybrid: typed flags the daemon gates on + free-text detail for the agent). A deterministic probe populates the flags at `styre setup`; unknowns are bubbled up to the operator and re-probe merges without clobbering operator edits. The design-extract structured output gains a `cdotImpact` block, validated by a deterministic gate (coverage of flagged sections + migration-unit ordering) that mirrors the existing `validateExtraction` postcondition, and `documentation.applies` flips the existing `needs_docs` flag.

**Tech Stack:** TypeScript + Bun, zod for schemas, `bun test` for tests, embedded SQLite (unaffected here — the profile is a JSON artifact, not a SQLite table).

**Spec:** `docs/brainstorms/2026-06-23-profile-runtime-context-design.md`

## Global Constraints

- **Open-core seam stays stable** — every new `ProfileSchema` field MUST carry a zod `.default()` so an existing on-disk `profile.json` still validates. (build-operations.md §5)
- **DS-5 stack-agnostic** — `migrationTool` and stack vocab stay free-text; no hardcoded stack enums beyond the coarse `topology.type` / `releasePackaging.mechanism` lists, which include `unknown`/`hybrid` escape hatches.
- **Ground truth over self-report** — the daemon gates only on state-computable facts (presence + structural ordering); it never grades analysis *quality*.
- **Profile = repo shape, never operator policy** — nothing in this plan touches `RuntimeConfig` (`src/config/runtime-config.ts`).
- **No SQLite schema change** — the profile is `~/.config/styre/<slug>/profile.json`, not a table. `ticket.needs_docs` already exists in `src/db/schema.sql`. Do **not** edit `schema.sql` (or its `docs/architecture/` twin) for this work.
- **Test runner:** `bun test`. Tests live under `test/`, mirroring `src/`.
- **`unknown` is the default** for every runtime-context flag — a probe that emits nothing fails toward "must-address," not silent skip.

---

### Task 1: Profile schema — `schemaVersion` + `runtimeContext` block

**Files:**
- Modify: `src/dispatch/profile.ts`
- Test: `test/dispatch/profile.test.ts`

**Interfaces:**
- Produces: `ProfileSchema` gains `schemaVersion: number` (default 1) and `runtimeContext: RuntimeContext`. New exported `RuntimeContextSchema` (zod) and `type RuntimeContext = z.infer<typeof RuntimeContextSchema>`. Section shapes: `topology.{type,detail}`, `data.{presence,detail,migrationTool?}`, `caching|observability|configSecrets|documentation.{presence,detail}`, `releasePackaging.{mechanism,detail}`. `presence ∈ {present,absent,unknown}` (default `unknown`).

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/profile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ProfileSchema, parseProfile } from "../../src/dispatch/profile.ts";

describe("runtimeContext", () => {
  test("a legacy profile (no runtimeContext) validates as all-unknown", () => {
    const p = parseProfile({ slug: "demo", targetRepo: "/tmp/demo" });
    expect(p.schemaVersion).toBe(1);
    expect(p.runtimeContext.topology.type).toBe("unknown");
    expect(p.runtimeContext.data.presence).toBe("unknown");
    expect(p.runtimeContext.documentation.presence).toBe("unknown");
    expect(p.runtimeContext.releasePackaging.mechanism).toBe("unknown");
    expect(p.runtimeContext.data.migrationTool).toBeUndefined();
  });

  test("a populated v1 runtimeContext round-trips", () => {
    const p = parseProfile({
      slug: "demo",
      targetRepo: "/tmp/demo",
      runtimeContext: {
        topology: { type: "web-service", detail: "node api" },
        data: { presence: "present", detail: "postgres", migrationTool: "prisma" },
        documentation: { presence: "present", detail: "docs/" },
      },
    });
    expect(p.runtimeContext.topology.type).toBe("web-service");
    expect(p.runtimeContext.data.migrationTool).toBe("prisma");
    expect(p.runtimeContext.documentation.presence).toBe("present");
    // unspecified sections still default to unknown
    expect(p.runtimeContext.caching.presence).toBe("unknown");
  });

  test("rejects an invalid presence value", () => {
    expect(() =>
      ProfileSchema.parse({
        slug: "d",
        targetRepo: "/t",
        runtimeContext: { data: { presence: "maybe" } },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/profile.test.ts`
Expected: FAIL — `runtimeContext` is undefined / `schemaVersion` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/dispatch/profile.ts`, add the sub-schemas above the existing `ProfileSchema` and extend it:

```ts
export const TriStateSchema = z
  .object({
    presence: z.enum(["present", "absent", "unknown"]).default("unknown"),
    detail: z.string().default(""),
  })
  .default({});

export const DataStateSchema = z
  .object({
    presence: z.enum(["present", "absent", "unknown"]).default("unknown"),
    detail: z.string().default(""),
    migrationTool: z.string().optional(), // free-text (DS-5): no enum
  })
  .default({});

export const RuntimeContextSchema = z
  .object({
    topology: z
      .object({
        type: z
          .enum([
            "web-service", "web-n-tier", "desktop", "mobile-ios",
            "mobile-android", "cli", "library", "hybrid", "unknown",
          ])
          .default("unknown"),
        detail: z.string().default(""),
      })
      .default({}),
    data: DataStateSchema,
    caching: TriStateSchema,
    observability: TriStateSchema,
    configSecrets: TriStateSchema,
    documentation: TriStateSchema,
    releasePackaging: z
      .object({
        mechanism: z
          .enum([
            "semantic-release", "app-store", "installer",
            "signed-binary", "none", "unknown",
          ])
          .default("unknown"),
        detail: z.string().default(""),
      })
      .default({}),
  })
  .default({});

export type RuntimeContext = z.infer<typeof RuntimeContextSchema>;
```

Then extend `ProfileSchema` (add the two fields; keep the rest unchanged):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/profile.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Run the full suite to confirm no back-compat break**

Run: `bun test`
Expected: PASS — existing consumers (prompt-vars, verify, probe) are unaffected because every new field defaults.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/profile.ts test/dispatch/profile.test.ts
git commit -m "feat(profile): add schemaVersion + runtimeContext (CDOT) block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Deterministic runtime-context probe

**Files:**
- Create: `src/setup/detect-runtime.ts`
- Modify: `src/setup/probe.ts:34-40` (the `parseProfile({...})` object)
- Test: `test/setup/detect-runtime.test.ts`

**Interfaces:**
- Consumes: `RuntimeContext` type from `src/dispatch/profile.ts`.
- Produces: `detectRuntimeContext(repoDir: string): RuntimeContext`. Sets each section's `presence` from hard signals; `present` with a terse evidence `detail` when found, else `unknown` with empty detail. Never reads secret values (only `.env.example` *existence*). `probeProfile` now includes `runtimeContext: detectRuntimeContext(targetRepo)`.

- [ ] **Step 1: Write the failing test**

Create `test/setup/detect-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntimeContext } from "../../src/setup/detect-runtime.ts";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-rt-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("detects data via prisma schema + sets migrationTool", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ dependencies: { "@prisma/client": "5" } }),
    "prisma/schema.prisma": "datasource db {}",
  });
  const rc = detectRuntimeContext(dir);
  expect(rc.data.presence).toBe("present");
  expect(rc.data.migrationTool).toBe("prisma");
  expect(rc.data.detail).toContain("prisma");
});

test("detects caching + observability from deps", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ dependencies: { ioredis: "5", pino: "9" } }),
  });
  const rc = detectRuntimeContext(dir);
  expect(rc.caching.presence).toBe("present");
  expect(rc.observability.presence).toBe("present");
});

test("detects documentation from docs dir + changelog", () => {
  const dir = fixture({ "docs/x.md": "x", "CHANGELOG.md": "log" });
  const rc = detectRuntimeContext(dir);
  expect(rc.documentation.presence).toBe("present");
});

test("a bare repo yields all-unknown (never guesses absent)", () => {
  const dir = fixture({ "readme.txt": "hi" });
  const rc = detectRuntimeContext(dir);
  expect(rc.data.presence).toBe("unknown");
  expect(rc.caching.presence).toBe("unknown");
  expect(rc.documentation.presence).toBe("unknown");
  expect(rc.topology.type).toBe("unknown");
});

test("topology = desktop when tauri config present", () => {
  const dir = fixture({
    "package.json": "{}",
    "src-tauri/tauri.conf.json": "{}",
  });
  expect(detectRuntimeContext(dir).topology.type).toBe("desktop");
  expect(detectRuntimeContext(dir).releasePackaging.mechanism).toBe("installer");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/detect-runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/setup/detect-runtime.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeContext } from "../dispatch/profile.ts";

function readPkgDeps(repoDir: string): Record<string, string> {
  const p = join(repoDir, "package.json");
  if (!existsSync(p)) return {};
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

const has = (deps: Record<string, string>, names: string[]): string[] =>
  names.filter((n) => n in deps);
const fileExists = (repoDir: string, rel: string): boolean => existsSync(join(repoDir, rel));

/** present+detail when a hard signal is found, else unknown (never guesses absent). */
function flag(present: boolean, detail: string): { presence: "present" | "unknown"; detail: string } {
  return present ? { presence: "present", detail } : { presence: "unknown", detail: "" };
}

export function detectRuntimeContext(repoDir: string): RuntimeContext {
  const deps = readPkgDeps(repoDir);
  const hasPkg = fileExists(repoDir, "package.json");
  const hasTauri =
    fileExists(repoDir, "src-tauri/tauri.conf.json") || fileExists(repoDir, "tauri.conf.json");
  const hasCargo = fileExists(repoDir, "Cargo.toml");

  // data
  const orm = has(deps, [
    "prisma", "@prisma/client", "drizzle-orm", "typeorm", "sequelize",
    "knex", "better-sqlite3", "pg", "mysql2",
  ]);
  const hasPrisma = fileExists(repoDir, "prisma/schema.prisma");
  const hasMigrations =
    fileExists(repoDir, "migrations") ||
    fileExists(repoDir, "prisma/migrations") ||
    fileExists(repoDir, "db/migrations");
  const hasAlembic = fileExists(repoDir, "alembic.ini");
  const dataPresent = orm.length > 0 || hasPrisma || hasMigrations || hasAlembic;
  const migrationTool = hasPrisma
    ? "prisma"
    : hasAlembic
      ? "alembic"
      : orm.includes("drizzle-orm")
        ? "drizzle"
        : orm.includes("knex")
          ? "knex"
          : undefined;
  const dataDetail = [
    ...orm,
    hasPrisma ? "prisma/schema.prisma" : "",
    hasMigrations ? "migrations dir" : "",
    hasAlembic ? "alembic.ini" : "",
  ]
    .filter(Boolean)
    .join(", ");

  // caching / observability / config / docs / release
  const cache = has(deps, ["redis", "ioredis", "memcached", "node-cache", "lru-cache"]);
  const obs = has(deps, [
    "pino", "winston", "bunyan", "@opentelemetry/api",
    "@sentry/node", "@sentry/browser", "prom-client", "dd-trace",
  ]);
  const cfg = has(deps, ["dotenv", "convict", "@launchdarkly/node-server-sdk", "unleash-client"]);
  const hasEnvExample = fileExists(repoDir, ".env.example");
  const docDeps = has(deps, ["typedoc", "@docusaurus/core"]);
  const hasDocsDir = fileExists(repoDir, "docs");
  const hasReadme = fileExists(repoDir, "README.md");
  const hasChangelog = fileExists(repoDir, "CHANGELOG.md");
  const hasMkdocs = fileExists(repoDir, "mkdocs.yml");
  const docPresent = hasDocsDir || hasMkdocs || hasChangelog || docDeps.length > 0;
  const hasSemRelease =
    "semantic-release" in deps ||
    fileExists(repoDir, ".releaserc") ||
    fileExists(repoDir, ".releaserc.json");

  const topologyType: RuntimeContext["topology"]["type"] = hasTauri
    ? "desktop"
    : hasPkg
      ? "web-service"
      : hasCargo
        ? "cli"
        : "unknown";
  const releaseMechanism: RuntimeContext["releasePackaging"]["mechanism"] = hasSemRelease
    ? "semantic-release"
    : hasTauri
      ? "installer"
      : "unknown";

  return {
    topology: { type: topologyType, detail: hasPkg ? "node package" : hasCargo ? "cargo crate" : "" },
    data: {
      ...flag(dataPresent, dataDetail),
      ...(migrationTool ? { migrationTool } : {}),
    },
    caching: flag(cache.length > 0, cache.join(", ")),
    observability: flag(obs.length > 0, obs.join(", ")),
    configSecrets: flag(
      cfg.length > 0 || hasEnvExample,
      [...cfg, hasEnvExample ? ".env.example" : ""].filter(Boolean).join(", "),
    ),
    documentation: flag(
      docPresent,
      [
        hasDocsDir ? "docs/" : "",
        hasReadme ? "README.md" : "",
        hasChangelog ? "CHANGELOG.md" : "",
        hasMkdocs ? "mkdocs.yml" : "",
        ...docDeps,
      ]
        .filter(Boolean)
        .join(", "),
    ),
    releasePackaging: {
      mechanism: releaseMechanism,
      detail: hasSemRelease ? "semantic-release" : hasTauri ? "tauri bundle" : "",
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/setup/detect-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `probeProfile`**

In `src/setup/probe.ts`, import and add the field:

```ts
import { detectChecksSystem, detectCommands } from "./detect.ts";
import { detectRuntimeContext } from "./detect-runtime.ts";
```

```ts
  return parseProfile({
    slug: overrides?.slug ?? deriveSlug(targetRepo),
    targetRepo,
    defaultBranch: detectDefaultBranch(targetRepo),
    checksSystem: overrides?.checksSystem ?? detectChecksSystem(targetRepo),
    commands: detectCommands(targetRepo),
    runtimeContext: detectRuntimeContext(targetRepo),
  });
```

- [ ] **Step 6: Run probe + full suite**

Run: `bun test test/setup/`
Expected: PASS (existing `probe.test.ts` still green — new field is additive).

Run: `bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/setup/detect-runtime.ts src/setup/probe.ts test/setup/detect-runtime.test.ts
git commit -m "feat(setup): deterministic runtime-context probe (flags + terse detail)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Bubble up `unknown` sections at setup

**Files:**
- Modify: `src/cli/setup.ts` (`runSetup` return + `setupCommand.run` output)
- Test: `test/cli/setup.test.ts`

**Interfaces:**
- Consumes: `Profile.runtimeContext` from Task 1.
- Produces: `unknownRuntimeSections(profile: Profile): string[]` (exported) — section names whose flag is `unknown`. `runSetup` return type gains `needsInput: string[]`. The citty command prints a NEEDS-INPUT block listing them. Non-interactive (CI-safe): it reports, it does not block.

- [ ] **Step 1: Write the failing test**

Add to `test/cli/setup.test.ts`:

```ts
import { unknownRuntimeSections } from "../../src/cli/setup.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

test("unknownRuntimeSections lists only the unknown flags", () => {
  const p = parseProfile({
    slug: "d",
    targetRepo: "/t",
    runtimeContext: {
      topology: { type: "web-service" },
      data: { presence: "present" },
      caching: { presence: "unknown" },
      observability: { presence: "unknown" },
      documentation: { presence: "present" },
    },
  });
  const u = unknownRuntimeSections(p);
  expect(u).toContain("caching");
  expect(u).toContain("observability");
  expect(u).toContain("configSecrets"); // defaulted unknown
  expect(u).not.toContain("data");
  expect(u).not.toContain("topology");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/setup.test.ts`
Expected: FAIL — `unknownRuntimeSections` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/setup.ts`, add the helper and thread it through:

```ts
/** Runtime-context sections the probe couldn't determine — the operator should fill these in. */
export function unknownRuntimeSections(profile: Profile): string[] {
  const rc = profile.runtimeContext;
  const out: string[] = [];
  if (rc.topology.type === "unknown") out.push("topology");
  for (const name of ["data", "caching", "observability", "configSecrets", "documentation"] as const) {
    if (rc[name].presence === "unknown") out.push(name);
  }
  if (rc.releasePackaging.mechanism === "unknown") out.push("releasePackaging");
  return out;
}
```

Change `runSetup`'s return type and body to include it:

```ts
export function runSetup(args: {
  repo: string; out?: string; checks?: string; slug?: string; force?: boolean;
}): { outPath: string; profile: Profile; needsInput: string[] } {
  // ... unchanged probe + write ...
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
}
```

In `setupCommand.run`, after the existing `console.log`s, print the bubble-up:

```ts
    const { outPath, profile, needsInput } = runSetup({ /* unchanged args */ });
    console.log(`setup: wrote ${outPath}`);
    if (needsInput.length > 0) {
      console.log(
        `setup: NEEDS INPUT — the probe could not determine these runtime-context sections.\n` +
          `       Edit ${outPath} and set presence/detail (or re-run after adding tooling):\n` +
          needsInput.map((s) => `         - ${s}`).join("\n"),
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/cli/setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts test/cli/setup.test.ts
git commit -m "feat(setup): bubble up unknown runtime-context sections to the operator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Merge-preserving re-probe

**Files:**
- Create: `src/setup/merge.ts`
- Modify: `src/cli/setup.ts` (`runSetup` existing-profile branch; add `--reprobe` arg)
- Test: `test/setup/merge.test.ts`, `test/cli/setup.test.ts`

**Interfaces:**
- Consumes: `Profile`, `loadProfile` from `src/dispatch/profile.ts`.
- Produces: `mergeRuntimeContext(existing: RuntimeContext, probed: RuntimeContext): RuntimeContext` — per section, a confident probe (`present` / non-`unknown` type/mechanism) wins; otherwise an operator-resolved existing value survives a `probed` `unknown`. `runSetup` no longer errors on an existing profile: it merges by default; `--reprobe` (or `--force`) regenerates clean.

- [ ] **Step 1: Write the failing test**

Create `test/setup/merge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mergeRuntimeContext } from "../../src/setup/merge.ts";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";

const rc = (o: unknown) => RuntimeContextSchema.parse(o);

test("operator-resolved value survives an unknown re-probe", () => {
  const existing = rc({ caching: { presence: "present", detail: "redis (operator)" } });
  const probed = rc({ caching: { presence: "unknown", detail: "" } });
  const merged = mergeRuntimeContext(existing, probed);
  expect(merged.caching.presence).toBe("present");
  expect(merged.caching.detail).toBe("redis (operator)");
});

test("a confident probe overwrites a stale existing value", () => {
  const existing = rc({ data: { presence: "absent" } });
  const probed = rc({ data: { presence: "present", detail: "prisma", migrationTool: "prisma" } });
  const merged = mergeRuntimeContext(existing, probed);
  expect(merged.data.presence).toBe("present");
  expect(merged.data.migrationTool).toBe("prisma");
});

test("topology/release: a non-unknown probe wins, else existing survives", () => {
  const existing = rc({ topology: { type: "desktop" }, releasePackaging: { mechanism: "app-store" } });
  const probed = rc({ topology: { type: "unknown" }, releasePackaging: { mechanism: "semantic-release" } });
  const merged = mergeRuntimeContext(existing, probed);
  expect(merged.topology.type).toBe("desktop"); // probe unknown → keep operator
  expect(merged.releasePackaging.mechanism).toBe("semantic-release"); // probe confident → win
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/setup/merge.ts`:

```ts
import type { RuntimeContext } from "../dispatch/profile.ts";

type Tri = RuntimeContext["data"];

/** present probe wins; otherwise an operator-resolved (non-unknown) existing value survives. */
function mergeTri<T extends { presence: "present" | "absent" | "unknown" }>(existing: T, probed: T): T {
  if (probed.presence === "present") return probed;
  if (existing.presence !== "unknown") return existing;
  return probed;
}

export function mergeRuntimeContext(
  existing: RuntimeContext,
  probed: RuntimeContext,
): RuntimeContext {
  return {
    topology:
      probed.topology.type !== "unknown" || existing.topology.type === "unknown"
        ? probed.topology
        : existing.topology,
    data: mergeTri(existing.data as Tri, probed.data as Tri) as RuntimeContext["data"],
    caching: mergeTri(existing.caching, probed.caching),
    observability: mergeTri(existing.observability, probed.observability),
    configSecrets: mergeTri(existing.configSecrets, probed.configSecrets),
    documentation: mergeTri(existing.documentation, probed.documentation),
    releasePackaging:
      probed.releasePackaging.mechanism !== "unknown" ||
      existing.releasePackaging.mechanism === "unknown"
        ? probed.releasePackaging
        : existing.releasePackaging,
  };
}
```

- [ ] **Step 4: Run merge test to verify it passes**

Run: `bun test test/setup/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Make `runSetup` merge instead of error**

In `src/cli/setup.ts`: import `loadProfile` and `mergeRuntimeContext`, add a `reprobe?: boolean` arg, and replace the existing-profile error branch:

```ts
import { type Profile, loadProfile } from "../dispatch/profile.ts";
import { mergeRuntimeContext } from "../setup/merge.ts";
```

Replace lines around the `if (existsSync(outPath) && !args.force)` guard with:

```ts
  const clean = args.force === true || args.reprobe === true;
  let profile = probeProfile(repoDir, {
    slug: args.slug,
    checksSystem: args.checks as "github" | "external" | "none" | undefined,
  });
  if (existsSync(outPath) && !clean) {
    // Idempotent re-probe: enrich without clobbering operator-resolved runtime context.
    const existing = loadProfile(outPath);
    profile = { ...profile, runtimeContext: mergeRuntimeContext(existing.runtimeContext, profile.runtimeContext) };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`);
  return { outPath, profile, needsInput: unknownRuntimeSections(profile) };
```

Add the `--reprobe` arg to `setupCommand.args`:

```ts
    reprobe: { type: "boolean", description: "Re-probe from scratch, discarding operator-resolved runtime context" },
```

and pass `reprobe: args.reprobe` in the `run` handler's `runSetup({...})` call. Update `runSetup`'s arg type to include `reprobe?: boolean`.

- [ ] **Step 6: Write the re-probe integration test**

Add to `test/cli/setup.test.ts`:

```ts
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "../../src/cli/setup.ts";

test("re-running setup preserves an operator-resolved section", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");

  runSetup({ repo, out }); // first probe → caching unknown
  // operator fills caching by hand:
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));

  const { profile } = runSetup({ repo, out }); // re-run merges
  expect(profile.runtimeContext.caching.presence).toBe("present");
  expect(profile.runtimeContext.caching.detail).toBe("redis (operator)");
});

test("--reprobe discards operator edits", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  runSetup({ repo, out });
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));
  const { profile } = runSetup({ repo, out, reprobe: true });
  expect(profile.runtimeContext.caching.presence).toBe("unknown");
});
```

Note: confirm the existing `setup.test.ts` "profile already exists → throws without --force" test is updated/removed, since re-run now merges instead of throwing.

- [ ] **Step 7: Run tests**

Run: `bun test test/setup/merge.test.ts test/cli/setup.test.ts`
Expected: PASS. Then `bun test` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/setup/merge.ts src/cli/setup.ts test/setup/merge.test.ts test/cli/setup.test.ts
git commit -m "feat(setup): merge-preserving re-probe (--reprobe for clean regen)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `cdotImpact` schema + the profile-consistency gate

**Files:**
- Modify: `src/dispatch/extract-schema.ts`
- Test: `test/dispatch/extract-schema.test.ts`

**Interfaces:**
- Consumes: `Profile` from `src/dispatch/profile.ts`; `ExtractedWorkUnit` (existing).
- Produces: `ExtractOutputSchema` gains `cdotImpact: CdotImpactSchema` (all fields default, so absent → applies:false/empty). New exports: `isMigrationKind(kind: string): boolean` and `validateCdotImpact(output: ExtractOutput, profile: Profile): string[]` (returns human-readable errors; empty = pass). Coverage rule: a section flagged `present`|`unknown` must have non-empty `analysis`. Migration rule: `cdotImpact.data.schemaChange === true` ⇒ a migration-kind unit exists and precedes all domain units (lower `seq`).

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/extract-schema.test.ts`:

```ts
import { ExtractOutputSchema, validateCdotImpact, isMigrationKind } from "../../src/dispatch/extract-schema.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

const baseUnits = [
  { seq: 1, kind: "backend", title: "t", description: "d", behavioral: false,
    test_plan: null, files_to_touch: [], verify_check_types: [], depends_on: [] },
];

function out(o: unknown) {
  return ExtractOutputSchema.parse({ units: baseUnits, ...(o as object) });
}

const profileWith = (rc: unknown) =>
  parseProfile({ slug: "d", targetRepo: "/t", runtimeContext: rc });

test("isMigrationKind recognizes data/migration kinds", () => {
  expect(isMigrationKind("migration")).toBe(true);
  expect(isMigrationKind("Data")).toBe(true);
  expect(isMigrationKind("frontend")).toBe(false);
});

test("coverage: a flagged section with empty analysis fails", () => {
  const profile = profileWith({ caching: { presence: "present" } });
  const errors = validateCdotImpact(out({ cdotImpact: { caching: { applies: false, analysis: "" } } }), profile);
  expect(errors.some((e) => e.includes("caching"))).toBe(true);
});

test("coverage: an absent section is not forced", () => {
  const profile = profileWith({ caching: { presence: "absent" } });
  expect(validateCdotImpact(out({}), profile)).toEqual([]);
});

test("coverage: unknown is must-address (headless safety net)", () => {
  const profile = profileWith({ data: { presence: "unknown" } });
  const errors = validateCdotImpact(out({}), profile);
  expect(errors.some((e) => e.includes("data"))).toBe(true);
});

test("migration: schemaChange without a migration unit fails", () => {
  const profile = profileWith({ data: { presence: "present" } });
  const errors = validateCdotImpact(
    out({ cdotImpact: { data: { applies: true, analysis: "adds column", schemaChange: true } } }),
    profile,
  );
  expect(errors.some((e) => e.includes("migration"))).toBe(true);
});

test("migration: a migration unit ordered first passes", () => {
  const profile = profileWith({ data: { presence: "present" } });
  const units = [
    { seq: 1, kind: "migration", title: "m", description: "d", behavioral: false,
      test_plan: null, files_to_touch: [], verify_check_types: [], depends_on: [] },
    { seq: 2, kind: "backend", title: "b", description: "d", behavioral: true,
      test_plan: "t", files_to_touch: [], verify_check_types: ["test"], depends_on: [1] },
  ];
  const o = ExtractOutputSchema.parse({
    units,
    cdotImpact: { data: { applies: true, analysis: "adds column", schemaChange: true } },
  });
  expect(validateCdotImpact(o, profile)).toEqual([]);
});

test("migration: a migration unit ordered AFTER a domain unit fails", () => {
  const profile = profileWith({ data: { presence: "present" } });
  const units = [
    { seq: 1, kind: "backend", title: "b", description: "d", behavioral: true,
      test_plan: "t", files_to_touch: [], verify_check_types: ["test"], depends_on: [] },
    { seq: 2, kind: "migration", title: "m", description: "d", behavioral: false,
      test_plan: null, files_to_touch: [], verify_check_types: [], depends_on: [] },
  ];
  const o = ExtractOutputSchema.parse({
    units,
    cdotImpact: { data: { applies: true, analysis: "x", schemaChange: true } },
  });
  expect(validateCdotImpact(o, profile).some((e) => e.includes("ordered before"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/extract-schema.test.ts`
Expected: FAIL — `validateCdotImpact` / `isMigrationKind` / `cdotImpact` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/dispatch/extract-schema.ts`, add the import and schemas:

```ts
import type { Profile } from "./profile.ts";

const ImpactSchema = z
  .object({ applies: z.boolean().default(false), analysis: z.string().default("") })
  .default({});

const DataImpactSchema = z
  .object({
    applies: z.boolean().default(false),
    analysis: z.string().default(""),
    schemaChange: z.boolean().default(false),
  })
  .default({});

export const CdotImpactSchema = z
  .object({
    data: DataImpactSchema,
    caching: ImpactSchema,
    observability: ImpactSchema,
    configSecrets: ImpactSchema,
    documentation: ImpactSchema,
  })
  .default({});
```

Extend `ExtractOutputSchema`:

```ts
export const ExtractOutputSchema = z.object({
  units: z.array(ExtractedWorkUnitSchema),
  cdotImpact: CdotImpactSchema,
});
```

Add the gate (after `validateExtraction`):

```ts
const MIGRATION_KINDS = new Set(["migration", "data", "db", "schema"]);

/** A work unit whose kind denotes a schema/data migration. Kind is open text (DS-5); this is a
 *  recognizer, not an enum. */
export function isMigrationKind(kind: string): boolean {
  return MIGRATION_KINDS.has(kind.trim().toLowerCase());
}

/** Profile-consistency gate (S1b postcondition, sibling to validateExtraction). Enforces only
 *  state-computable facts: flagged-section coverage + migration-unit ordering. Never grades
 *  analysis quality. Returns human-readable errors; empty array = pass. Never throws. */
export function validateCdotImpact(output: ExtractOutput, profile: Profile): string[] {
  const errors: string[] = [];
  const rc = profile.runtimeContext;
  const ci = output.cdotImpact;

  // Coverage: present|unknown ⇒ must be addressed (non-empty analysis). absent ⇒ not forced.
  const sections: Array<[string, "present" | "absent" | "unknown", { analysis: string }]> = [
    ["data", rc.data.presence, ci.data],
    ["caching", rc.caching.presence, ci.caching],
    ["observability", rc.observability.presence, ci.observability],
    ["configSecrets", rc.configSecrets.presence, ci.configSecrets],
    ["documentation", rc.documentation.presence, ci.documentation],
  ];
  for (const [name, presence, impact] of sections) {
    if ((presence === "present" || presence === "unknown") && impact.analysis.trim() === "") {
      errors.push(
        `cdotImpact.${name} must be addressed (profile flags it '${presence}') but analysis is empty`,
      );
    }
  }

  // Migration ordering: schemaChange ⇒ a migration unit exists and precedes all domain units.
  if (ci.data.schemaChange) {
    const migrationSeqs = output.units.filter((u) => isMigrationKind(u.kind)).map((u) => u.seq);
    if (migrationSeqs.length === 0) {
      errors.push(
        "cdotImpact.data.schemaChange is true but no migration work unit (kind: migration/data/db/schema) exists",
      );
    } else {
      const domainSeqs = output.units.filter((u) => !isMigrationKind(u.kind)).map((u) => u.seq);
      if (domainSeqs.length > 0 && Math.min(...migrationSeqs) > Math.min(...domainSeqs)) {
        errors.push("migration work unit must be ordered before domain-logic units (lower seq)");
      }
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/extract-schema.test.ts`
Expected: PASS (all cases). Confirm the existing `validateExtraction` tests are still green (the `units` shape is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/extract-schema.ts test/dispatch/extract-schema.test.ts
git commit -m "feat(design): cdotImpact schema + profile-consistency gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire the gate + `needs_docs` into design:extract; thread runtime vars into prompts

**Files:**
- Modify: `src/dispatch/prompt-vars.ts` (add `runtimeVars`; spread into `designVars` + `extractVars`)
- Modify: `src/dispatch/handlers.ts:160-179` (call gate; set `needs_docs`)
- Modify: `prompts/design-extract.md` (request `cdotImpact`; surface flags)
- Modify: `prompts/design.md` (instruct CDOT impact analysis using the same vars)
- Test: `test/dispatch/prompt-vars.test.ts`, `test/dispatch/design-extract.test.ts`

**Interfaces:**
- Consumes: `validateCdotImpact` (Task 5); `setNeedsDocs` from `src/db/repos/ticket.ts:92`; `RuntimeContext` flags from the profile.
- Produces: `designVars` and `extractVars` include `runtime_*` keys. `design:extract` handler throws `design:extract CDOT gate failed: …` when `validateCdotImpact` returns errors (mirrors the existing completeness-gate throw → re-dispatch), and calls `setNeedsDocs(ctx.db, ctx.ticket.id, 1)` when `cdotImpact.documentation.applies`.

- [ ] **Step 1: Write the failing test (prompt vars)**

Add to `test/dispatch/prompt-vars.test.ts`:

```ts
import { extractVars, designVars } from "../../src/dispatch/prompt-vars.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

test("extractVars surfaces runtime-context flags + detail", () => {
  const profile = parseProfile({
    slug: "d", targetRepo: "/t",
    runtimeContext: { data: { presence: "present", detail: "postgres/prisma", migrationTool: "prisma" } },
  });
  const v = extractVars({ ident: "ENG-1", title: "t" }, profile);
  expect(v.runtime_data_presence).toBe("present");
  expect(v.runtime_data_detail).toBe("postgres/prisma");
  expect(v.runtime_data_migration_tool).toBe("prisma");
  expect(v.runtime_caching_presence).toBe("unknown");
});

test("designVars also carries runtime vars", () => {
  const profile = parseProfile({ slug: "d", targetRepo: "/t" });
  const v = designVars({ ident: "ENG-1", title: "t", description: "" }, profile);
  expect(v.runtime_documentation_presence).toBe("unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: FAIL — `runtime_*` keys undefined.

- [ ] **Step 3: Implement `runtimeVars` and spread it**

In `src/dispatch/prompt-vars.ts`, add:

```ts
function runtimeVars(profile: Profile): Record<string, string> {
  const rc = profile.runtimeContext;
  return {
    runtime_topology: rc.topology.type,
    runtime_topology_detail: rc.topology.detail,
    runtime_data_presence: rc.data.presence,
    runtime_data_detail: rc.data.detail,
    runtime_data_migration_tool: rc.data.migrationTool ?? "",
    runtime_caching_presence: rc.caching.presence,
    runtime_caching_detail: rc.caching.detail,
    runtime_observability_presence: rc.observability.presence,
    runtime_observability_detail: rc.observability.detail,
    runtime_config_secrets_presence: rc.configSecrets.presence,
    runtime_config_secrets_detail: rc.configSecrets.detail,
    runtime_documentation_presence: rc.documentation.presence,
    runtime_documentation_detail: rc.documentation.detail,
    runtime_release_mechanism: rc.releasePackaging.mechanism,
    runtime_release_detail: rc.releasePackaging.detail,
  };
}
```

Spread `...runtimeVars(profile)` into the returned object of both `extractVars` and `designVars` (add after `...profile.promptVars` in each).

- [ ] **Step 4: Run prompt-vars test to verify it passes**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: PASS.

- [ ] **Step 5a: Make the existing test harness's profile gate-inert**

The gate will force every section flagged `present`|`unknown`. The current `registryFor` builds an all-`unknown` profile (`parseProfile` with no `runtimeContext`), which would force all five CDOT sections and break the three existing extract tests (their sidecars carry no `cdotImpact`). Update `registryFor` in `test/dispatch/design-extract.test.ts` to default to an all-`absent` runtime context (a "probed, found nothing" profile → gate inert), with an override param for the new tests:

```ts
const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};

function registryFor(repo: string, runner: FakeAgentRunner, rc: unknown = ABSENT_RC) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      commands: { test: "bun test" },
      runtimeContext: rc,
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")),
  });
}
```

The three existing tests call `registryFor(repo, runner)` unchanged and stay green (all sections `absent` → gate inert).

- [ ] **Step 5b: Write the two failing gate/needs_docs tests**

Add to `test/dispatch/design-extract.test.ts`:

```ts
test("design:extract fails the step when a flagged CDOT section is unaddressed", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          { seq: 1, kind: "backend", title: "x", description: "d", behavioral: false,
            test_plan: null, files_to_touch: [], verify_check_types: [], depends_on: [] },
        ],
        cdotImpact: { data: { applies: false, analysis: "" } }, // data flagged present, but empty
      }),
    ),
    stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
  const rc = { ...ABSENT_RC, data: { presence: "present", detail: "pg" } };
  await advanceOneStep(db, ticketId, registryFor(repo, runner, rc));
  const step = getByKey(db, ticketId, "design:extract");
  const units = listByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0); // gate runs before insert → nothing persisted
});

test("design:extract sets needs_docs when documentation impact applies", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          { seq: 1, kind: "backend", title: "x", description: "d", behavioral: true,
            test_plan: "t", files_to_touch: ["src/a.ts"], verify_check_types: ["test"], depends_on: [] },
        ],
        cdotImpact: { documentation: { applies: true, analysis: "update README" } },
      }),
    ),
    stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
  // ABSENT_RC → docs absent → gate inert; applies:true still flips needs_docs.
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const ticket = getTicket(db, ticketId);
  const step = getByKey(db, ticketId, "design:extract");
  db.close();
  expect(step?.status).toBe("succeeded");
  expect(ticket?.needs_docs).toBe(1);
});
```

- [ ] **Step 6: Run handler tests to verify they fail**

Run: `bun test test/dispatch/design-extract.test.ts`
Expected: the two new tests FAIL — gate not wired (step still succeeds with an unaddressed section) and `needs_docs` stays 0. The three existing tests PASS (all-`absent` profile).

- [ ] **Step 7: Wire the gate + needs_docs into the handler**

In `src/dispatch/handlers.ts`: extend the existing import and add `setNeedsDocs`:

```ts
import { ExtractOutputSchema, validateCdotImpact, validateExtraction } from "./extract-schema.ts";
import { setNeedsDocs } from "../db/repos/ticket.ts"; // place with the other repo imports
```

In the `design:extract` handler, immediately after the existing `validateExtraction` block (after line 163), add:

```ts
    const cdotErrors = validateCdotImpact(parsed.value, deps.profile);
    if (cdotErrors.length > 0) {
      throw new Error(`design:extract CDOT gate failed: ${cdotErrors.join("; ")}`);
    }
```

After the `insertWorkUnit` loop (after line 178), before `return`, add:

```ts
    if (parsed.value.cdotImpact.documentation.applies) {
      setNeedsDocs(ctx.db, ctx.ticket.id, 1);
    }
```

- [ ] **Step 8: Run handler test to verify it passes**

Run: `bun test test/dispatch/design-extract.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the prompt templates**

In `prompts/design-extract.md`, after the work-unit field list and before the sidecar block, add a runtime-context section (uses the new vars; the `styre-sidecar` JSON gains a `cdotImpact` object):

```markdown
## Runtime context (from the project profile — treat as ground truth)

- Topology: {{runtime_topology}} — {{runtime_topology_detail}}
- Data/persistence: {{runtime_data_presence}} — {{runtime_data_detail}} (migration tool: {{runtime_data_migration_tool}})
- Caching: {{runtime_caching_presence}} — {{runtime_caching_detail}}
- Observability: {{runtime_observability_presence}} — {{runtime_observability_detail}}
- Config/secrets: {{runtime_config_secrets_presence}} — {{runtime_config_secrets_detail}}
- Documentation: {{runtime_documentation_presence}} — {{runtime_documentation_detail}}

For every section flagged `present` or `unknown`, you MUST fill the matching `cdotImpact` entry
with a non-empty `analysis` (state "N/A — <reason>" if it genuinely does not apply). If your plan
changes the database schema, set `cdotImpact.data.schemaChange: true` AND include a dedicated
migration work unit (kind `migration` or `data`) ordered before the units that use the new schema.
Add a telemetry step to behavioral units and map each external boundary's failure mode to a test.
```

And extend the sidecar JSON template to include `cdotImpact` alongside `units`:

```json
  "cdotImpact": {
    "data": { "applies": false, "analysis": "", "schemaChange": false },
    "caching": { "applies": false, "analysis": "" },
    "observability": { "applies": false, "analysis": "" },
    "configSecrets": { "applies": false, "analysis": "" },
    "documentation": { "applies": false, "analysis": "" }
  }
```

In `prompts/design.md`, add a short instruction (using the same `{{runtime_*}}` vars) telling the design agent to reason about the flagged CDOT concerns in the plan document it writes. (The vars are now available via `designVars`.)

- [ ] **Step 10: Run the full suite**

Run: `bun test`
Expected: PASS. If any existing `design-extract` e2e/golden test asserts the exact sidecar shape, update its fixture to include the defaulted `cdotImpact`.

- [ ] **Step 11: Commit**

```bash
git add src/dispatch/prompt-vars.ts src/dispatch/handlers.ts prompts/design-extract.md prompts/design.md test/dispatch/prompt-vars.test.ts test/dispatch/design-extract.test.ts
git commit -m "feat(design): enforce CDOT gate + set needs_docs; thread runtime vars into prompts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred to a follow-up

**Agent-prose enrichment of the probe (spec D4, second half).** The approved design is a *hybrid* probe: deterministic scan sets the flags (delivered in Task 2) and a setup-time **agent dispatch** writes richer `detail` prose. Today `styre setup` is a pure, creds-free, agent-free code probe; adding an agent dispatch pulls auth + dispatch infrastructure into setup and warrants its own design. The gating-critical half of D4 — the *evidence-grounded flags* — ships in this plan; the prose enrichment is a quality boost on the `detail` strings only and does not block the gate, bubble-up, or re-probe. Defer to a follow-up plan once setup-side dispatch is scoped.

**Prompted invariants → review enforcement (ENG-176).** Telemetry-per-task and failure-mode→test-map remain prompt-level here (Task 6, Step 9). Their enforcement belongs to the review persona ticket, out of scope for this plan.

## Self-review notes

- **Spec coverage:** §4 data model → Task 1; §5 probe (flags) → Task 2, bubble-up → Task 3; §6 cdotImpact + gate → Task 5, wiring + prompts + needs_docs → Task 6; §7 versioning + merge re-probe → Tasks 1 & 4; §8 testing → tests in every task. §5 agent-prose half → explicitly Deferred. Out-of-scope §9 respected (no ENG-169/176/177 work; no `RuntimeConfig`/`schema.sql` changes).
- **Migration-ordering interpretation:** the spec's "domain-logic units must `depends_on` it" is enforced as the state-computable proxy *"a migration unit exists and has a lower `seq` than every domain unit"* — no spurious dependency edges forced; the finer per-consumer dependency is left to the prompt (consistent with the enforced-vs-prompted philosophy).
- **Type consistency:** `presence` union, `RuntimeContext`, `validateCdotImpact(output, profile)`, `isMigrationKind`, `runtimeVars` keys, `unknownRuntimeSections`, `mergeRuntimeContext` are used identically across tasks.
