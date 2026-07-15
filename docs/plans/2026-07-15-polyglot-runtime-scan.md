# Manifest Dependency Lists as Enrichment Context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the setup enrichment LLM the actual dependency identifiers from every manifest in a repo (all 7 supported ecosystems), so it stops false-`absent`ing capabilities on non-Node repos.

**Architecture:** Purely additive. A new `src/setup/runtime-deps/` module parses each manifest for dependency *names only* (no dimension classification), an orchestrator dedupes them per-language, and `enrichRuntimeContext` renders that list into one new prompt variable. `detectRuntimeContext`, the schema, the coverage gate, and the enrichment merge are all untouched.

**Tech Stack:** TypeScript, Bun 1.3.5 (`bun test`, `Bun.TOML.parse`), Zod (unchanged), Biome (`biome check .`).

## Global Constraints

- **Bun ≥ 1.3.5.** Parse ALL TOML with the built-in `Bun.TOML.parse` — never hand-roll TOML regex.
- **Never modify `src/setup/detect-runtime.ts`, `src/dispatch/profile.ts`, `src/dispatch/extract-schema.ts`, or `src/setup/merge.ts`.** This design touches only the new module, `src/setup/enrich.ts`, and `prompts/setup-enrich.md`.
- **Every parser is fail-soft and pure** (`(content: string) => string[]`): any malformed input returns `[]`, never throws. IO lives only in `collect.ts`.
- **Never assert `absent` from parsed deps.** The prompt frames the list as incomplete positive evidence only (absence ≠ missing capability).
- **Lint + format are CI-enforced (Biome).** `biome check .` includes the formatter and exits non-zero on any reformat diff (100-col `lineWidth`). Before every commit run **`bunx biome check --write .`** (auto-formats + fixes) and then **`bun run lint`** to verify clean. The `bun run lint` step in each task assumes the `--write` pass already ran. No non-null assertions (`!`), no `any`, use template literals. Write index accesses defensively (guard `undefined`). Keep code lines ≤ 100 cols.
- **Identifiers are lowercased where the ecosystem is case-insensitive** (npm, PyPI, composer, gems). Go module paths and JVM `group:artifact` coordinates are kept verbatim (case-sensitive).

---

## File Structure

- **Create** `src/setup/runtime-deps/parse.ts` — ten pure parser functions (one per manifest format) + shared `rec`/`pep508Name` helpers. Tasks 1–4.
- **Create** `src/setup/runtime-deps/collect.ts` — `collectManifestDeps(repoDir)` orchestrator + `renderManifestDeps(map)`. Task 5.
- **Create** `test/setup/runtime-deps/parse.test.ts` — parser unit tests. Tasks 1–4.
- **Create** `test/setup/runtime-deps/collect.test.ts` — orchestrator fixture tests. Task 5.
- **Modify** `src/setup/enrich.ts` — compute + inject the dependency list. Task 6.
- **Modify** `prompts/setup-enrich.md` — add the dependency-list section. Task 6.
- **Modify** `test/setup/enrich.test.ts` — assert the list reaches the prompt. Task 6.

Design deviation note (intentional): the design said "reuse `readPkgDeps`". We instead write a fresh `parsePackageJson` in `parse.ts` to honor the Global Constraint of not modifying `detect-runtime.ts` (reusing would require exporting from it). Behavior is identical (keys of `dependencies` + `devDependencies`).

---

### Task 1: TOML parsers — Cargo + pyproject

**Files:**
- Create: `src/setup/runtime-deps/parse.ts`
- Test: `test/setup/runtime-deps/parse.test.ts`

**Interfaces:**
- Produces: `parseCargoToml(content: string): string[]`, `parsePyproject(content: string): string[]`, and the shared helper `rec(v: unknown): Record<string, unknown> | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `test/setup/runtime-deps/parse.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseCargoToml, parsePyproject } from "../../../src/setup/runtime-deps/parse.ts";

test("parseCargoToml: normal, inline-table, sub-table, target, dev deps", () => {
  const toml = [
    "[dependencies]",
    'serde = "1.0"',
    'tokio = { version = "1", features = ["full"] }',
    "[dependencies.diesel]",
    'version = "2"',
    "[build-dependencies]",
    'cc = "1"',
    "[dev-dependencies]",
    'mockall = "0.11"',
    "[target.'cfg(unix)'.dependencies]",
    'nix = "0.27"',
  ].join("\n");
  expect(parseCargoToml(toml).sort()).toEqual(
    ["cc", "diesel", "mockall", "nix", "serde", "tokio"].sort(),
  );
});

test("parseCargoToml: [features] is not mistaken for deps", () => {
  const toml = '[dependencies]\nserde = "1"\n[features]\ndefault = ["serde"]\nextra = []\n';
  expect(parseCargoToml(toml)).toEqual(["serde"]);
});

test("parseCargoToml: malformed → []", () => {
  expect(parseCargoToml("this is not [ valid toml =")).toEqual([]);
});

test("parsePyproject: PEP 621 deps with extras/markers, optional, poetry, groups; python filtered", () => {
  const toml = [
    "[project]",
    'dependencies = ["sqlalchemy[asyncio]>=2.0", "django ; python_version<\'3.9\'"]',
    "[project.optional-dependencies]",
    'dev = ["pytest>=7"]',
    "[tool.poetry.dependencies]",
    'python = "^3.11"',
    'fastapi = "^0.110"',
    "[tool.poetry.group.test.dependencies]",
    'httpx = "*"',
  ].join("\n");
  expect(parsePyproject(toml).sort()).toEqual(
    ["django", "fastapi", "httpx", "pytest", "sqlalchemy"].sort(),
  );
});

test("parsePyproject: malformed → []", () => {
  expect(parsePyproject("[project\nbad")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: FAIL — cannot resolve `../../../src/setup/runtime-deps/parse.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/setup/runtime-deps/parse.ts`:

```ts
/** Narrow an unknown to a plain object (not array). Used to walk parsed TOML/JSON safely. */
export function rec(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** Leading distribution name from a PEP 508 requirement string, lowercased; null if none. */
function pep508Name(spec: string): string | null {
  const m = spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
  return m ? m[0].toLowerCase() : null;
}

function tomlDepKeys(table: unknown): string[] {
  const t = rec(table);
  return t ? Object.keys(t) : [];
}

export function parseCargoToml(content: string): string[] {
  try {
    const t = Bun.TOML.parse(content) as unknown;
    const root = rec(t);
    if (!root) return [];
    const names = new Set<string>();
    for (const k of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      for (const name of tomlDepKeys(root[k])) names.add(name);
    }
    const target = rec(root.target);
    if (target) {
      for (const cfg of Object.values(target)) {
        const c = rec(cfg);
        if (!c) continue;
        for (const k of ["dependencies", "dev-dependencies", "build-dependencies"]) {
          for (const name of tomlDepKeys(c[k])) names.add(name);
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

export function parsePyproject(content: string): string[] {
  try {
    const t = Bun.TOML.parse(content) as unknown;
    const root = rec(t);
    if (!root) return [];
    const names = new Set<string>();

    const project = rec(root.project);
    const projDeps = project?.dependencies;
    if (Array.isArray(projDeps)) {
      for (const s of projDeps) {
        if (typeof s === "string") {
          const n = pep508Name(s);
          if (n) names.add(n);
        }
      }
    }
    const optional = rec(project?.["optional-dependencies"]);
    if (optional) {
      for (const arr of Object.values(optional)) {
        if (Array.isArray(arr)) {
          for (const s of arr) {
            if (typeof s === "string") {
              const n = pep508Name(s);
              if (n) names.add(n);
            }
          }
        }
      }
    }

    const poetry = rec(rec(root.tool)?.poetry);
    for (const name of tomlDepKeys(poetry?.dependencies)) {
      if (name !== "python") names.add(name.toLowerCase());
    }
    const groups = rec(poetry?.group);
    if (groups) {
      for (const g of Object.values(groups)) {
        for (const name of tomlDepKeys(rec(g)?.dependencies)) {
          if (name !== "python") names.add(name.toLowerCase());
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors in the new files.

- [ ] **Step 6: Commit**

```bash
git add src/setup/runtime-deps/parse.ts test/setup/runtime-deps/parse.test.ts
git commit -m "feat(setup): cargo + pyproject dependency-name parsers"
```

---

### Task 2: Line-based parsers — requirements.txt, go.mod, Gemfile

**Files:**
- Modify: `src/setup/runtime-deps/parse.ts`
- Test: `test/setup/runtime-deps/parse.test.ts`

**Interfaces:**
- Consumes: `pep508Name` pattern (local; re-expressed inline — do not export).
- Produces: `parseRequirementsTxt(content: string): string[]`, `parseGoMod(content: string): string[]`, `parseGemfile(content: string): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/setup/runtime-deps/parse.test.ts`:

```ts
import {
  parseGemfile,
  parseGoMod,
  parseRequirementsTxt,
} from "../../../src/setup/runtime-deps/parse.ts";

test("parseRequirementsTxt: directives/URLs skipped; extras/markers/direct-ref/VCS-egg handled", () => {
  const txt = [
    "# comment",
    "-r base.txt",
    "-e .",
    "--hash=sha256:abc",
    "https://example.com/pkg.whl",
    "uvicorn[standard]==0.20  # inline",
    "flask>=2.0 ; python_version<'3.9'",
    "requests",
    "pkg @ https://example.com/pkg.tar.gz",
    "git+https://github.com/psf/requests.git", // no #egg → unnameable, dropped (no junk)
    "-e git+https://github.com/foo/bar.git#egg=bar",
    "git+https://github.com/django/django.git@stable/4.2.x#egg=Django",
  ].join("\n");
  expect(parseRequirementsTxt(txt).sort()).toEqual(
    ["bar", "django", "flask", "pkg", "requests", "uvicorn"].sort(),
  );
});

test("parseGoMod: block + single-line requires, // indirect stripped", () => {
  const mod = [
    "module example.com/app",
    "go 1.22",
    "require github.com/jmoiron/sqlx v1.3.5",
    "require (",
    "\tgorm.io/gorm v1.25.0",
    "\tgo.uber.org/zap v1.26.0 // indirect",
    ")",
  ].join("\n");
  expect(parseGoMod(mod).sort()).toEqual(
    ["github.com/jmoiron/sqlx", "go.uber.org/zap", "gorm.io/gorm"].sort(),
  );
});

test("parseGemfile: gem lines only, comments ignored", () => {
  const gf = [
    "source 'https://rubygems.org'",
    "gem 'rails', '~> 7.0'",
    'gem "pg"',
    "# gem 'commented'",
    "group :test do",
    "  gem 'rspec'",
    "end",
  ].join("\n");
  expect(parseGemfile(gf).sort()).toEqual(["pg", "rails", "rspec"].sort());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: FAIL — `parseRequirementsTxt`/`parseGoMod`/`parseGemfile` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/setup/runtime-deps/parse.ts`:

```ts
export function parseRequirementsTxt(content: string): string[] {
  const names = new Set<string>();
  // A VCS/URL install is only nameable via its #egg=<name> fragment; otherwise skip it
  // (never emit the URL scheme like "git" as a dependency name).
  const addEgg = (line: string): void => {
    const egg = line.match(/[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (egg?.[1]) names.add(egg[1].toLowerCase());
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    // Options/includes (-r/-c/--hash) and editable installs (-e): only -e VCS with #egg names anything.
    if (line.startsWith("-")) {
      addEgg(line);
      continue;
    }
    if (/^(https?:|git\+|hg\+|svn\+|bzr\+|file:)/.test(line)) {
      addEgg(line);
      continue;
    }
    const head = (line.split("@")[0] ?? line).trim();
    const m = head.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
    if (m) names.add(m[0].toLowerCase());
  }
  return [...names];
}

export function parseGoMod(content: string): string[] {
  const names = new Set<string>();
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
      const path = line.split(/\s+/)[0];
      if (path) names.add(path);
    } else if (line.startsWith("require (")) {
      inBlock = true;
    } else if (line.startsWith("require ")) {
      const path = line.slice("require ".length).trim().split(/\s+/)[0];
      if (path) names.add(path);
    }
  }
  return [...names];
}

export function parseGemfile(content: string): string[] {
  const names = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^gem\s+['"]([^'"]+)['"]/);
    if (m?.[1]) names.add(m[1].toLowerCase());
  }
  return [...names];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/setup/runtime-deps/parse.ts test/setup/runtime-deps/parse.test.ts
git commit -m "feat(setup): requirements.txt, go.mod, Gemfile dependency parsers"
```

---

### Task 3: JSON parsers — package.json, composer.json

**Files:**
- Modify: `src/setup/runtime-deps/parse.ts`
- Test: `test/setup/runtime-deps/parse.test.ts`

**Interfaces:**
- Produces: `parsePackageJson(content: string): string[]`, `parseComposerJson(content: string): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/setup/runtime-deps/parse.test.ts`:

```ts
import { parseComposerJson, parsePackageJson } from "../../../src/setup/runtime-deps/parse.ts";

test("parsePackageJson: deps + devDeps, malformed → []", () => {
  const pkg = JSON.stringify({
    dependencies: { prisma: "^5", react: "^18" },
    devDependencies: { vitest: "^1" },
  });
  expect(parsePackageJson(pkg).sort()).toEqual(["prisma", "react", "vitest"].sort());
  expect(parsePackageJson("{not json")).toEqual([]);
});

test("parseComposerJson: require + require-dev, php/ext-* platform reqs filtered", () => {
  const composer = JSON.stringify({
    require: { php: ">=8.1", "ext-json": "*", "doctrine/orm": "^2", "laravel/framework": "^10" },
    "require-dev": { "phpunit/phpunit": "^10" },
  });
  expect(parseComposerJson(composer).sort()).toEqual(
    ["doctrine/orm", "laravel/framework", "phpunit/phpunit"].sort(),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: FAIL — parsers not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/setup/runtime-deps/parse.ts`:

```ts
function jsonDepKeys(content: string, keys: string[]): string[] {
  try {
    const obj = rec(JSON.parse(content));
    if (!obj) return [];
    const names: string[] = [];
    for (const k of keys) {
      const table = rec(obj[k]);
      if (table) names.push(...Object.keys(table));
    }
    return names;
  } catch {
    return [];
  }
}

export function parsePackageJson(content: string): string[] {
  return jsonDepKeys(content, ["dependencies", "devDependencies"]).map((n) => n.toLowerCase());
}

export function parseComposerJson(content: string): string[] {
  return jsonDepKeys(content, ["require", "require-dev"])
    .filter((n) => n !== "php" && !n.startsWith("ext-"))
    .map((n) => n.toLowerCase());
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/setup/runtime-deps/parse.ts test/setup/runtime-deps/parse.test.ts
git commit -m "feat(setup): package.json + composer.json dependency parsers"
```

---

### Task 4: JVM parsers — pom.xml, build.gradle(.kts), libs.versions.toml

**Files:**
- Modify: `src/setup/runtime-deps/parse.ts`
- Test: `test/setup/runtime-deps/parse.test.ts`

**Interfaces:**
- Produces: `parsePomXml(content: string): string[]`, `parseBuildGradle(content: string): string[]`, `parseGradleCatalog(content: string): string[]`. All emit `group:artifact` coordinates (verbatim case).

- [ ] **Step 1: Write the failing tests**

Append to `test/setup/runtime-deps/parse.test.ts`:

```ts
import {
  parseBuildGradle,
  parseGradleCatalog,
  parsePomXml,
} from "../../../src/setup/runtime-deps/parse.ts";

test("parsePomXml: <dependency> only — excludes <plugin> and <parent>", () => {
  const pom = `<project>
    <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent>
    <dependencies>
      <dependency><groupId>org.hibernate</groupId><artifactId>hibernate-core</artifactId></dependency>
      <dependency><groupId>com.zaxxer</groupId><artifactId>HikariCP</artifactId></dependency>
    </dependencies>
    <build><plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId></plugin>
    </plugins></build>
  </project>`;
  expect(parsePomXml(pom).sort()).toEqual(
    ["com.zaxxer:HikariCP", "org.hibernate:hibernate-core"].sort(),
  );
});

test("parseBuildGradle: single/double quotes, kotlin-dsl parens, multiple configs", () => {
  const gradle = [
    'implementation "org.springframework:spring-web:6.0"',
    "api('com.google.guava:guava:32.0')",
    'testImplementation("org.junit.jupiter:junit-jupiter:5.10")',
    'implementation "org.slf4j:slf4j-api"',
  ].join("\n");
  expect(parseBuildGradle(gradle).sort()).toEqual(
    [
      "com.google.guava:guava",
      "org.junit.jupiter:junit-jupiter",
      "org.slf4j:slf4j-api",
      "org.springframework:spring-web",
    ].sort(),
  );
});

test("parseBuildGradle: android build-type/flavor configs + ksp; accessor/project forms ignored", () => {
  const gradle = [
    'debugImplementation "com.squareup.leakcanary:leakcanary-android:2.12"',
    'androidTestImplementation "androidx.test:runner:1.5.2"',
    'ksp "com.google.dagger:dagger-compiler:2.48"',
    "implementation project(':core')", // no string coordinate → ignored
    "implementation(libs.spring.web)", // catalog accessor → ignored (coord comes from catalog)
  ].join("\n");
  expect(parseBuildGradle(gradle).sort()).toEqual(
    [
      "androidx.test:runner",
      "com.google.dagger:dagger-compiler",
      "com.squareup.leakcanary:leakcanary-android",
    ].sort(),
  );
});

test("parseGradleCatalog: module string, group/name table, version-ref forms", () => {
  const toml = [
    "[libraries]",
    'gorm = { module = "io.gorm:gorm", version = "1" }',
    'guava = { group = "com.google.guava", name = "guava", version.ref = "g" }',
    'shorthand = "org.slf4j:slf4j-api:2.0"',
    "[versions]",
    'g = "32.0"',
  ].join("\n");
  expect(parseGradleCatalog(toml).sort()).toEqual(
    ["com.google.guava:guava", "io.gorm:gorm", "org.slf4j:slf4j-api"].sort(),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: FAIL — parsers not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/setup/runtime-deps/parse.ts`:

```ts
export function parsePomXml(content: string): string[] {
  const names = new Set<string>();
  const deps = content.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  for (const d of deps) {
    const g = d.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/)?.[1];
    const a = d.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
    if (g && a) names.add(`${g}:${a}`);
  }
  return [...names];
}

// Matches string-coordinate dependency configs, including Android build-type/flavor variants
// (debugImplementation, androidTestImplementation, releaseApi, …) and ksp/kapt. Map-notation
// (`group: 'g', name: 'a'`) and version-catalog accessors (`libs.x`) are intentionally NOT matched
// here — catalog coordinates are recovered by parseGradleCatalog from gradle/libs.versions.toml.
const GRADLE_CONFIGS =
  "\\w*[Ii]mplementation|\\w*[Aa]pi|\\w*RuntimeOnly|\\w*CompileOnly|annotationProcessor|kapt|ksp|classpath|developmentOnly";

export function parseBuildGradle(content: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(
    `(?:^|[^\\w.])(?:${GRADLE_CONFIGS})\\s*\\(?\\s*['"]([^'":\\s]+):([^'":\\s]+)(?::[^'"]*)?['"]`,
    "g",
  );
  for (const m of content.matchAll(re)) {
    const g = m[1];
    const a = m[2];
    if (g && a) names.add(`${g}:${a}`);
  }
  return [...names];
}

export function parseGradleCatalog(content: string): string[] {
  try {
    const root = rec(Bun.TOML.parse(content) as unknown);
    const libs = rec(root?.libraries);
    if (!libs) return [];
    const names = new Set<string>();
    for (const v of Object.values(libs)) {
      if (typeof v === "string") {
        const [g, a] = v.split(":");
        if (g && a) names.add(`${g}:${a}`);
        continue;
      }
      const o = rec(v);
      if (!o) continue;
      if (typeof o.module === "string") {
        const [g, a] = o.module.split(":");
        if (g && a) names.add(`${g}:${a}`);
      } else if (typeof o.group === "string" && typeof o.name === "string") {
        names.add(`${o.group}:${o.name}`);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/setup/runtime-deps/parse.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/setup/runtime-deps/parse.ts test/setup/runtime-deps/parse.test.ts
git commit -m "feat(setup): pom.xml, build.gradle, and version-catalog parsers"
```

---

### Task 5: Orchestrator — `collectManifestDeps` + `renderManifestDeps`

**Files:**
- Create: `src/setup/runtime-deps/collect.ts`
- Test: `test/setup/runtime-deps/collect.test.ts`

**Interfaces:**
- Consumes: all ten parsers from `./parse.ts`; `findManifests(repoDir, name)` from `../manifests.ts`.
- Produces: `collectManifestDeps(repoDir: string): Record<string, string[]>` (keys are language labels `node|rust|python|go|ruby|php|jvm`, values are sorted+deduped+capped identifier lists) and `renderManifestDeps(map: Record<string, string[]>): string`.

- [ ] **Step 1: Write the failing tests**

Create `test/setup/runtime-deps/collect.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectManifestDeps,
  renderManifestDeps,
} from "../../../src/setup/runtime-deps/collect.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rtdeps-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("collect: polyglot repo → per-language deduped lists", () => {
  const root = fixture({
    "package.json": JSON.stringify({ dependencies: { prisma: "^5" } }),
    "backend/pyproject.toml": '[project]\ndependencies = ["sqlalchemy>=2"]\n',
    "backend/requirements.txt": "sqlalchemy\nfastapi\n",
  });
  const map = collectManifestDeps(root);
  expect(map.node).toEqual(["prisma"]);
  expect(map.python?.sort()).toEqual(["fastapi", "sqlalchemy"]); // deduped across two manifests
});

test("collect: gradle catalog under gradle/ is found and parsed", () => {
  const root = fixture({
    "build.gradle": 'implementation "org.springframework:spring-web:6.0"',
    "gradle/libs.versions.toml": '[libraries]\nhib = { module = "org.hibernate:hibernate-core" }\n',
  });
  expect(collectManifestDeps(root).jvm?.sort()).toEqual(
    ["org.hibernate:hibernate-core", "org.springframework:spring-web"].sort(),
  );
});

test("collect: missing directory → {} (fail-soft, no throw)", () => {
  expect(collectManifestDeps("/nonexistent/repo/path/xyz")).toEqual({});
});

test("collect: repo with no manifests → {}", () => {
  expect(collectManifestDeps(fixture({ "README.md": "hi" }))).toEqual({});
});

test("render: empty map → placeholder; populated → one line per language", () => {
  expect(renderManifestDeps({})).toBe("(no dependency manifests detected)");
  expect(renderManifestDeps({ python: ["fastapi", "sqlalchemy"], node: ["react"] })).toBe(
    "- node: react\n- python: fastapi, sqlalchemy",
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/setup/runtime-deps/collect.test.ts`
Expected: FAIL — cannot resolve `collect.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/setup/runtime-deps/collect.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findManifests } from "../manifests.ts";
import {
  parseBuildGradle,
  parseCargoToml,
  parseComposerJson,
  parseGemfile,
  parseGoMod,
  parseGradleCatalog,
  parsePackageJson,
  parsePomXml,
  parsePyproject,
  parseRequirementsTxt,
} from "./parse.ts";

type Lang = "node" | "rust" | "python" | "go" | "ruby" | "php" | "jvm";

const MANIFESTS: { file: string; lang: Lang; parse: (c: string) => string[] }[] = [
  { file: "package.json", lang: "node", parse: parsePackageJson },
  { file: "Cargo.toml", lang: "rust", parse: parseCargoToml },
  { file: "pyproject.toml", lang: "python", parse: parsePyproject },
  { file: "requirements.txt", lang: "python", parse: parseRequirementsTxt },
  { file: "go.mod", lang: "go", parse: parseGoMod },
  { file: "Gemfile", lang: "ruby", parse: parseGemfile },
  { file: "composer.json", lang: "php", parse: parseComposerJson },
  { file: "pom.xml", lang: "jvm", parse: parsePomXml },
  { file: "build.gradle", lang: "jvm", parse: parseBuildGradle },
  { file: "build.gradle.kts", lang: "jvm", parse: parseBuildGradle },
  { file: "libs.versions.toml", lang: "jvm", parse: parseGradleCatalog },
];

/** Bound the per-language list so a huge monorepo can't bloat the enrichment prompt. */
const CAP_PER_LANG = 100;

/** Parse every supported manifest in the repo (depth ≤ 3, vendored dirs skipped) into a
 *  per-language, deduped, sorted, capped list of dependency identifiers. Fail-soft throughout. */
export function collectManifestDeps(repoDir: string): Record<string, string[]> {
  const acc = new Map<Lang, Set<string>>();
  for (const { file, lang, parse } of MANIFESTS) {
    let paths: string[];
    try {
      paths = findManifests(repoDir, file);
    } catch {
      continue;
    }
    for (const rel of paths) {
      let content: string;
      try {
        content = readFileSync(join(repoDir, rel), "utf8");
      } catch {
        continue;
      }
      const names = parse(content);
      if (names.length === 0) continue;
      let set = acc.get(lang);
      if (!set) {
        set = new Set<string>();
        acc.set(lang, set);
      }
      for (const n of names) set.add(n);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [lang, set] of acc) out[lang] = [...set].sort().slice(0, CAP_PER_LANG);
  return out;
}

/** Render the per-language map as prompt-ready markdown, or a placeholder when empty. */
export function renderManifestDeps(map: Record<string, string[]>): string {
  const langs = Object.keys(map).sort();
  if (langs.length === 0) return "(no dependency manifests detected)";
  return langs.map((l) => `- ${l}: ${(map[l] ?? []).join(", ")}`).join("\n");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/setup/runtime-deps/collect.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/setup/runtime-deps/collect.ts test/setup/runtime-deps/collect.test.ts
git commit -m "feat(setup): collect + render per-language manifest dependency lists"
```

---

### Task 6: Wire the dependency list into the enrichment prompt

**Files:**
- Modify: `src/setup/enrich.ts:24-43` (the `enrichVars` function) and `src/setup/enrich.ts:56` (the `renderPrompt` call)
- Modify: `prompts/setup-enrich.md` (add a section after the scan-results list)
- Test: `test/setup/enrich.test.ts`

**Interfaces:**
- Consumes: `collectManifestDeps`, `renderManifestDeps` from `./runtime-deps/collect.ts`.
- Produces: a new prompt variable `scan_manifest_deps` consumed by `prompts/setup-enrich.md`.

- [ ] **Step 1: Write the failing test**

Append to `test/setup/enrich.test.ts` (the fixture helper mirrors the other setup tests):

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("enrich injects manifest dependency names into the prompt", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-enrich-deps-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ dependencies: { "drizzle-orm": "^0.30" } }),
  );
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(FULL))));
  await enrichRuntimeContext(repo, scan({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  expect(runner.inputs[0]?.prompt).toContain("drizzle-orm");
});

test("enrich still renders when the repo has no manifests", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-enrich-empty-"));
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(FULL))));
  const out = await enrichRuntimeContext(repo, scan({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  expect(out.topology.detail).toBe("a cli");
  expect(runner.inputs[0]?.prompt).toContain("(no dependency manifests detected)");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/setup/enrich.test.ts`
Expected: FAIL — the prompt has no `{{scan_manifest_deps}}` var, so either the assertion fails or `renderPrompt` reports an unresolved var. (If `renderPrompt` throws on an *unknown* var passed in, that's fine — we add the template token in Step 4.)

- [ ] **Step 3: Edit `src/setup/enrich.ts`**

Add the import near the other `./` imports (after line 10):

```ts
import { collectManifestDeps, renderManifestDeps } from "./runtime-deps/collect.ts";
```

Change `enrichVars` to accept the rendered list and add one key. Replace the signature line and add the key inside the returned object:

```ts
function enrichVars(scan: RuntimeContext, manifestDeps: string): Record<string, string> {
  return {
    scan_topology: scan.topology.type,
    scan_topology_detail: scan.topology.detail,
    scan_data: scan.data.presence,
    scan_data_detail: scan.data.detail,
    scan_data_migration_tool: scan.data.migrationTool ?? "",
    scan_caching: scan.caching.presence,
    scan_caching_detail: scan.caching.detail,
    scan_observability: scan.observability.presence,
    scan_observability_detail: scan.observability.detail,
    scan_config_secrets: scan.configSecrets.presence,
    scan_config_secrets_detail: scan.configSecrets.detail,
    scan_documentation: scan.documentation.presence,
    scan_documentation_detail: scan.documentation.detail,
    scan_release: scan.releasePackaging.mechanism,
    scan_release_detail: scan.releasePackaging.detail,
    scan_manifest_deps: manifestDeps,
  };
}
```

Update the call site (was line 56) to compute and pass the list:

```ts
  const manifestDeps = renderManifestDeps(collectManifestDeps(repoDir));
  const prompt = renderPrompt(setupEnrichTemplate, enrichVars(scan, manifestDeps));
```

- [ ] **Step 4: Edit `prompts/setup-enrich.md`**

Insert this block immediately after the scan-results list (after the `- Release/packaging:` line, before the "For EACH section" paragraph):

```markdown

Dependencies found in the repo's manifests (parsers cover common forms only — this list may be incomplete):

{{scan_manifest_deps}}

Treat this as positive evidence only: a capability's libraries appearing above supports marking that section `present` with grounded `detail`. Their ABSENCE from this list is NOT evidence a capability is missing — investigate the repo as usual, and if you still cannot tell, leave `presence` `unknown` (never guess `absent` from this list alone).
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test test/setup/enrich.test.ts`
Expected: PASS (all prior tests + 2 new). The prior tests pass repoDir `/tmp/repo`; `collectManifestDeps` is fail-soft, so they render the placeholder and behave unchanged.

- [ ] **Step 6: Full suite + lint**

Run: `bun test && bun run lint`
Expected: entire suite green; no lint errors. (Confirms no regression in `probe`, `merge`, `extract-schema`, or other enrich consumers.)

- [ ] **Step 7: Commit**

```bash
git add src/setup/enrich.ts prompts/setup-enrich.md test/setup/enrich.test.ts
git commit -m "feat(setup): feed manifest dependency lists into enrichment prompt"
```

---

## Known Limitations (accepted — the enrichment LLM backstops these)

These manifest forms are not parsed; the names are recovered by the LLM reading the repo (the design's explicit fallback). Documented so they aren't mistaken for bugs during review:

- **Split requirements** — `collect.ts` globs the exact basename `requirements.txt`; a `requirements/base.txt` / `requirements-dev.txt` layout (top-level file just does `-r requirements/base.txt`) yields a near-empty Python list. The `-r` include target is deliberately not followed.
- **pyproject dynamic / non-core groups** — `[project] dynamic = ["dependencies"]` (deps in a referenced file), PDM/hatch env tables, and PEP 735 `[dependency-groups]` are not read. Runtime `[project].dependencies`, optional-deps, and all Poetry forms (incl. group tables) are.
- **Gradle map-notation** — `implementation group: 'g', name: 'a'` (legacy) is not matched; string-coordinate and version-catalog forms are.
- **Gemfile `gemspec` directive** — deps declared in a sibling `.gemspec` (rather than as `gem` lines) are not read.
- **package.json `peer`/`optionalDependencies`** — excluded; only `dependencies` + `devDependencies` are read.

None of these emit junk identifiers — they under-report, which is the safe direction for LLM context.

## Self-Review

**1. Spec coverage** (against `docs/brainstorms/2026-07-15-polyglot-runtime-scan-design.md` v2):
- Names-only parsers per manifest, Bun.TOML for TOML → Tasks 1–4. ✓
- `collectManifestDeps` orchestrator, dedupe, cap, fail-soft → Task 5. ✓
- `enrichVars` + `{{scan_manifest_deps}}` + never-assert-absent framing → Task 6. ✓
- No change to `detect-runtime.ts` / schema / gate / merge → enforced by Global Constraints; only `enrich.ts` + prompt touched. ✓
- No `releasePackaging` inference, no curated dimension tables → absent by construction. ✓
- Prompt-bloat mitigation (`CAP_PER_LANG`) → Task 5. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code and test step carries full source. ✓

**3. Type consistency:** Parser signatures `(content: string) => string[]` are identical across Tasks 1–5; `collect.ts` imports exactly the ten exported names; `enrichVars(scan, manifestDeps)` matches its single call site; `scan_manifest_deps` token matches between `enrich.ts` and `prompts/setup-enrich.md`. ✓
