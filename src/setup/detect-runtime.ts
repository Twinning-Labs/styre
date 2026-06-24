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
function flag(
  present: boolean,
  detail: string,
): { presence: "present" | "unknown"; detail: string } {
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
    "prisma",
    "@prisma/client",
    "drizzle-orm",
    "typeorm",
    "sequelize",
    "knex",
    "better-sqlite3",
    "pg",
    "mysql2",
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
    "pino",
    "winston",
    "bunyan",
    "@opentelemetry/api",
    "@sentry/node",
    "@sentry/browser",
    "prom-client",
    "dd-trace",
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
    topology: {
      type: topologyType,
      detail: hasPkg
        ? "node package"
        : hasTauri
          ? "tauri desktop app"
          : hasCargo
            ? "cargo crate"
            : "",
    },
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
